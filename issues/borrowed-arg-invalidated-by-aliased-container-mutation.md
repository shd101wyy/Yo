# Borrowed argument invalidated by aliased container mutation (design gap, OPEN)

**Found 2026-08-06** while auditing `docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`
for soundness. This is a **calling-convention design gap**, not a localized codegen bug —
filed for a design decision, not silently patched.

## The hole

Function parameters borrow (+0). A field projection passed as an argument therefore hands
the callee a pointer the CALLER's structure owns. If that field is reassigned while the
borrow is live, the old value is dropped; whether the borrow dangles depends on where the
old-value drop lands:

- **Straight-line code is safe by accident of drop placement**: field reassignment saves
  the old value into a temp and defers its drop to scope end, so a borrowed alias stays
  valid through the function body (verified in emitted C: `poke` drops the saved old
  `w->b` at function end, after all uses).
- **Loops are NOT safe**: the old-value drop cannot be deferred across iterations, so it
  is emitted inside the loop.

Deterministic reproducer (macOS, `--release`, no sanitizer):

```rust
Wrap :: ref(struct(b : Box(i32)));

poke_loop :: (fn(w : Wrap, borrowed : Box(i32)) -> unit)({
  (i : i32) = 0;
  while(runtime(i < 2), {
    w.b = box(100 + i);          // iteration 1 drops the old box → borrowed dangles
    i = (i + 1);
  });
  println(`borrowed: ${borrowed.*}`);   // UAF read
});

main :: (fn() -> unit)({
  w := Wrap(b : box(42));
  poke_loop(w, w.b);             // borrowed aliases w.b, +0
});
```

Prints `borrowed: 101` — the freed 42-box's slot was recycled by `box(101)`, and the
borrowed parameter silently reads a _different, newer allocation_. Under a hostile heap
layout this is an arbitrary use-after-free. It contradicts the design doc's "zero risk of
memory safety bugs" claim.

Same-scope variant of the same class: a `match` binding borrows the scrutinee's payload
while the arm reassigns the scrutinee. Probed safe today (drop deferral again), but the
safety is placement luck, not a rule.

## Why this is a design decision

The reference languages solve it structurally:

- **Swift**: arguments are passed +0 but _exclusivity enforcement_ (compile-time where
  provable, runtime `Fatal access conflict` otherwise) forbids overlapping
  mutable/immutable access to the same storage.
- **Lobster**: global ownership/borrow inference decides per call site whether a borrow is
  safe; unsafe ones get a +1.

Options for Yo, roughly in increasing cost:

1. **Dup projection arguments** (+1/-1 around the call) whenever the callee (or anything it
   calls) _may_ mutate — conservatively: whenever the argument is a projection of a
   mutable structure and the callee takes any mutable handle on that structure (same root
   passed twice, as in the reproducer). The double-pass shape `f(w, w.b)` is syntactically
   detectable at the call site.
2. Dup ALL RC-typed projection arguments (+1/-1 per call) — simple, sound, measurable RC
   traffic cost; Phase-1.5-style cancellation can claw back the unconditional cases.
3. Exclusivity checking (Swift's model) — reject `f(w, w.b)` when `f` can mutate `w`
   through the first parameter; needs a mutation summary per function.
4. Full borrow inference (Lobster's model) — largest change, best codegen.

## DECISION (2026-08-06): Lobster's direction, staged

Swift's exclusivity is rejected: its general case is **dynamic** (per-storage access
markers + a runtime trap), which needs new runtime metadata and codegen instrumentation
and aborts at runtime — off-brand for a compile-time-RC language. Lobster's
"infer-what's-safe, insert RC ops where inference fails" matches the design doc's own
philosophy (safe by default, cancel what is provably redundant), and Yo is a
whole-program compiler with per-call-site specialization, so callee summaries are
computable where Lobster needs them.

Staged plan (each stage sound on its own):

- **Stage 0**: dup RC-typed **projection** arguments to borrowing parameters (plain
  locals stay +0 — the caller's binding keeps them alive for the call). Implement in
  `evaluateArgs` (`src/evaluator/calls/helper.ts`) via the existing
  `setExprAsNeedsToCallDup` + statement-temp drop machinery. The new dups must be exempt
  from dup/drop pair cancellation unless the callee is proven non-invalidating
  (precedent: the collector's `io.async` skip).
- **Stage 1**: per-specialization mutation summaries ("may mutate RC container storage
  reachable from params or globals?"), computed bottom-up — natural home:
  `src/evaluator/effects/`. Read-only callees (the vast majority) get the +0 borrow back.
- **Stage 2** (optional): escape summaries + call-site refinements (same-root-twice).

Benchmarks that decide whether Stage 1 must land together with Stage 0: stage-1
self-compile wall time (~6 min baseline) and the fast suite (~5.5 min baseline).

Sequencing: lands AFTER the 2026-08-06 CI-gating change (leak fix + branch-dup
classification) is green in CI, as its own change.

## Interim

- The loop-traversal optimizer's mutation guard
  (`issues/fixed/loop-traversal-borrow-chain-mutation-uaf.md`) closes the same class
  _inside_ the traversal optimization, where the compiler itself was removing the
  protective RC ops.
- The design doc's Trade-offs section now names this hole instead of claiming zero risk
  (`docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`, both languages).

## Reproducer status

`src/tests/fixme.yo` variants, 2026-08-06 session; not yet a checked-in failing test
(there is nothing to assert until the semantics decision is made — the current behavior is
UB that happens to print recycled memory).
