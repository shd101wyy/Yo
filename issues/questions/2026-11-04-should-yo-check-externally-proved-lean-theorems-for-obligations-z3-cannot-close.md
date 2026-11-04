# Should `yo verify` check externally proved Lean theorems for obligations Z3 cannot close?

**Kind:** design question — an open decision, not a defect. Filed 2026-11-04 from the theorem-proving direction audit (`plans/backlog/THEOREM_PROVING_DIRECTION.md`).

## The question

Suppose pinned Z3 returns `unknown` for an obligation. Should Yo export that obligation as a Lean 4 theorem, accept a committed Lean proof that a pinned Lean kernel re-checks on every run, and report the obligation as proved?

Today the answer is no, for four reasons:
- FORMAL_VERIFICATION §Non-goals says "Either Z3 discharges the VC or the author edits the annotations" (:97-99) and requires "one artifact, the `.yo` source" (:1900).
- THEOREM_PROVING_NEXT §9 forbids "importing external theorems as trusted axioms".
- D2 rules out a second user-facing solver.
- §8 parks ITP export as "export only", for a semantic-preservation-scale claim.

Facts as of `56cb88d26`:
- No corpus records an obligation that survives the in-language fixes. `tests/spec/fixtures/valid` has 335 of 336 proved, and the remaining 1 is refuted by design. `std/collections` emits 0 obligations. ADA_SPARK found the unproven set empty but notes that it "needs a harder corpus" (:48).
- The only class measured is induction. With the lemma deleted, `lemma_member_frame` comes back `unknown`. One reverted-hypothesis induction schema closes it in about 46 ms.
- Nonlinear bit-vector goals stay `unknown`. Lean would not help much there, because `bv_decide` trusts the compiler and is off the axiom whitelist.

## Options

**A. Build now.** Three phases:
- P0: a structured `VcDatatype`, a tagged `Ctor`, a source-name map.
- P1: `lean.yo`, a printer from `VcQuery`.
- P2: a pinned Lean (v4.35.0; the Linux asset is 594 MB), `lake comparator` in a bwrap sandbox, a `proved (lean)` column, and a `proved_by(lean(...))` builtin.

Cost:
- About 7–8 weeks, plus a monthly pin bump.
- The Lean elaborator becomes trusted for statements.
- The validations available are model replay and a `bv_decide` differential, and both are quantifier-free only. They miss the target class: quantified lemmas over ghost functions.
- Linux-only checking.
- Amendments to three binding texts plus D2.
- All of this for zero measured obligations.

**B. Gated: record the design and build nothing until a measurable trigger fires.** Cost: a doc edit. The risk is that the trigger never fires, because B4 has been unstarted since 2026-09-18. That is mitigated by scheduling B4 (direction doc §4 item 2).

**C. Never.** Delete the ITP route from §8. Cost: it closes off a route whose LLM economics are improving fast. Agentic Lean reached 96.2% end-to-end on CLEVER (arXiv 2605.23772, rev. 2026-10-30), and Vermilion left 9 of 40 Verus obligations to interactive Lean (2026-10-18). Under the no-backward-compatibility rule, the route would have to be re-argued from scratch later.

**D. A Lean semantics of Yo, i.e. a foundational VCG.** This would also remove `vc.yo` from the trusted base, where every recorded false proof originated. Cost: it is the semantic-preservation project, which is a binding non-goal.

## Recommendation

**B: gated, not built.** Exporting raw SMT-LIB is ruled out. Hand proofs would be tied to mangled encoder output and break with every encoder change (§8: "every encoder change re-certifies everything"). If the route opens, it exports lemma obligations from the `VcQuery` IR with source names.

Amend the TP_NEXT §8 "external audit oracle" row to read:

> An external audit oracle: a K semantics of Yo, or exporting **lemma** obligations (never path VCs, never SMT-LIB text) from the `VcQuery` IR to Lean 4 core with source names, every SMT under-specification a binder, and no `axiom`. Build nothing inside Yo until the trigger fires. Trigger: after E1, T1, T2-lite and T4a have landed, a corpus not built to pass (B4 evals or SELF_VERIFICATION M2/M3) records at least 10 distinct lemma obligations across at least 3 modules that stay `unproven` with Z3's `incomplete` reason (not a timeout) for two consecutive releases, and the CI cvc5 oracle does not close them; or a semantic-preservation-scale claim someone needs to make.

Append this sentence to the §9 bullet "Importing external theorems as trusted axioms":

> A Lean (or other ITP) proof of an exported obligation counts as an external theorem here even when a pinned kernel re-checks it on every run, because it changes what a green `--strict` means. It stays out until the §8 export trigger fires and one decision amends this bullet, FORMAL_VERIFICATION §Non-goals ("Z3 or annotations", "one artifact") and D2 together. If that happens, a Lean certificate reports in its own column, fails closed, and never elides a runtime guard.
