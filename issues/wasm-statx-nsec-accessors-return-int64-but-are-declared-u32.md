# wasm's `__yo_statx_*time_nsec` are defined `int64_t` while `std/sys/externs.yo` declares them `u32`

**Found**: 2026-09-04, during the std-API audit re-measurement of the fs row,
while inventorying `src/codegen/async/runtime_io_wasm.yo`'s statx block.
**Status**: OPEN. **Severity**: papercut — it narrows silently today, but it is
a declared-vs-defined mismatch on one target family, and it makes the wasm
accessors wrong by construction the moment anyone widens the Yo declaration.

## Symptom

`std/sys/externs.yo` declares the three nanosecond accessors as returning `u32`
(`:93`, `:95`, `:97`):

```rust
__yo_statx_mtime_nsec : (fn(statxbuf : *u8) -> u32),
__yo_statx_atime_nsec : (fn(statxbuf : *u8) -> u32),
__yo_statx_ctime_nsec : (fn(statxbuf : *u8) -> u32),
```

linux, macos and windows all define them `uint32_t`
(`src/codegen/async/runtime_io_linux.yo:443`, `:451`, `:459` and the same
offsets in the other two). wasm defines them `int64_t`
(`src/codegen/async/runtime_io_wasm.yo:222`, `:224`, `:226`):

```c
static int64_t __yo_statx_mtime_nsec(void* buf) { return (int64_t)((struct stat*)buf)->st_mtim.tv_nsec; }
static int64_t __yo_statx_atime_nsec(void* buf) { return (int64_t)((struct stat*)buf)->st_atim.tv_nsec; }
static int64_t __yo_statx_ctime_nsec(void* buf) { return (int64_t)((struct stat*)buf)->st_ctim.tv_nsec; }
```

A Yo caller therefore emits a narrowing assignment on wasm and a plain
assignment everywhere else:

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ GlobalAllocator } :: import("std/allocator");
{ malloc, free } :: GlobalAllocator;
{ __yo_statx_mtime_nsec, __yo_statx_buf_size } :: import("std/sys/externs");

main :: (fn() -> unit)({
  buf := *(u8)(malloc(__yo_statx_buf_size()).unwrap());
  (n : u32) = __yo_statx_mtime_nsec(buf);
  println(`${n}`);
  free(.Some(*(void)(buf)));
});
export(main);
```

Observed (yo v0.2.24, `YO_STD=./std`, `--emit-c --skip-c-compiler`):

```
--target wasm32-wasip1     → line 1094: static int64_t  __yo_statx_mtime_nsec(void* buf) …
                             line 1316: uint32_t n = __yo_statx_mtime_nsec(buf);

$ clang -fsyntax-only -std=c11 -Wconversion wn.out.c
wn.out.c:1316:16: warning: implicit conversion loses integer precision:
  'int64_t' (aka 'long long') to 'uint32_t' (aka 'unsigned int') [-Wshorten-64-to-32]
 1316 |   uint32_t n = __yo_statx_mtime_nsec(buf);

--target aarch64-apple-darwin → line 1399: static uint32_t __yo_statx_mtime_nsec(void* statxbuf) …
                                line 1595: uint32_t n = __yo_statx_mtime_nsec(buf);
                                (no conversion, no warning)
```

Expected: the wasm definitions return `uint32_t`, matching the declaration and
the other three runtimes.

## Root cause

`src/codegen/async/runtime_io_wasm.yo:217-230` was written as one block —
"Statx field extractors (use struct stat on Emscripten)" — with `int64_t` used
uniformly for everything time-shaped, including the `*_nsec` fields where the
declared Yo type is `u32`. The other three runtimes distinguish the two:
`*_sec` is `int64_t`, `*_nsec` is `uint32_t`.

Nothing catches it because the emitter does not emit a prototype for an
`extern("Yo", …)` function — it relies on the preamble's `static` definitions
appearing before the call — so the C compiler sees only the definition, and the
call site's mismatch degrades to an ordinary implicit conversion rather than a
conflicting-declaration error.

The narrowing is harmless in practice (`tv_nsec` is < 10^9 and fits `uint32_t`),
which is exactly why it should be fixed now rather than after it stops being
harmless: the tree already builds with `-Werror=return-type`, and any move
toward a stricter warning set — or any widening of the Yo-side declaration to
`u64` — turns this into a wasm-only build break or a wasm-only truncation.

## Fix

In `src/codegen/async/runtime_io_wasm.yo:222`, `:224`, `:226`, change the return
type of `__yo_statx_mtime_nsec`, `__yo_statx_atime_nsec` and
`__yo_statx_ctime_nsec` from `int64_t` to `uint32_t` and cast accordingly:

```c
static uint32_t __yo_statx_mtime_nsec(void* buf) { return (uint32_t)((struct stat*)buf)->st_mtim.tv_nsec; }
```

Leave the `*_sec` accessors as `int64_t` — those match `std/sys/externs.yo:92`,
`:94`, `:96` (`-> i64`) already.

This is naturally done in the same PR as
`wasm-runtime-missing-six-statx-accessors-that-std-declares.md`, which touches
the block immediately below. The set-difference CI check proposed there should
be extended to compare return TYPES too, not only symbol names — the same grep
can read both.

## Regression test

Not unit-testable from Yo (the value is identical either way). Cover it with the
runtime-inventory CI check described in the sibling issue: for each of the 19
declared `__yo_statx_*` symbols, assert that every `runtime_io_*.yo` defines it
with the C type corresponding to the declared Yo return type.

## Breaking change

No. The observable value is unchanged on every target.
