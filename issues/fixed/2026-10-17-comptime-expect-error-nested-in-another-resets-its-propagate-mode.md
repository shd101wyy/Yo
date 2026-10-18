# A `comptime_expect_error` nested in another's argument resets its propagate mode

**Severity:** S3 — a test-harness false failure: an expected error caught by `comptime_expect_error` is re-raised by `yo check` when the argument forces an impl whose member holds its own `comptime_expect_error`.

**Status:** fixed 2026-10-17. Found while writing `tests/shared_borrow_write.test.yo`
for `issues/fixed/a-field-write-through-a-shared-borrow-parameter-is-accepted-and-lost.md`.

## Reproducer

```yo
_R :: struct(n : i32, arr : Array(i32, 3));
f :: (fn() -> unit)({
  r := _R(n : i32(0), arr : [i32(0), i32(0), i32(0)]);
  y := &r;
  comptime_expect_error(y.arr(usize(0)) = i32(1), "is a `&` borrow, which is read-only");
});
impl(
  _R,
  probe : (fn(self : &Self) -> i32)({
    comptime_expect_error(self.no_such_field, "no_such_field");
    self.n
  })
);
```

On develop at `1a4cf8df6`, `yo check` reports the E0908 that the first
`comptime_expect_error` expects:

```
error[E0908]: Cannot write `y.arr)(usize(0)`: `y` is a `&` borrow, which is read-only.
```

Without the impl, or with an impl whose members hold no
`comptime_expect_error`, the file checks.

## Root cause

The element place `y.arr(usize(0))` looks `arr` up as a method, which forces
`_R`'s impl (impls are order-independent), so `probe`'s body is evaluated
inside the outer `comptime_expect_error`'s argument. The inner builtin set the
global propagate mode to `true` on entry and to `false` on exit, and cleared
the observation channel, instead of restoring what the outer one had. Back in
the outer argument, `raise_flow_violation` saw propagate mode off and flagged
the E0908 as a swallowed definition-time error; the outer builtin caught the
throw, but the flag stayed and `check` re-raised it.

## Fix

`evaluate_comptime_expect_error` (`src/evaluator/builtins/comptime_expect_error.yo`)
saves the propagate mode, the observed-error flag and the observed messages on
entry and restores them on exit, so an inner call hands the outer one its state
back.

Test: `tests/shared_borrow_write.test.yo`, "a nested comptime_expect_error keeps
the outer one's propagate mode". It fails on develop at `1a4cf8df6` with the
E0908 above.
