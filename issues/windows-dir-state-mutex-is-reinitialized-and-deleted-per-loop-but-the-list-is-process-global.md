# The Windows dir-state mutex is re-initialized and deleted per loop, but the list it guards is process-global

**Severity:** S1 — per-loop init/delete of the lock guarding a process-global dir-state list — use-after-free, crashes, or silent list corruption under concurrent loops

Status: OPEN (found by the 2026-09-28 Windows async-I/O audit; pre-existing
since the dir-state registry landed).

## The defect

`runtime_io_windows.yo` keeps the per-fd `FindFirstFileW` iteration state in a
**process-global** list:

```c
static __yo_win_dir_state_t* __yo_dir_state_head = NULL;      // global
static CRITICAL_SECTION __yo_dir_state_mutex;                 // guards it
```

but the mutex's lifetime is managed by the **per-thread** I/O runtime:

- `__yo_io_init` (guarded by thread-local `__yo_io_initialized`) calls
  `InitializeCriticalSection(&__yo_dir_state_mutex)` on EVERY thread's first
  loop start;
- `__yo_io_cleanup` calls `DeleteCriticalSection(&__yo_dir_state_mutex)` when
  ANY thread's loop tears down.

Two threads that both run event loops (a `Thread.spawn` body with `io.async`,
a `ThreadPool` worker) hit both directions while both are alive:

1. **Re-init while in use** — thread B's `InitializeCriticalSection` resets the
   lock's internals while thread A may hold it inside `__yo_win_get_dir_state`
   / `__yo_win_cleanup_dir_state` (both called on every `getdents`/`close`).
2. **Delete while in use** — thread A finishing its loop deletes the CS while
   thread B still enters it: a deleted `CRITICAL_SECTION` is freed state, so
   `EnterCriticalSection` is a use-after-free. The `__yo_dir_state_head` list
   itself then outlives the mutex that guards it.

The socket-fd registry had exactly this shape and was fixed with a statically
initialized `SRWLOCK`
(`issues/fixed/windows-socket-fd-registry-is-an-unlocked-process-global-list.md`)
— the dir-state mutex predates that lesson and never got the same treatment.

## Reachability

Two threads doing directory iteration concurrently (`fs.read_dir` /
`getdents`) or one thread iterating while another's loop tears down. Each
`getdents` call takes the mutex twice (get-state + eventual cleanup on close).

## Reproducer sketch

`tmp/fixme.yo`: spawn 3 threads that each loop { open a directory fd,
read it in chunks, close it } × ~200 rounds while the main thread does the
same. Under the seed binary this is undefined behavior — it may crash, may
silently corrupt the list (a freed `find_handle` reused by another fd's
cleanup → `FindClose` on the wrong handle).

## Fix

Same as the socket registry: a process-global `static SRWLOCK ... =
SRWLOCK_INIT;` (static initializer — no init race, nothing to delete) with
acquire/release in place of enter/leave, and drop the
`InitializeCriticalSection`/`DeleteCriticalSection` calls from
`__yo_io_init`/`__yo_io_cleanup`.
