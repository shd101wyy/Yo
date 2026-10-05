# The wasm timer list keeps a bare pointer to a dropped sleep future

**Severity:** S1 — on wasm32-unknown-emscripten a sleep future dropped before it fires is freed while the timer list still points at it; the timer then writes the freed (and reused) allocation, and since the thread-exit release drains the ready queue the program crashes at exit.

**Status: FIXED (2026-10-05).** Found by the first CI battery on PR #1200's
merged tree (run 37292720878, `test-wasm32_emscripten`).

## Symptom

`tests/sys/timer.test.yo` "a sleep future dropped before it fires does not
fire into freed memory" failed on the emscripten leg:

```
✗ a sleep future dropped before it fires does not fire into freed memory
  Test failed with exit code 256
  RuntimeError: table index is out of bounds
```

The same shape as a standalone program (bind `sleep(u64(5))`, read
`io.state`, drop it at scope end; 50 times; then await a 30 ms sleep)
reproduced it under node with `--c-compiler emcc --debug-symbols`. The trap is
an indirect call inside `__yo_async_thread_exit_release`.

## Root cause

`issues/fixed/pending-io-future-local-drop-uaf.md` gave every native backend
(Linux ring/epoll/timer heap, the macOS timer heap and parked ops, the Windows
timer list, overlappeds and pipe reads) its own reference to a pending future.
The wasm backend (`src/codegen/async/runtime_io_wasm.yo`) was not in that
fix: `__yo_wasm_timer_add` stored `node->future` as a bare pointer. When the
local was dropped, rc went 1 → 0 and the future was freed while its node stayed
armed.

Instrumenting the emitted C showed all 50 dropped timers firing into ONE
address (`fire fut=0x11778` ×50), the allocation each new sleep reused. Each
fire wrote `result` and ran `__yo_io_wake_continuation` on whatever lived
there. At exit, the ready queue held a continuation node inside that freed
block (`cont=0x11788 fn=0x11604 sm=0x4`). Before the thread-exit release
(`issues/fixed/tasks-still-pending-or-queued-at-thread-exit-are-never-released.md`)
nothing drained the queue at exit, so the corruption stayed silent and the test
passed by luck. The drain calls `resume_fn`, so it now traps.

## Fix

The wasm timer list holds a reference, as Windows' does: `future->header.ref_count++`
on insert, released when the timer fires (after the wake), when it is
cancelled (`__yo_wasm_timer_cancel`, the `cancel_fn`), and in
`__yo_io_cleanup` (which also clears `cancel_fn` and marks the future
terminal, mirroring `runtime_io_windows.yo`). The local's drop now leaves rc 1,
and the future is freed after its timer fires.

Test: the existing `tests/sys/timer.test.yo` case. It is red on the emscripten
leg without the fix (on this tree) and green with it. Its standalone shape ran
`dropped 50`, `slept`, rc 0 under node with the fixed runtime spliced into the
emitted C.
