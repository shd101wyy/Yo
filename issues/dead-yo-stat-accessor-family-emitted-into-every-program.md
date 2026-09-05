# The `__yo_stat_*` accessor family is dead C — nothing in Yo can call it, yet it is emitted into every program

**Found**: 2026-09-04, during the std-API audit re-measurement of the fs row,
while looking for the binding an fd-based `File.metadata` would use.
**Status**: OPEN. **Severity**: papercut — no wrong values, but it is a trap
laid directly in the path of the next person doing the fd-stat work.

## Symptom

`src/codegen/async/runtime_io_common.yo:66-110` emits eleven `struct stat`
accessors into the C preamble of every compiled Yo program:

```
__yo_stat_buf_size   __yo_stat_size    __yo_stat_mode
__yo_stat_mtime      __yo_stat_atime   __yo_stat_ctime
__yo_stat_uid        __yo_stat_gid     __yo_stat_ino
__yo_stat_dev        __yo_stat_nlink
```

No Yo code anywhere declares them:

```
$ grep -rn "__yo_stat_[a-z]" --include='*.yo' . | grep -v __yo_statx | grep -v runtime_io_common
(no output)
```

They are not in `std/sys/externs.yo`'s `extern("Yo", …)` block, which declares
the 19 `__yo_statx_*` accessors (`:89-107`) and nothing from this family. So no
Yo program can reference them, in any target, ever. Confirmed in the emitted C
of a trivial program:

```
$ yo compile probe.yo --target aarch64-apple-darwin --emit-c --skip-c-compiler
$ clang -fsyntax-only -std=c11 -Wall probe.out.c 2>&1 | grep "__yo_stat_"
probe.out.c:555:15: warning: unused function '__yo_stat_buf_size' [-Wunused-function]
probe.out.c:560:16: warning: unused function '__yo_stat_size' [-Wunused-function]
probe.out.c:564:17: warning: unused function '__yo_stat_mode' [-Wunused-function]
probe.out.c:568:16: warning: unused function '__yo_stat_mtime' [-Wunused-function]
probe.out.c:572:16: warning: unused function '__yo_stat_atime' [-Wunused-function]
probe.out.c:576:16: warning: unused function '__yo_stat_ctime' [-Wunused-function]
probe.out.c:580:17: warning: unused function '__yo_stat_uid' [-Wunused-function]
probe.out.c:584:17: warning: unused function '__yo_stat_gid' [-Wunused-function]
probe.out.c:588:17: warning: unused function '__yo_stat_ino' [-Wunused-function]
probe.out.c:592:17: warning: unused function '__yo_stat_dev' [-Wunused-function]
probe.out.c:596:17: warning: unused function '__yo_stat_nlink' [-Wunused-function]
```

## Why it matters more than "an unused static"

That same `-Wall` run reports 180 unused-function warnings, all of them
`__yo_*` runtime helpers, so a reader could dismiss this as the normal cost of a
one-size preamble. It is not the same thing. The other 179 are *reachable* — a
program that uses atomics or mutexes calls them, and they are unused only in
this particular program. The `__yo_stat_*` eleven are **unreachable from any Yo
program whatsoever**, because the declaration side does not exist. That is a
different category: not "unused here" but "cannot be used".

The concrete cost is a trap rather than a byte count (the C compiler drops
unused statics). The fs row's open work includes replacing `File.metadata`'s
by-path re-stat with an fd-based one — see
`file-from-fd-metadata-stats-the-current-directory.md` — and the person doing
that will grep the runtime for a stat binding, find eleven functions named
exactly right, and reasonably assume they are the interface. They are not: the
live interface is the `__yo_statx_*` family, which is `statx`-buffer-shaped on
Linux and `struct stat`-shaped elsewhere, declared in `std/sys/externs.yo` and
consumed through `std/sys/statx.yo`.

## Root cause

Vestigial. The family predates the `statx` accessors: `git log -S
"__yo_stat_buf_size"` traces it to `009971cdf` ("feat: Start implementing
std/fs") and `f1bd58377` (#17, "Implement std/io library file and directory
modules") in the retired TypeScript compiler, and it was carried across
verbatim by the `yo-self` port (`486ef696b`, "Phase 5 #4: port
generate_async_runtime_io_common") and then by the `yo-self/` → `src/` rename
(`8546ec744`). When `std/fs` moved to the `statx` shape the old family was
simply never removed, and because it is `static` and unreferenced nothing ever
complained.

## Fix

Delete the eleven functions from `src/codegen/async/runtime_io_common.yo:66-110`
(the block from the `// Get size of stat buffer (for allocation)` comment at
`:66` through the closing brace of `__yo_stat_nlink` at `:110`), leaving the
`__yo_dirent_name` / `__yo_dirent_type` pair that immediately follows at
`:112-119` — those ARE live: `std/sys/externs.yo:31-35` declares the five
`__yo_dirent_*` functions and `std/sys/dir.yo:105-122` wraps them, which is how
`read_dir` reads an entry.

Do not "revive" them by adding `extern("Yo", …)` declarations instead. The
`__yo_statx_*` family is the one `std/sys/statx.yo` is built on, it is
implemented in all four runtimes, and having two overlapping stat bindings is
what created this confusion.

Verify with a before/after emit diff: `yo compile <probe> --emit-c
--skip-c-compiler` for each of the four targets, and confirm the only
difference is the removal of those eleven definitions.

## Regression test

None is meaningful — the defect is the presence of dead text, and a test cannot
assert its absence usefully. The check that WOULD have caught it, and would
catch the next one, is the runtime/extern set-difference gate proposed in
`wasm-runtime-missing-six-statx-accessors-that-std-declares.md`, run in the
other direction: every `__yo_*` function DEFINED in a `runtime_io_*.yo` should
be declared by some `extern("Yo", …)` block, or explicitly listed as an
internal runtime helper. Running it today reports these eleven.

## Breaking change

No. Nothing can reference them.
