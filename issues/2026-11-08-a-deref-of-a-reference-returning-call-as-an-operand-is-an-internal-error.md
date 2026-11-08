# `.*` on a `&T` call result used as an operand is an internal error

**Severity:** S1 — a compiler internal error on valid input: `f(&a).* == f(&b).*` with `f` returning `&T` stops the check with "arg has no ExprInfo".

- Filed: 2026-11-08 (deref lane, VERDICTS-38 §5 item 1; found by Fable's probe p6b).
- Reproduced on develop `a25a71ee1` (a tree build), user file and std tree alike: the reading of `.*` (A-narrow or the full rule) does not matter.

## Reproducer

```yo
{ println } :: import("std/fmt");
S :: struct(m : i32);
first :: (fn(s : &S) -> &i32)(&s.m);
main :: (fn() -> unit)({
  a := S(m : i32(5));
  b := S(m : i32(5));
  println(`${first(&a).* == first(&b).*}`);
});
export(main);
```

```text
error: check_if_function_parameter_matches_argument: arg has no ExprInfo
  --> tmp/f1c.yo:7:23
```

The column is the first `first(&a).*`. The same shape through a generic
caller (`a.as_ref().* == b.as_ref().*` on `a, b : &Rc(T)`) fails the same way
at its instantiation. Binding the reference first (`x := first(&a); x.* ==
…`) is accepted.

## Where to look

The `==` operand is the `.*` property access whose object is a call returning
`&T`. The operator's overload trial calls
`check_if_function_parameter_matches_argument` on that operand before its
`ExprInfo` exists: the `.*` on a reference RESULT (not a reference binding) is
evaluated through a path that does not record the operand's info under the id
the trial reads (`src/evaluator/calls/function.yo`,
`src/evaluator/exprs/property_access.yo`'s `.*` arms).

A test belongs with the fix: the reproducer above in `tests/local_borrows.test.yo`
(or a sibling) asserting `true`.
