# The wasm runtime omits 6 `__yo_statx_*` accessors that `std/sys/externs.yo` declares and exports — any Yo caller fails the C compile on wasm only

**Found**: 2026-09-04, during the std-API audit re-measurement of the fs row
(the "Metadata: real `btime`" item — its first std consumer would trip this).
**Status**: OPEN. **Severity**: api-lie — `std` promises symbols that do not
exist on the two wasm targets (`wasm32-wasip1` and `wasm32-unknown-emscripten`,
`src/target.yo:67`).

## Symptom

`std/sys/externs.yo` declares 19 `__yo_statx_*` functions (`:89-107`) and
exports all 19 (`:298-316`). Three of the four runtimes define all 19; wasm
defines 13. Calling one of the missing six from Yo compiles fine on
linux/macos/windows and emits C that will not compile on wasm:

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ GlobalAllocator } :: import("std/allocator");
{ malloc, free } :: GlobalAllocator;
{ __yo_statx_btime_sec, __yo_statx_blocks, __yo_statx_buf_size } :: import("std/sys/externs");

main :: (fn() -> unit)({
  buf := *(u8)(malloc(__yo_statx_buf_size()).unwrap());
  println(`${__yo_statx_btime_sec(buf)} ${__yo_statx_blocks(buf)}`);
  free(.Some(*(void)(buf)));
});
export(main);
```

Observed (yo v0.2.24, `YO_STD=./std`):

```
$ yo compile probe.yo --target aarch64-apple-darwin --emit-c --skip-c-compiler
  → emitted C defines and calls both accessors. Compiles.

$ yo compile probe.yo --target wasm32-wasip1 --emit-c --skip-c-compiler
  → succeeds, and the emitted C CALLS both accessors without defining them:

$ clang -fsyntax-only -std=c11 wb_wasm32-wasip1.out.c
wb_wasm32-wasip1.out.c:1322:30: error: call to undeclared function '__yo_statx_btime_sec';
  ISO C99 and later do not support implicit function declarations
  [-Wimplicit-function-declaration]
 1322 |   int64_t __yo_ref_spill_0 = __yo_statx_btime_sec(buf);
wb_wasm32-wasip1.out.c:1327:31: error: call to undeclared function '__yo_statx_blocks';
  ISO C99 and later do not support implicit function declarations
  [-Wimplicit-function-declaration]
 1327 |   uint64_t __yo_ref_spill_2 = __yo_statx_blocks(buf);
```

Expected: either the wasm runtime defines all 19, or `std/sys/externs.yo` does
not declare and export what wasm cannot provide. Today the Yo-side declaration
is accepted on every target and the failure surfaces only as a C error from the
wasm legs — a build that takes ~52 minutes to tell you.

## The set difference

```
$ for f in linux macos windows wasm; do
    grep -o '__yo_statx_[a-z_]*' src/codegen/async/runtime_io_$f.yo | sort -u | wc -l
  done
19
19
19
13
```

Missing from `src/codegen/async/runtime_io_wasm.yo:217-230`:

| symbol | declared at | provided by linux/macos/windows |
| --- | --- | --- |
| `__yo_statx_btime_sec` | `std/sys/externs.yo:98` | `runtime_io_linux.yo:463`, `runtime_io_macos.yo:533`, `runtime_io_windows.yo:1258` |
| `__yo_statx_btime_nsec` | `:99` | same trio |
| `__yo_statx_dev_major` | `:104` | `runtime_io_linux.yo:483` + siblings |
| `__yo_statx_dev_minor` | `:105` | `runtime_io_linux.yo:487` + siblings |
| `__yo_statx_blksize` | `:106` | `runtime_io_linux.yo:495` + siblings |
| `__yo_statx_blocks` | `:107` | `runtime_io_linux.yo:499` + siblings |

## Root cause

Two independent gaps that only bite together.

1. **The wasm block was written against Emscripten's `struct stat`, and stopped
   at the fields that map one-to-one.** `runtime_io_wasm.yo:217-230` comments
   itself "Statx field extractors (use struct stat on Emscripten)" and provides
   the 13 fields `struct stat` names identically. `st_birthtim` does not exist
   there, and `st_dev`/`st_blksize`/`st_blocks` were simply not carried over
   even though they do.

2. **Nothing checks that the four runtimes agree with the declaration list.**
   `extern("Yo", …)` is a promise the codegen fulfils per target, and no gate
   compares the declared set against what each `runtime_io_*.yo` emits. The
   emitted call is a bare C call with no prototype (the emitter relies on the
   preamble's `static` definitions preceding it), so a missing definition is not
   a Yo-level error at all — it is an implicit-declaration error from the C
   compiler, on one leg, late.

Four of the six are additionally **exported-but-unreachable surface**:
`dev_major`, `dev_minor`, `blksize` and `blocks` have no `Statx` accessor on ANY
platform — `std/sys/statx.yo:15-68` stops at `ctime_nsec` (`:65-67`) — so
nothing in the tree can call them today. That is why the gap has never fired.

## Fix

Add the six missing definitions to `src/codegen/async/runtime_io_wasm.yo` beside
the existing block at `:217-230`:

- `__yo_statx_dev_major` / `__yo_statx_dev_minor` — derive from
  `((struct stat*)buf)->st_dev` the same way the POSIX runtimes do
  (`major()`/`minor()`, or the shift/mask fallback the linux block uses).
- `__yo_statx_blksize` / `__yo_statx_blocks` — `st_blksize` / `st_blocks`, both
  present in Emscripten's `struct stat`.
- `__yo_statx_btime_sec` / `__yo_statx_btime_nsec` — `return 0;`. Emscripten has
  no birth time, and 0 is the same "unavailable" sentinel Linux produces when
  the kernel clears `STATX_BTIME` from the returned mask and macOS produces on a
  filesystem without birthtime. Any `Metadata.created_time()` built on these
  must therefore be `Option(i64)` with `0 ⇒ .None`, not a bare `i64`.

Then close gap 2 so this cannot recur: add a check that the set of
`__yo_*` symbols named in `std/sys/externs.yo`'s `extern("Yo", …)` block is a
subset of what each `runtime_io_*.yo` defines. A grep-level CI step over the
four files is enough and costs seconds, versus a 52-minute wasm leg.

**Note on the seed.** Adding definitions to `runtime_io_wasm.yo` is NOT
seed-gated the way a new extern called from `std/fs` would be: the wasm test leg
runs stage-1, and stage-1 carries the tree's `runtime_io_wasm.yo`, so new stubs
are visible to that leg in the same PR. But because this touches
`src/codegen/async/`, the change needs `yo compile src/main.yo
--skip-c-compiler` and the stage-2 self-compile before pushing (`check` is
evaluator-only and passes over codegen).

## Regression test

The natural regression test is the CI set-difference check described above —
this is a symbol-inventory defect, and a Yo test can only cover it by calling
each accessor on each target.

Alongside it, once `std/sys/statx.yo` gains accessors for these fields (the
btime work needs `btime_sec()`/`btime_nsec()` anyway),
`tests/fs/metadata.test.yo` should exercise them so the wasm leg actually
compiles a caller — today it asserts only size/is_file/is_dir/is_symlink/ino/
nlink/modified_time (`:17-48`), which is why 13 of 19 accessors have never been
called from a test.

## Breaking change

No. Pure addition of missing definitions.
