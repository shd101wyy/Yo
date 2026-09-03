# A `&&` right operand inside a match arm leaks its temp's drop out of the arm's C scope

## Status

OPEN (fix implemented in this session; move to `issues/fixed/` with the PR).

## The error (verbatim)

```
/tmp/rvg.out.c:1667:10: error: use of undeclared identifier '_file____priv_temp_11541'
/tmp/rvg.out.c:1669:27: error: use of undeclared identifier '_file____priv_temp_11541'
```

(Identifier name varies — it is an eval-minted temp `_` + first 12 chars of the
minting module path + `_temp_<counter>`, see `generate_temp_variable_name_prefix`
in `src/utils.yo`.)

## Minimal reproducer (tmp/fixme.yo shape)

```rust
{ String } :: import("std/string");
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");

probe :: (fn(s : String) -> bool)({
  match(
    s.index_of(String.from("=")),
    .Some(i) => assert((i > usize(0)) && (String.from("k=v").len() > i), "arm"),
    .None => assert(false, "none")
  );
  true
});
main :: (fn(io : Io) -> unit)({
  r := probe(String.from("k=v"));
  println(r.to_string());
});
export(main);
```

`yo compile` fails at the C stage. Plain function or effectful `main` — both
fail; what matters is:

1. a **match arm whose body is not a `begin` block**, and
2. a **`&&` (or `||`)** in that body whose right operand **creates an RC temp**
   (any call returning an owned value — `String.from(...)` is enough), and
3. the scrutinee being an `Option`/enum so the arm lowers through
   `generate_case_body`.

Variants that PASS (the boundary of the bug): the same `&&` + `String.from`
temps in a `cond(...)` arm; the same match arm with a single `==` (no `&&`);
the same shape with the arm body wrapped in `begin(...)`.

Under `yo test` this surfaces as the batch runner failing
`batch compile failed (exit 1)` on a generated
`.yo_selftest_batch_*.bin.c` — the batch `main` wraps every test arm in a match
on `YO_TEST_INDEX`, so ANY test whose body contains such an `&&` breaks its
whole batch.

## Root cause

`&&`/`||` with side-effectful right operands lower to an if-chain
(`generate_op_and` in `src/codegen/exprs/and_or.yo`): the right operand's code
— including the declarations of its eval-minted temps — is emitted INSIDE a
nested `if (...) { ... }` block. When the chain closes, `_emit_drops_for_conditional_branch`
claims the branch-created temps' deferred drops from
`context.pending_deferred_drops`, emits them inside the branch, and marks the
targets in `short_circuit_handled_drop_var_names` so later scope-end flushes
skip them.

`pending_deferred_drops` is only populated by:

- `generate_function_body` (the function-body begin, `src/codegen/functions/generation.yo`),
- `generate_begin` (each `begin` block, `src/codegen/exprs/begin.yo`),
- `generate_case_body`'s **begin-arm** path (`src/codegen/exprs/match.yo`),
- the async state-machine segment emitter.

The **non-begin arm** path of `generate_case_body` never published the arm
value's own `deferred_drop_expressions` into `pending_deferred_drops`, so the
short-circuit claim found nothing. The drop stayed on the arm value's
ExprInfo and was flushed by the call-site flush
(`generate_deferred_drop_expressions` in `other_fn_call.yo` /
`match.yo`'s arm tail) AFTER the `&&` if-block had already closed — emitting
`switch ((<temp>).tag) { ... __yo_decr_rc ... }` outside the C scope where the
temp was declared. clang: use of undeclared identifier.

## Fix

`src/codegen/exprs/match.yo`, `generate_case_body`, non-begin arm path: wrap
the arm body generation with the same pending-drop publication the begin path
twenty lines above already does —

```yo
nb_prev_pending := context.pending_deferred_drops;
nb_drops := match(
  context.base.get_expr_info(body_expr),
  .Some(nb_vei) => nb_vei.deferred_drop_expressions,
  .None => Option(ArrayList(AstExpr)).None
);
context.pending_deferred_drops = Option(ArrayList(AstExpr)).Some(_concat_drops(nb_drops, nb_prev_pending));
nb_code := _call_generate_expr(body_expr, indent.clone(), context);
context.pending_deferred_drops = nb_prev_pending;
```

With the drops visible, `_emit_drops_for_conditional_branch` claims them
in-branch; the later site flush skips them via the existing
`short_circuit_handled_drop_var_names` one-shot guard.
