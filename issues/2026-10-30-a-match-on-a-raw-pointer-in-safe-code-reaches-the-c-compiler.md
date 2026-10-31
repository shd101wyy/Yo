# A `match` on a raw pointer in safe code reaches the C compiler

**Severity:** S3 — safe code that matches on the `*T` element of `xs.iter()` gets a C compiler error (`member reference base type ... is not a structure or union`) instead of Yo's "Raw pointer values are not available in safe code" diagnostic.

**Status:** open. Found 2026-10-30 while probing `Rc(ArrayList(Self))` fields for V4 `AstExpr` (branch `vbd/v4-astexpr-children`); not fixed there, since that branch does not touch the safe-code gate.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
N :: ref(enum(Leaf(v : i32), Pair(a : i32, b : i32)));
main :: (fn() -> unit)({
  xs := ArrayList(N).new();
  xs.push(N.Leaf(i32(1)));
  for(xs.iter(), e => {
    match(e, .Leaf(v) => println(&v), _ => ());
  });
});
export(main);
```

`yo compile` (develop `b7e873958`) passes the evaluator and fails in clang:

```text
error: member reference base type '__yo_t_… *' (aka 'struct __yo_t_…_struct *') is not a structure or union
yo: error: compile: C compiler failed (exit 1) on probe.c
```

The same body with `ArrayList(i32)` and `match(e, _ => println("elem"))` fails with `statement requires expression of integer type ('int32_t *' ... invalid)`. Using `e` anywhere else, for example `(x : bool) = e;`, is rejected by the evaluator as intended:

```text
error: Raw pointer values are not available in safe code: 'e' has type '*(N)'.
```

## Root cause

`ArrayList.iter()` yields `ArrayListIterPtr(T)`, whose items are `*T`. The safe-code raw-pointer gate runs only in `_evaluate_expression_raw_wrapper` (`src/evaluator/exprs/_expr.yo`). `match` evaluates its scrutinee through `evaluate_expression` (`src/evaluator/exprs/match.yo`, the `evaluated_scrutinee` binding), the non-raw wrapper, so the gate never sees the scrutinee. The arms are then compiled against a `*T` scrutinee as if it were a `T`.

## Fix

Route the scrutinee through the same gate. Either evaluate it with `evaluate_expression_raw`, or call the gate's check on the evaluated scrutinee's `ExprInfo`. Test: a `comptime_expect_error` case or a cli-case with the reproducer above that expects the raw-pointer diagnostic. Today it fails in the C compiler.
