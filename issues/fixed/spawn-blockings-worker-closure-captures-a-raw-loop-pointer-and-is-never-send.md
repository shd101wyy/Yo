# `spawn_blocking`'s worker closure captures a raw loop pointer and is never `Send`

**Severity:** S1 — every `spawn_blocking` program failed to compile on the branch ("Captured
variable 'owner' (type *(u8)) does not implement Send"), including all five tests of
`tests/spawn_blocking.test.yo`

**Status:** FIXED 2026-10-06 (feat/vbd-send-sync). The loop pointer travels inside
`_BlockingOwner`, a value struct that opts into `Send` under `std/thread.yo`'s
`pragma(Pragma.AllowUnsafe)`, the same SAFETY shape as `Waker`'s opt-in.

## Symptom

Any `spawn_blocking(...)` call, including the branch's own suite:

```
$ yo test ./tests/spawn_blocking.test.yo --parallel 1
error: Captured variable 'owner' (type *(u8)) does not implement Send. To move it across
threads, wrap it in Arc/Iso, or capture a Send projection of it instead.
   --> std/thread.yo: __yo_async_blocking_end(owner);
```

## Root cause

The `Send`/`Sync` split made raw pointers neither `Send` nor `Sync` (decision 38 E), with the
derivation checking every capture of a closure crossing a `Send` boundary.
`spawn_blocking`'s worker closure captures `owner := unsafe(__yo_async_loop_self_ptr())` — the
AWAITING loop's raw pointer — to hand it to `__yo_async_blocking_end` on the worker thread, so
the worker closure failed the `Impl(Fn(…), Send)` bound of `Thread.spawn` for every program.
The branch's std opt-ins (`Channel`, `Mutex`, `Waker`, …) covered their own raw pointers but
missed this bare local.

The pointer's use is sound under the documented model: `__yo_async_blocking_end` only posts to
the loop's inbox — the same cross-thread wake a `Waker` performs (rule D7) — so moving it to
the worker thread is exactly as safe as the `Waker` capture beside it, which the branch
already opted in.

## Fix

`std/thread.yo`: `_BlockingOwner :: struct(owner : *u8)` with `impl(_BlockingOwner, Send())`
under the file's pragma (a manual impl requires it), and a SAFETY comment naming the rule D7
reasoning. `spawn_blocking` captures `owner := _BlockingOwner(owner : unsafe(...))` and the
worker passes `owner.owner` to `__yo_async_blocking_end`.

## Verification

- `tests/spawn_blocking.test.yo` (all five tests) failed to compile before the wrapper and
  passes after.
- A `spawn_blocking` over a MOVE-ONLY closure (the full relay chain
  `spawn_blocking` → `Thread.spawn` → extern) returns the worker's value and disposes the
  captured `Dispose` value exactly once (`tmp/ctl_blocking.yo`, run as a main during the
  branch work).
