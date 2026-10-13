# `f() && false` / `f() || true` never call `f()`

**Severity:** S1 — silent miscompilation: a runtime operand that comes BEFORE a short-circuiting compile-time constant (`rt && false`, `rt || true`) was never evaluated, so its side effects vanished, in a `cond`/`if` guard and in plain value position alike.

> Found 2026-10-13 while fixing
> `issues/fixed/comptime-identity-operand-folds-and-or-to-a-constant.md`
> (the same accumulator in `evaluate_and_or`). **FIXED** on
> `fix/comptime-and-or-fold`.

## Reproducer

```yo
{ println } :: import("std/fmt");
(counter : i32) = i32(0);
_bump :: (fn() -> bool)({
  counter = (counter + i32(1));
  true
});
_p :: (fn() -> bool)(_bump() && false);
_q :: (fn() -> i32)(if(_bump() || true, i32(2), i32(3)));
main :: (fn() -> unit)({
  p := _p();
  println(`p=${p} counter=${counter} (want false 1)`);
  q := _q();
  println(`q=${q} counter=${counter} (want 2 2)`);
});
export(main);
```

With the v0.2.60 seed:

```text
p=false counter=0 (want false 1)
q=2 counter=0 (want 2 2)
```

The VALUES are right; the call is gone. `_p` compiles to `return false;`.

## Root cause

Two places treated a short circuit as deciding the whole expression, even
when a runtime operand had already run:

- `evaluate_and_or` (`src/evaluator/builtins/and_or.yo`) stored the
  short-circuit constant as the expression's compile-time value whatever came
  before it. A `cond` guard with a compile-time value selects its arm without
  emitting the guard, and a value-position expression with a compile-time
  value is emitted as the constant.
- `generate_op_and` / `generate_op_or` (`src/codegen/exprs/and_or.yo`)
  returned the literal `false` / `true` on the first compile-time
  short-circuit operand, discarding the runtime operands collected so far.

## Fix

The evaluator keeps the short-circuit constant only when no runtime operand
came before it; otherwise the result is a runtime value (operand evaluation
still stops at the short circuit, matching what runs). Codegen keeps the
constant as the LAST operand when runtime operands precede it, so
`f() && false` emits `(f() && false)` (or the `if` chain when a later operand
has side effects) and nothing after the constant.

Tests: `tests/comptime.test.yo`, "&& / || short-circuiting after a runtime
operand still run it".
