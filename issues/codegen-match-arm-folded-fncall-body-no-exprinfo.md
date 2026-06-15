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

## DEFINITIVE DIAGNOSIS (probe-confirmed 2026-06-16) — supersedes everything below

A 3-way id probe (eval `rhs_expr_em`/`evaluated_body_fl` + codegen `body_expr`)
on `some2.yo` printed:
```
PROBE_FL rhs_id=34529 eval_id=34529      (eval: original arm-body node == evaluated node)
PROBE_CG body_id=34529 has_info=YES      (codegen: same node, AND ExprInfo IS FOUND)
```
So **all three ids are the same node and codegen DOES find its ExprInfo** — the
title's "no ExprInfo" framing and the node-id-mismatch hypothesis were BOTH
WRONG. The "Failed to transpile i32(0)" comes from **generation.yo:371**
(`generate_other_function_call` returns None), NOT the :248 missing-ExprInfo bail.

Mechanism: the arm body `i32(0)` reaches codegen with ExprInfo present but with
**no usable comptime value**, so `generate_func_call`'s comptime-value emit path
(generation.yo:305-315) is skipped, `i32` is not an inline builtin
(`BuiltinYoInlineFunctions` — only operators/ptr/cast-`__yo_as`/etc.), and it
falls through to `generate_other_function_call`, which returns None for this
primitive type-conversion call → "Failed to transpile". Contrast: top-level
`i32(usize(48))` works because it is comptime-folded to `48` (the comptime path,
never reaching the call dispatcher); a bare-literal arm body `0` works for the
same reason. So the gap is a primitive-conversion call (`i32(<literal>)`) that
arrives at codegen WITHOUT a folded value, in the runtime-match-arm context.

## Two candidate root causes (pick via one more targeted probe)

- **(A) eval — the arm-body comptime value is lost.** Either eval doesn't fold
  `i32(0)` in the non-executing arm context (`is_arm_executing_fl=false`,
  `is_executing=false`) the way it folds at the top level, OR `match.yo:1357`
  (`if(scrutinee_val_opt.is_none()) body_info_fl.value = None`) mutates the
  **shared** ExprInfo object that is also the arm body's table entry (ExprInfo is
  an `object` → reference; `body_info_fl` IS the table's id-34529 entry), nulling
  the arm body's own stored value. If the comptime value were preserved, codegen
  emits `0` and the bug disappears. NEXT PROBE: print `body_info_fl.value` state
  (Some/None/Unknown) and whether the `scrutinee_val_opt.is_none()` branch fires.
- **(B) codegen — `generate_other_function_call` can't emit a runtime primitive
  type-conversion call** (`i32(x)`). `int(x)` casts do emit, so check why the
  `i32` callee doesn't resolve to the primitive-cast branch here.

(A) is the more likely + more faithful fix (TS keeps the arm-body data distinct
from the match-result data; yo-self's shared-object mutation is the suspect).
Validate via `--release`; apply to all 4 arm kinds if it's (A)'s nulling.

## (obsolete) earlier fix direction

ATTEMPT 1 (reverted, --release-validated): added `_record_arm_body_on_original`
at all 4 arm sites (wc/lit/fl/wf) — after evaluating the arm body, if the
evaluated node id ≠ the original arm-body node id (`rhs_expr_em` = pattern's
`pargs.get(1)`), also store the resolved body ExprInfo under the original id.
RESULT: `some2`/`match_arm_folded_fncall` STILL emits "Failed to transpile
i32(0)"; the other 39 corpus fixtures unaffected. So the hypothesis (eval folds
`i32(3)` to a new node, and recording under `rhs_expr_em` realigns codegen) is
WRONG, OR `rhs_expr_em` (eval) and `cargs.get(1)` (codegen) are **different node
instances** despite both being "arm arg index 1".

REFINED HYPOTHESIS (untested): the evaluator processes a CLONED/transformed copy
of the match AST (so eval's arm-body node id ≠ the original parsed node that
codegen walks), OR `i32(0)` simply never gets ExprInfo recorded under ANY id the
arm path can reach. NEXT STEP MUST BE A PROBE (not another blind fix): instrument
`match.yo` to eprintln `ast_expr_id(rhs_expr_em)` vs `ast_expr_id(evaluated_body_X)`
AND, on the codegen side (`codegen/exprs/match.yo` ~858), eprintln
`ast_expr_id(cb0)` + whether `get_expr_info(cb0)` is Some — for the failing
`i32(0)` arm. Compare the three ids. Only then fix the confirmed layer. Apply to
every arm kind; validate via `--release` (per the heavy-file SIGBUS, -O0 per-file
check is an unreliable gate).
