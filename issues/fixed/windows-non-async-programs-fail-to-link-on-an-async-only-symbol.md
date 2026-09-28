# Windows: every non-async program fails to link (`__yo_win_unassociate_handle` undefined)

**Status: FIXED (2026-09-28).** Found from CI on PR #982: `test (windows-latest)`
and all four `test (windows-11-arm)` shards, and develop's own battery since
#974 (run 36403555056 onward).

## Symptom

```
lld-link: error: undefined symbol: __yo_win_unassociate_handle
yo: error: compile: C compiler failed (exit 1) on yo-out/aarch64-pc-windows-msvc/bin/hello-world_chunk000.c
```

Any Windows program that uses no async code, starting with hello-world.

## Root cause

#974 added a per-thread IOCP-association cache, and made `__yo_file_close` evict
a closing fd from it by calling `__yo_win_unassociate_handle` directly.
`__yo_file_close` lives in the sys runtime, which is emitted for every program.
The cache and `__yo_win_unassociate_handle` live in the async runtime section,
which a program without async code does not get. The forward declaration
compiled; the link did not.

## Fix

`__yo_file_close` calls through `__yo_win_close_hook`, a per-thread function
pointer that `__yo_io_init` installs and `__yo_io_cleanup` clears. This is the
Linux runtime's `__yo_io_close_hook` arrangement. A thread that never
initialized async I/O has no cache, so its NULL hook is correct.

## Test

`tests/internal/uring_runtime.test.yo`, "windows sys runtime: the close path
reaches the async section only through its hook": pins that the sys section
makes no direct call. It fails on the #974 text.
