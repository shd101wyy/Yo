# A `&&` right operand inside a match arm leaks its temp's drop out of the arm's C scope

## Status

FIXED 2026-09-03.

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

Two failed designs first (kept here because the constraints they broke are
the real spec):

1. **Concat-publish into `pending_deferred_drops`** (what the begin path
   does): the short-circuit claim could then also reach drops rolled up to
   the FUNCTION-BODY pending list, whose emission is owned by the
   effect-unwind path (`__yo_effect_escaped` → "drop locals before early
   return"). The claim emitted an UNCONDITIONAL in-branch drop beside the
   escape-only one — a double free whenever a throw inside the arm unwound
   (`json_parse lone high surrogate`, ASan heap-use-after-free; one extra
   `__yo_decr_rc` line in the emitted C).
2. **Replace `pending_deferred_drops` with the arm's own list** (no concat):
   the unwind path then missed the outer drops during arm generation and the
   same json test failed differently (the throw stopped propagating).

The landed design keeps the two concerns in separate fields:

- `src/codegen/functions/context.yo`: new
  `arm_value_deferred_drops : Option(ArrayList(AstExpr))` — a NON-BEGIN
  match arm's OWN `deferred_drop_expressions`, published for the claim only.
  `pending_deferred_drops` stays exactly as the unwind path expects it.
- `src/codegen/exprs/match.yo`, `generate_case_body` non-begin path: save /
  set / restore `arm_value_deferred_drops` around the arm body generation.
- `src/codegen/exprs/and_or.yo`, `_emit_drops_for_conditional_branch`: the
  claim source is `arm_value_deferred_drops` when set, else
  `pending_deferred_drops` (begin / function-body / SM publication — the
  original behavior); claimed drops are removed from the chosen list IN
  PLACE (drain, highest index first), because the arm-value publication is
  the SAME shared `ArrayList` as the ExprInfo's list the arm-tail flush
  (`match.yo`'s `generate_deferred_drop_expressions(body_expr, ...)`) later
  reads — a filtered copy would leave the claimed drop in it and double-drop.

With the arm-owned drops visible, the claim emits them in-branch; the later
site flushes skip them via the in-place removal (and the belt-and-suspenders
`short_circuit_handled_drop_var_names` one-shot guard).

## Verification

- the minimal repro compiles and runs (plain fn and effectful main)
- regression arm in `tests/short_circuit_str_literal_arg.test.yo`
- `tests/encoding/json.test.yo` 56/56 under the default ASan build (the
  double-free canary)
- string 267/267, regex 186/186, coverage, imm_string, dyn 9/9
- `check ./src` 262/262; codegen corpus 156/156 byte-identical
