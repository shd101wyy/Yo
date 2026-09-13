# The macOS getdents emulation's per-fd DIR* registry is process-global, not thread-local

Found during the async I/O runtime audit on macOS (2026-09-13).

## Symptom

`__yo_getdents_streams` — the linked list that maps an fd to the persistent
`DIR*` the macOS `getdents` emulation keeps across calls (so `readdir`'s
read-ahead does not skip entries) — is declared plain `static` in the runtime
emitted by src/codegen/async/runtime_io_common.yo:

```c
static __yo_getdents_stream_t* __yo_getdents_streams = NULL;
```

## Why that is a bug

The async threading model (AGENTS.md, "Async/await threading model";
c-codegen.instructions.md, "Implications for runtime code") is one event loop
per OS thread, and the rule it imposes is: *all per-thread event loop state
must be declared `_Thread_local` — including linked lists like
`__yo_active_fs_events` and `__yo_active_polls`*. Those two neighbors ARE
`_Thread_local`; the getdents list is not.

Two threads each running their own event loop (e.g. `Thread.spawn`ed workers
calling `std/fs.read_dir` / `dir.read_dir`, which route through
`__yo_async_getdents_start`) mutate the same list head without
synchronization — a data race on the insertion itself, and worse, a `DIR*`
created on thread A is reachable from thread B's lookup, so a buffered
`DIR` stream could be advanced from two threads concurrently (`readdir` is
not thread-safe on one `DIR*`).

Not deterministic to reproduce as a test (it is a race), but it is a static
violation of the documented model, and the fix is the same one word the
neighboring lists already use.

## Fix

```c
static _Thread_local __yo_getdents_stream_t* __yo_getdents_streams = NULL;
```

(The block is emitted only for the macOS target, where `_Thread_local` is
available.)

Note: the Windows runtime has the same-class issue —
`__yo_dir_state_head` (the FindFirstFile emulation's per-fd state,
src/codegen/async/runtime_io_windows.yo) is also plain `static`. Out of scope
for the macOS audit; fix alongside any Windows-side work with the zig
cross-compile gate.

## Verification

`yo check ./src` plus the directory-reading tests
(`yo test ./tests/sys/dir.test.yo --bail -v --parallel 1`); behavior on one
thread is unchanged (the qualifier only moves the storage).
