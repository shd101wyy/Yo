# Codegen: `exn.throw` doesn't propagate when an `exn : Exception` parameter is locally bound

**Status:** Fixed

## Symptom

Any syntax error in a parsed file caused the self-hosted parser to silently
exit 0 (and earlier, before the trailing-comma workaround was applied,
hang) instead of reporting the error. Even with the parser correctly
calling `exn.throw(dyn(err))` and the generated C code checking
`__yo_effect_escaped` after the call, the unwind never reached the error
handler installed in `main`.

## Reproducer

```rust
// /tmp/bad.yo
a :: (fn() -> i32)(f(;))
// ./yo-self-bin check /tmp/bad.yo
// → prints "check: parsing /tmp/bad.yo" then exits 0 with no error
```

Or, fully isolated (compile and run with `yo compile`):

```rust
inner_throws :: (fn(exn : Exception) -> bool)({
  exn.throw(dyn(`boom`));
  true
});
call_with_local :: (fn() -> bool)({
  local_exn := Exception(throw : ((_e) -> unwind(false)));
  _r := inner_throws(local_exn);
  true
});
main :: (fn() -> unit)({
  r1 := call_with_local();
  println(`got r1 = ${r1.to_string()}`); // never printed without the fix
});
```

## Root cause

When a function takes an `exn : Exception` (or any struct-typed)
parameter whose type transitively contains a `ctl(...)` field, callers
that bind the value locally (e.g. `local_exn := Exception(throw : ...)`,
then `inner_throws(local_exn)`) are **handler installation points** —
the unwind raised inside the callee must land here, clear
`__yo_effect_escaped`, and read the value from `__yo_unwind_value`
before returning.

`src/codegen/exprs/other-fn-call.ts` only checked this for parameters
whose own type was a function (`isFunctionType(param.type)`). Struct
effect-record parameters were missed, so the call site emitted the
generic "propagate" return (`return (T){0};` without clearing the flag),
and the unwind silently propagated past every install site all the way
to `__yo_user_main`, which short-circuits before running the handler.

## Fix

In the Phase 2 install-site detection (`src/codegen/exprs/other-fn-call.ts`),
also recognise parameters whose type is control-bound (via
`typeIsControlBound`), and identify the install site by inspecting the
_argument atom_ passed at the call (so renamed bindings like
`local_exn` for an `exn` parameter resolve correctly). Matching atoms
whose innermost binding lives in a begin-block frame of the enclosing
function tag the call as a handler installation point — the existing
`emitEffectUnwindCheck` emits the correct clear + `memcpy` + return.

Regression test: `tests/error.test.yo` —
_"Exception install-point clears \_\_yo_effect_escaped after unwind"_.

## Known follow-up

The fix exposes a separate, pre-existing bug in the codegen of
`isEffectRecordMember` handlers with `forall(ResumeType)` in their ctl
signature. Their stub body in `src/codegen/functions/generation.ts`
unconditionally emits `__yo_effect_escaped = 1; return (T){0};`, which
is wrong for handlers whose actual body is a `return(resume_val)`
(resume). Under the old propagate-everywhere behaviour, this masked
itself because the outer test body short-circuited past any assertion.
The fix exposes the issue in
`tests/algebraic_effects.test.yo` →
_"Struct-record effect with forall handler — early return after
resume in while loop"_. Tracking separately in
`issues/codegen-forall-resume-handler-stub.md`.
