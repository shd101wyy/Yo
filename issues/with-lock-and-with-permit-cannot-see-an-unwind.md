# `Mutex.with_lock`'s "unlocks on unwind" claim is unreachable through its own signature

**Status:** OPEN — doc/API accuracy, not a defect
**Found:** 2026-09-08, trying to write the unwind test for the new
`Semaphore.with_permit`.

## The claim

`std/sync/mutex.yo` says, of the `__MutexUnlocker` guard:

> Allocated locally inside with_lock; Yo's drop-on-scope-exit and
> drop-on-unwind machinery guarantees unlock under both normal return
> and `unwind(...)`.

The machinery does do that. The signature, however, makes the `unwind(...)`
half unreachable.

## Why

`with_lock`'s body is an `Impl(Fn(inout(v) : T) -> R)` — a CLOSURE. Raising an
effect requires the control-bound handler value to be in scope, and the
compiler rejects capturing one into a closure:

```
error: Closures cannot capture a value of control-bound type. The captured
value `boom` has type `fn() -> unit` which transitively contains a
`ctl(...) -> ret` function. Closures can escape their enclosing frame, taking
the captured control function with them — which would unwind to a dead install
frame.
```

That rejection is correct and deliberate. Its consequence is that `body`
cannot raise an effect, so nothing can unwind past `with_lock` from inside it,
so the drop-on-unwind path is never taken. The comment describes a capability
of the runtime rather than a behaviour of this function, which reads as a
guarantee to anyone auditing lock safety.

`Semaphore.with_permit` (added in the same batch) has exactly the same shape.
Its doc states the accurate version and points here; a test asserting unwind
safety cannot be written, and the semaphore test file says so at the place the
test would have gone rather than leaving a silent hole.

## The same point, already in the plan

`plans/STD_API_STABILIZATION.md` §4 Concurrency asks that
`async/mutex.with_lock` *"either takes an `io` (so its doc claim becomes true)
or drops the claim"*. This is that item, generalised: it applies to the
blocking `Mutex.with_lock` too, and to any future `with_*` helper taking a
closure.

## Options

1. **Correct the comments** — cheapest, and honest. `with_permit` already does.
2. **Take the effect as a parameter**, e.g.
   `with_lock(body : Impl(Fn(inout(v) : T, exn : Exception) -> R))`, so the body
   can throw and the claim becomes both true and testable. This is what §4 asks
   of the async variant, and it is a breaking signature change.

(1) should happen regardless; (2) is a design decision about whether these
helpers are meant to be effect-transparent.
