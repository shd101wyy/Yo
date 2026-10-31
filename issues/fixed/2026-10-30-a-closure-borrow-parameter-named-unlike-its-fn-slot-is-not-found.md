# A closure's `&T` parameter named unlike its `Fn` slot is "not found"

**Severity:** S2 — a closure literal whose `&T` / `&mut T` parameter is named differently from the expected `Fn` slot's label was rejected with `Variable "s" not found` (E0401), so a valid program failed to compile unless the names happened to agree.

Found 2026-10-30 while testing projection closures for decision 43 step 2 (N1c-3).
The seed v0.2.73 and develop `a8e93166a` both reject the reproducer.

## Reproducer

```yo
bs_apply_named :: (fn(f : Impl(Fn(t : &i32) -> i32), x : &i32) -> i32)(f(&x));
main :: (fn() -> unit)({
  k := i32(3);
  _ := bs_apply_named((s : &i32) => (s + i32(1)), &k);
  ()
});
export(main);
```

```text
error[E0401]: Variable "s" not found.
```

A by-value parameter (`(s : i32) => …` under `Fn(t : i32)`) was accepted.

## Root cause

`desugar_if_calls` rewrites a borrow slot `s : &T` to `__yo_imm(s) : T`
(`__yo_mut(s) : T` for `&mut T`) before evaluation. A closure parameter's
name comes from `_get_param_name_from_expr`
(`src/evaluator/values/anonymous_function.yo`), which reads the left side of
`:` only when it is an atom. For any call there, including the borrow heads,
it fell back to the expected slot's label. The parameter was bound as `t`, and
the body's `s` was not in scope.

## Fix

`_get_param_name_from_expr` reads the name inside a `__yo_imm(x)` /
`__yo_mut(x)` head (`ast_expr_is_capture_mode_entry`). Any other call shape
still falls back to the expected label, which
`issues/a-closure-parameter-written-as-a-call-is-accepted-under-the-expected-label.md`
tracks.

## Test

`tests/borrow_spelling.test.yo`, "a `&T` / `&mut T` closure parameter keeps
its own name under a differently labelled `Fn` slot". It covers a `&T` and a
`&mut T` closure parameter.
