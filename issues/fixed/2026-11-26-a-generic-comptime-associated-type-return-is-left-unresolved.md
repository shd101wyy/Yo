# A generic function returning `comptime(T.Output)` yields the bare type `Output`

**Severity:** S2 — a valid generic comptime function cannot be used. Its result has the unresolved type `Output`, so any use is E0610 (or E1301 at a conversion), while the runtime spelling `-> T.Output` works.

**Status:** fixed (lane v81-comptime-proj, `wip/v0281-comptime-proj`): the CTFE arm of `evaluate_function_call` re-evaluates the declared return-type expression in the bound call env, as the runtime arm does (`_rre_reevaluate_return_type`, `src/evaluator/calls/function.yo`). Test: `tests/comptime-projection-return.test.yo`. The prelude's comptime `(-)` and `(~)` dispatchers take `comptime(_Self.Output)` in a Generation B follow-up (`wip/v0281-comptime-proj-genb`): stage 1 is built by the seed, whose evaluator still has this bug, so the flip lands once `SEED_VERSION` carries this fix.

**Found:** 2026-11-26, lane v81-v87-ad (VERDICTS-87 PR D). The fix for `issues/fixed/2026-11-26-negate-and-bitnot-output-are-ignored-by-the-unary-dispatchers.md` gave the prelude's comptime dispatchers `-> comptime(_Self.Output)`, and stage 1 then failed to build: `f64(-1.0e400)` in `std/math.yo` (`f64.NEG_INFINITY`) became `double.__yo_v_NEG_INFINITY` in the emitted C, which clang rejects ("expected expression").
**Measured:** stage 1 of `wip/v0281-v87a` (yo 0.2.79 + develop `77af20c87` + VERDICTS-87 PR A), with that branch's std.

## Symptom

```yo
{ println } :: import("std/fmt");
f :: (fn(generic(T : Type), comptime(x) : T, where(T <: (Comptime, ComptimeNeg))) -> comptime(T.Output))(x.neg());
g :: (fn(generic(T : Type), x : T, where(T <: Neg)) -> T.Output)(x.neg());
main :: (fn() -> unit)({
  d := f(2.5);
  println(`${d}`);
});
export(main);
```

```text
error[E0610]: No method "to_string" on Output: the type has no field or method with that name.
```

- `f(i32(2))`: the same error.
- `d := f(2.5); x := f64(d);`: E1301 "internal compiler error: Failed to transpile part of main's body".
- `g(i32(3))`, the runtime twin: prints `-3`.

## Root cause

`f(2.5)` takes the CTFE arm of `evaluate_function_call` (`src/evaluator/calls/function.yo`), because the callee's result is compile-time only. That arm stamps the call's type from the declared return in two steps: it substitutes the forall binders this call bound (`fa_bound_names`), then resolves what remains from the call env (`evaluate_function_return_type_again`). The projection `T.Output` evaluates at definition time to a SomeT of its own, named `Output`. It is neither a forall binder nor a name bound in the call env, so both steps leave it, and the arm adopts only a SomeT-free result: the call kept the declared `Output`.

The runtime arm (`_evaluate_funcval_runtime_call`) has a third step: when SomeTs remain, it re-evaluates the declared return-type EXPRESSION (`T.Output`, registered without its `comptime(...)` wrapper) in the bound call env, where `T` is `f64` and the where clause names the trait (`YO_DEBUG_RRE` on `g(2.5)`: `resolved_ret=Output`, re-evaluated `f64`). The CTFE arm never ran it.

The fix moves that re-evaluation into `_rre_reevaluate_return_type` and calls it from both arms. The CTFE arm runs it when substitution left SomeTs and adopts only a SomeT-free, non-unit result.

The stage-1 failure that found this (`f64(-1.0e400)` emitted as `double.__yo_v_NEG_INFINITY`) is the same bug through the prelude's comptime `(-)` dispatcher: with `-> comptime(_Self.Output)`, the negated literal's type was the bare `Output`. A stage 1 built with this fix as stage 0 and the flipped prelude builds and passes `tests/comptime-projection-return.test.yo`.

The binary-operator route's patch (~12006, "Resolve an associated-type return (`comptime(Self.Output)`) that came back as a bare SomeT") is a separate route (operator calls resolved against the receiver's registered associated types) and is left as is.

## The prelude's comptime dispatchers (Generation B)

Until the seed carried this fix, the prelude's `comptime_neg` and `comptime_bit_not` (the `(-)` and `(~)` dispatchers) kept `-> comptime(_Self)`: CI builds stage 1 with the seed, whose evaluator had this bug. They return `comptime(_Self.Output)` since `wip/v0281-comptime-proj-genb`; its test, "comptime - and ~ return the trait's Output" in `tests/comptime-projection-return.test.yo`, covers a user `Output` that is not `Self` and `f64(-1.0e400) == f64.NEG_INFINITY`.

## Test

`tests/comptime-projection-return.test.yo`: `neg_ct(2.5) == -2.5`, `neg_ct(i32(2)) == i32(-2)`, `f64(neg_ct(2.5))`, and a user comptime type `CtV` whose `ComptimeNeg.Output` is `CtW`. Before the fix (stage 1 of `wip/v0281-v87d`) the file fails to compile with the E0610 above.
