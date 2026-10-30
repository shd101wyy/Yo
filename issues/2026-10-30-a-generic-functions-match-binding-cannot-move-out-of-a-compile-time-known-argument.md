# A generic function's match binding cannot move out of a compile-time-known argument

**Severity:** S2 — valid code is rejected. A function with `generic(...)` parameters that matches a by-value parameter and moves a binding out (`.Err(e) => Result(B, String).Err(e)`) is E0901 ("it is borrowed (a `&T` parameter or a `match`/`for` binding)") when the call's argument has a value known at compile time, such as a constructor temp `Result(i32, String).Err(String.from("bad"))`. The same call with a run-time argument compiles, and so does the same function without `generic(...)`. Only move-only payloads show it, so it surfaces on the B8 tree (`String` is a value) and is invisible on develop, where a `String` copy is still a share.

**Status:** open. Found 2026-10-30 on `vbd/b8-arraylist-string-flip`: `tests/option_result_combinators.test.yo` chains `Result(i32, String).Ok(i32(10)).map(...)`, and `Result.map` (now `self : Self`, since a by-borrow `map` copied the error out) fails inside the prelude at `.Err(error) => Result(B, ErrorType).Err(error)`.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
_m :: (fn(generic(B : Type), o : Result(i32, String), b : B) -> Result(B, String))(
  match(o, .Ok(_) => Result(B, String).Ok(b), .Err(e) => Result(B, String).Err(e))
);
main :: (fn() -> unit)({
  r := _m(Result(i32, String).Err(String.from("bad")), i64(1));
  println(match(r, .Ok(_) => 0, .Err(_) => 1));
});
export(main);
```

On the B8 std with the develop `b7e873958` compiler: `error[E0901]: use of moved value: cannot copy `e`, whose type `String` is move-only ...` at the `Err(e)`. Variants that compile and print `1`: the argument built at run time (a `mut` local reassigned under a run-time `if`), or `_m` without `generic(B : Type)` (its body is evaluated once, at definition time, with the parameter unknown).

## Analysis so far

A generic function's body is evaluated per call against the call-time parameter binding (`check_if_function_parameter_matches_argument` → `bind_parameter`, `src/env.yo`), and that binding carries the argument's compile-time value. The scrutinee is then compile-time known (`ct_known` in `evaluate_match`, `src/evaluator/exprs/match.yo`), so the pattern bindings are added `is_compile_time_only` with the matched value. `_decide_match_mode` still returns `MATCH_MODE_CONSUME` for the by-value parameter, and the selected arm's bindings should be owned (`_own_all`), yet `transfer_explicit_copy_value` (`src/evaluator/utils.yo`) reaches its last arm for `e`, so `e` is neither owning nor a temp. Not yet located: which path evaluates the selected arm of a compile-time-known match without the consuming arm's ownership step.

## Fix direction

A compile-time-known scrutinee should not change ownership: a consuming match's selected-arm bindings own their parts whether or not the value is known. A test goes into `tests/move_only.test.yo` with the fix (the reproducer above, asserting the `Err` payload arrives).
