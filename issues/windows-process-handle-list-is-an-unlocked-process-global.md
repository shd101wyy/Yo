# The Windows process-handle list is an unlocked process-global

**Severity:** S1 — the pid→HANDLE list is a completely unlocked process-global — UAF reads, lost updates, leaked handles, waitpid answering -ESRCH for a live child

Status: OPEN (found by the 2026-09-28 Windows async-I/O audit).

## The defect

`runtime_io_windows.yo` maps pid → `HANDLE` for `waitpid` in a process-global
singly-linked list with NO lock at all:

```c
static __yo_process_handle_entry* __yo_process_handles = NULL;

static void   __yo_process_add_handle(...)    // push, no lock
static HANDLE __yo_process_get_handle(...)    // walk, no lock
static void   __yo_process_remove_handle(...) // unlink + CloseHandle + free, no lock
```

`add` runs at every `spawn`, `get`/`remove` at every `waitpid`. Two threads
that each spawn and wait commands (a `ThreadPool` worker driving
`Command.output`, two `Thread.spawn` bodies) race all three:

- two pushes → lost head update → a leaked `HANDLE` and a `waitpid` that
  answers `-ESRCH` for a live child;
- push racing remove's unlink → the pushed node lands on a detached fragment,
  or the walker dereferences a freed node (use-after-free);
- `remove`'s `__yo_free(cur)` racing a concurrent `get`'s walk → UAF read.

The socket-fd registry fixed the identical shape with a process-global
SRWLOCK and freeing the node outside the lock
(`issues/fixed/windows-socket-fd-registry-is-an-unlocked-process-global-list.md`);
the process list simply never got the pass.

## Reproducer sketch

`tmp/fixme.yo`: 2–4 threads, each looping `Command.run("cmd", ["/c", "exit",
"0"])` (or any spawn + waitpid) ~100 rounds. Undefined behavior — manifesting
as a crash, a leaked handle, or `-ESRCH` from waitpid for a just-spawned pid.

## Fix

`static SRWLOCK __yo_process_handles_lock = SRWLOCK_INIT;` — shared lock for
`get`, exclusive for add/remove, node freed outside the lock (mirroring
`__yo_win_fd_unmark_socket`).
