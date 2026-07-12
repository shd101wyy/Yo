# Stage-2 residual: `evaluated_callee` double-drop in `evaluate_function_call`

## Status

OPEN. Second of two gen-2 (self-compiled binary) RC over-releases behind the
stage-2 fixpoint. The FIRST (`set_expr_as_needs_to_call_dup` missing env
propagation) is FIXED (see below); this one remains.

## Symptom

`<self-compiled-binary> check yo-self/expr_traversal.yo` (and `main.yo`) →
rc=139 SIGSEGV. TS (`./yo-cli`) and the TS-compiled yo-self binary both pass on
the same input. `lldb` MASKS the crash (layout-sensitive); use the catcher
(`scripts/rc-free-site-catcher.py`) or the node-gated RC-history / dbg tracers
(`<scratchpad>/rc-hist.py`, `dbg92.py`).

## Root cause (DEFINITIVELY confirmed via node-92024-gated s2.c instrumentation)

In `yo-self/evaluator/calls/function.yo` `evaluate_function_call`:

```
func_expr := match(expr, .FnCall(_, func_box, _, _, _) => func_box, .Atom(_,_) => make_err_expr());   // ~1264
...
evaluated_callee := match(given_value,
  .Some(gv) => { ...; func_expr },
  .None     => evaluate_expression_raw(func_expr, env, ctx, exn));                                     // ~1662-1671
```

`evaluate_expression_raw(func_expr)` RETURNS `func_expr` **borrowed** (rc
unchanged — no +1). Confirmed RC history for the freed node:

```
ALLOC rc1 (clone in create_specialized, parent-owned)
INCR  rc1->2 (func_box dup at the func_expr match — 365425 in emitted C)
DECR  rc2->1 (func_expr scope-end drop)
FREE  rc1->0 (evaluated_callee scope-end drop)   <-- over-release
```

`evaluated_callee` aliases `func_expr` (same node) but does NOT own a ref: the
eval returned a borrow, and because the eval-result shares `func_expr`'s OWNING
temp/ExprInfo, `set_expr_as_needs_to_call_dup` (utils.yo:642-658, begin-tail
pass) takes the _owning-temp consume/transfer_ path instead of building a dup —
so no balancing `___dup` is emitted. Both `func_expr` and `evaluated_callee` are
then dropped against a single owned ref (the func_box dup) → the second drop
frees the parent-owned node.

## Why TS doesn't hit it

TS (`function.ts:221`) uses ONE variable: `let func = expr.func; if (fncall)
func = evaluateExpression(func);` — `func` is reassigned in place, dropped once.
yo-self split it into two live aliases (`func_expr` used by try_to_call /
\_static_dot_receiver_self_type / stored in `out.func_expr`; `evaluated_callee`
used by callee-info lookup / \_try_expand_call_overload / \_try_find_receiver_method),
both owning, both dropped.

## Fix options (all real, none trivially safe — pick with the validation gates below)

1. **Eval-return ownership (root):** when `evaluate_expression_raw` returns the
   input node aliased (borrow), its result temp must be marked NON-owning so the
   begin-tail pass DUPs (same-node `___dup`) instead of consuming. Look at the
   temp-ownership marking on the raw-eval return path (attach_temp /
   `_bridge_expr_info` in `yo-self/evaluator/exprs/_expr.yo`). Most faithful.
2. **One-variable refactor (mirror TS):** make `func_expr` mutable and reassign
   it (`func_expr = evaluate...`), drop the separate `evaluated_callee`, rename
   its 6 uses to `func_expr`. NOTE: naive reassignment still frees, because the
   eval returns a borrow — needs option 1's owned return too.
3. **Same-node dup for `evaluated_callee`:** force a `___dup` (NOT `.clone()` —
   clone makes a new node with the SAME id → ExprInfo id-collision → heap
   corruption, verified) on the eval result so `evaluated_callee` owns its ref.

## DO NOT

- `.clone()` any AstExpr to "fix" RC — `AstExpr.clone()` keeps the id (share-on-
  recursion), so a distinct node object with a duplicate id corrupts the
  ExprInfo table / GC (verified: token.yo/lexer.yo 0→heap-corruption this
  session). Same-node `__yo_incr_rc`/`___dup` only.

## Validation gates (run in order; revert on any regression)

1. `bun run build` (no TS errors)
2. `./yo-cli fmt <file>` on any edited .yo
3. stage-1 `./yo-cli check ./std` → must stay 153/153
4. rebuild s1: `./yo-cli compile yo-self/main.yo --release -o /tmp/s1`
5. `/tmp/s1 check ./std` 153/153; `/tmp/s1 check yo-self/main.yo` rc=0
6. emit+build s2: `/tmp/s1 compile yo-self/main.yo --release -o /tmp/s2`
7. **`/tmp/s2 check yo-self/expr_traversal.yo` rc=0** (was 139), and
   token.yo/lexer.yo/expr.yo/parser.yo/main.yo all rc=0, t5.yo/t2.yo rc=0
8. Then fixpoint: `/tmp/s2 compile … --emit-c` ≡ stage-3.c; then tasks #69/#70.

## FIRST bug — FIXED this session (context)

`set_expr_as_needs_to_call_dup` (utils.yo) was missing `ei.env =
evaluated_dup.env` (mirror of TS `expr.ts:2581`); added it → `s2 check expr.yo`

- `parser.yo` 139→0, no regression. That fix is in the working tree (uncommitted).
  Full trail: memory `yo-self-fixpoint-gen2-frontier.md`.
