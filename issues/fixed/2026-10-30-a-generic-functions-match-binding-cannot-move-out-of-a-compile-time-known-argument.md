# A generic function's match binding cannot move out of a compile-time-known argument

**Severity:** S2 — valid code is rejected. A function with `generic(...)` parameters that matches a by-value parameter of a move-only type and moves a binding out (`.Err(e) => Result(B, Tok).Err(e)`) is E0901 ("it is borrowed (a `&T` parameter or a `match`/`for` binding)") when the call's argument is a compile-time-known constructor, such as `Result(i32, Tok).Err(Tok(n : i32(3)))`. The same call with a run-time argument compiles, and so does the same function without `generic(...)`.

**Status:** FIXED 2026-10-30 on `fix/generic-ct-arg-match-move`. Found the same day on `vbd/b8-arraylist-string-flip`: B8 makes `String` move-only, `Result.map` takes `self : Self`, and `tests/option_result_combinators.test.yo` chains `Result(i32, String).Ok(i32(10)).map(...)`, which failed inside the prelude at `.Err(error) => Result(B, ErrorType).Err(error)`. The bug predates B8: any move-only payload shows it on develop.

## Reproducer

```yo
{ println } :: import("std/fmt");
Tok :: struct(n : i32);
_m :: (fn(generic(B : Type), o : Result(i32, Tok), b : B) -> Result(B, Tok))(
  match(o, .Ok(_) => Result(B, Tok).Ok(b), .Err(e) => Result(B, Tok).Err(e))
);
main :: (fn() -> unit)({
  r := _m(Result(i32, Tok).Err(Tok(n : i32(3))), i64(1));
  println(match(r, .Ok(_) => i32(0), .Err(t) => t.n));
});
export(main);
```

develop a8e93166a: `error[E0901]: use of moved value: cannot copy `e`, whose type `Tok` is move-only ...` at the `Err(e)`. The same program compiles with `Tok(n : f())` for a run-time `f` inside a run-time-built `Result`, and `Option(Tok)` with `.Some(e) => Option(Tok).Some(e)` fails the same way.

## Cause

A generic function's body is specialized at its first call. `try_to_call` binds each parameter through `check_if_function_parameter_matches_argument`, owning for a by-value parameter. When an argument FOLDED to a compile-time constant, the specialization then re-binds that parameter to a run-time placeholder (`src/evaluator/calls/helper.yo`, the `cur_is_folded_const` loop), so the shared specialized body does not bake the first call's value in. That re-bind was always NON-owning, on purpose for implicitly copied types: the caller keeps a folded temporary and releases it after the call (an owning re-bind double-released `dyn(NotFound(...))` payloads, Phase 2.5 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

A parameter that is not compile-time, `&mut` or owning is marked an `&T` borrow (`bind_parameter`), so `_decide_match_mode` chose a BORROWING match for `match(o, …)`, its bindings were borrows, and moving `e` out was E0901. A temporary `YO_DEBUG_GM` trace showed the specialized body's `o` as `owning=false imm=true` for the constant argument and `owning=true` for the run-time one.

## Fix

The folded-constant re-bind keeps a by-value parameter OWNING when its type is move-only (`type_requires_explicit_copy`): the call moved the argument in, so the caller holds nothing to release, and the callee-side drop the specialization already emits is the one release. Implicitly copied types keep the non-owning re-bind. Test: "move-only: a generic function moves a match binding out of a compile-time-known argument" in `tests/move_only.test.yo` (an `Err` and a `Some` payload moved through generic functions from constructor arguments, each disposed once).
