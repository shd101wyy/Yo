# The verifier checks `assert(P)` but never assumes `P` afterwards

**Severity:** S3 — an `assert` used as an intermediate proof step (the Dafny/SPARK idiom) gives the solver no fact for later obligations, so a later goal that needs `P` stays unproven or is refuted.

**Status:** open. **Found:** 2026-11-04 by the theorem-proving direction audit (`plans/backlog/THEOREM_PROVING_DIRECTION.md` §4 item 1). Reproduced with yo 0.2.74 and pinned Z3 5.1.0.

## Reproducer

```yo
pragma(Pragma.Verify);
{ assert } :: import("std/assert");

f :: (fn(x : i32) -> i32)({
  assert(x > i32(5), "gt5");
  assert(x > i32(3), "gt3");
  x
});
```

```
refuted  fn@tmp/assertprobe.yo:3 [verify]
  fn@tmp/assertprobe.yo:3/assert: REFUTED  counter-example: x = #x00000005
  fn@tmp/assertprobe.yo:3/assert~2: REFUTED  counter-example: x = #x00000003
```

The first refutation is correct: nothing constrains `x`. The second is not. Every execution that reaches the second assert has passed the first (a failed assert aborts), so `x > 5` holds there and `x > 3` follows. `x = 3` cannot reach the second assert.

## Root cause

`src/verifier/vc.yo` (~L4621–L4632), the `assert` case of the expression walk, emits the obligation `Φ ⇒ P` and returns `true` without adding `P` to the path:

```yo ignore
if((head == "assert") && (n >= usize(1)), {
  p := _expr_term(ctx, args.get(usize(0)).unwrap());
  ...
  _emit(ctx, String.from("assert"), ArrayList(VcTerm).new(), &pt);
  Option(VcTerm).Some(Rc.new(VcTermNode.BoolLit(true)))
```

`plans/backlog/FORMAL_VERIFICATION.md` (~L733) specifies only the obligation ("`assert(P)` — obligation: prove `Φ ⇒ P`"). Dafny, SPARK and Why3 also assume `P` on the continuing path. That is sound, because a failed assert does not continue, and it is what makes an assert usable as a lemma-like step toward a harder goal.

## Fix direction

- After emitting the obligation, assume `P` on the current path.
- Amend FORMAL_VERIFICATION.md ~L733 to read "obligation, then assumed".
- **Trade-off to record:** after a refuted assert, later counter-examples are no longer independent of it (`plans/backlog/THEOREM_PROVING_NEXT.md` ~L225). The direction doc's open question 2 asks whether the agent loop wants a check-each-assert-in-isolation mode.
- **Test:** the reproducer becomes a fixture where the first assert is refuted and the second is proved, plus a fixture where `requires(x > i32(5))` makes both prove. Check the verify cache epoch, since the encoding changes.
