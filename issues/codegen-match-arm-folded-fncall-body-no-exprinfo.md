# Match arm body that is a comptime-foldable FnCall → "Failed to transpile"

**Status:** OPEN, root cause CONFIRMED (no rebuild needed to diagnose).

## Repro

`/tmp/some2.yo` (runtime scrutinee, so not a comptime-fold-elimination artifact):
```rust
mk :: (fn(b : bool) -> Option(i32))(cond(b => .Some(i32(7)), true => .None));
main :: (fn() -> unit)({
  o := mk(true);
  v := match(o, .Some(x) => x, .None => i32(0));   // i32(0) -> "Failed to transpile"
  ...
});
```
TS prints `7`. self-bin emits `_tmp = // Failed to transpile i32(0);` in the
`.None` switch arm. Narrowed:
- `.None => 0` (bare literal atom) — **works**.
- `.None => i32(0)` / `.Some(x) => i32(3)` (primitive-conversion FnCall) — **fail**.
- `i32(usize(48))` at main-body top level — **works**.

So the gap is specifically a **comptime-foldable FnCall as a match arm body**.

## Root cause (confirmed by reading both sides)

- **Eval** (`yo-self/evaluator/exprs/match.yo`, fieldless arm ~1337, and the
  sibling bind-fields / primitive / literal arms): the arm body is evaluated via
  `evaluated_body_fl := evaluate_begin_expression(rhs_expr_em, …)` and its
  ExprInfo is read/stored under `ast_expr_id(evaluated_body_fl)` — the node
  *returned* by eval.
- **Codegen** (`yo-self/codegen/exprs/match.yo:271` etc.): extracts the arm body
  from the **original** match AST via `cargs.get(usize(1))` and passes it to
  `generate_case_body` → `_call_generate_expr` → `get_expr_info(original_node)`.
- For an atom body (`x`, `0`) eval returns the same node → ids match → codegen
  finds the ExprInfo. For a comptime-foldable FnCall (`i32(3)`), eval folds it to
  a **synthesized constant node** with a new id → `evaluated_body_fl` ≠ the
  original `cargs[1]` node → codegen's lookup on the original misses → bail at
  `generation.yo:248` ("Failed to transpile").

This is the table-keyed-ExprInfo analogue of TS, where `evaluateExpression`
mutates `expr.$` in place on the original node, so the original arm-body node
always carries the info.

## Fix direction

In `match.yo`, after evaluating each arm body, also record the resolved body
ExprInfo under the **original** arm-body expr id (the `cargs[1]` node that
codegen walks). Must be applied to every arm kind (fieldless, bind-fields,
primitive-value, literal, wildcard) for completeness. Validate broadly
(std+tests+yo-self) since match arm handling is pervasive — and use `--release`
builds (per the heavy-file SIGBUS, -O0 per-file check is an unreliable gate).
