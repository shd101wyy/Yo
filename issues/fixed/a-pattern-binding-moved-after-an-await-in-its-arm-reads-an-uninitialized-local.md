# A pattern binding moved after an await in its arm reads an uninitialized C local

**Severity:** S1. A task that binds a payload, awaits in the arm, and then moves the binding crashes (SIGSEGV, ASan heap-use-after-free).

**Status: FIXED (2026-09-30).** This was a regression of #1018's single-pass lowering; the v0.2.46 seed printed correctly. It was found by re-verifying `issues/fixed/async-abort-dispose-double-drops-moved-enum-payload.md`.

## Symptom

```rust
match(r, .Err(msg) => { e.io.await(yield(e.io), e.io); e.exn.throw(dyn(msg)) }, .Ok(v) => .Some(v))
```

The program exited with rc=139.

## Cause

The move of `msg` is a consuming read of its slot: `_sm_consuming_read` returns a `__yo_moved<k>` temp and zeroes the slot. The argument renderer in `src/codegen/exprs/other_fn_call.yo` treated only an `sm->` read as a slot read. For the moved temp it fell back to the binding's name, `msg`, which is the case block's C local, initialized before the await. When the task resumes at the await's label, that initialization is skipped. It also emitted a dup of the slot it had just zeroed.

## Fix

A `__yo_moved` read is passed through like a slot read. The temp already owns the value, so no C local and no dup are needed. Clearing the scrutinee's copy of the payload is `issues/fixed/async-abort-dispose-double-drops-moved-enum-payload.md`.

Test in `tests/async/sm_ownership.test.yo`: "a pattern binding moved after an await in its arm is released once".
