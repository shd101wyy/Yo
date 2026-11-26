# A call through a function value typed `-> never` does not coerce to the expected type (E0601)

**Severity:** S3. A valid program is rejected with a misleading E0601. Calling a named `-> never` function directly works, so the workaround is to call through a name.

- Filed 2026-11-27 from VERDICTS-89 §9 finding 3 (probes p17, p21, p23). Reproduced with a stage 1 of `wip/v0281-dupdrop-r9` merged with develop `bc706b0a3` (v0.2.80).
- It blocks the `-> never` spelling of a non-resuming operation (`issues/questions/2026-11-27-a-non-resuming-operation-is-ctl-returning-never.md`).

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ panic } :: import("std/assert");
die :: (fn(code : i32) -> never)(panic("die"));
viaparam :: (fn(c : i32, f : (fn(code : i32) -> never)) -> String)(
  cond(
    (c == i32(0)) => String.from("ok"),
    true => f(c)
  )
);
direct :: (fn(c : i32) -> String)(
  cond(
    (c == i32(0)) => String.from("ok"),
    true => die(c)
  )
);
main :: (fn() -> unit)({
  println(&direct(i32(0)));
  println(&viaparam(i32(0), die));
});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types: "never" and "String"
  --> p23.yo:8:13
  |
8 |     true => f(c)
  |             ^
```

`direct` is accepted. A `ctl(code : i32) -> never` record field called as `exn.throw(c)` in a `cond` arm fails the same way (p17):

```text
error[E0601]: Cannot unify incompatible types: "never" and "String"
   --> p17.yo:10:16
   |
10 |     true => exn.throw(c)
   |                ^
```

## Root cause

Not yet traced to the line. What the probes establish:

- The arm's expected type is fine. `direct`'s arm `die(c)` is accepted in the same `cond`.
- The failing calls are the ones whose callee is a function value: a parameter `f : (fn(code : i32) -> never)` or a record field of `ctl(...) -> never` type.
- So the call-through-a-value path forms the call's result as the declared `never`, and the arm unifies `never` with `String`. Whatever coerces a direct call's `never` result (the `cond` arm logic in `src/evaluator/exprs/cond.yo` skips `never`-typed arm bodies) is not reached for these calls.

The fix makes a `never` result coerce for every callee kind. Its test is a run test of the reproducer above, with a `ctl` field arm as well, in `tests/algebraic-effects.test.yo`. The test is rejected before the fix and accepted after.
