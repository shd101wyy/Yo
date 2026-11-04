# Theorem proving for Yo: the direction after the audits (2026-11-04)

**Status: PROPOSED 2026-11-04 — backlog.**

This document builds on the earlier audits and does not repeat them. They are `FORMAL_VERIFICATION.md` (FV), `THEOREM_PROVING_NEXT.md` (TP_NEXT), `../reference/MATCHING_LOGIC_RESEARCH.md`, `ATS_STYLE_INDEXED_TYPES.md`, `../ATS_LESSONS_BEYOND_INDEXED_TYPES.md`, `../SELF_VERIFICATION.md`, `BEND_LAWS_AND_AGENT_LOOP_LESSONS.md` (with its 2026-11-04 BendTT addendum), `K_FRAMEWORK_ENGINEERING_LESSONS.md`, `LEAN_ADOPTION_CANDIDATES.md`, `FSTAR_ADOPTION_CANDIDATES.md`, `DEPENDENT_TYPES_POSITION.md` and `ADA_SPARK_LESSONS.md`. This document adds three things: LLM-era evidence, the proof modes of Verus, Dafny, Lean and Why3, and a tested design for exporting obligations to Lean. It amends TP_NEXT §8–§10. Tree citations refer to `origin/develop` `56cb88d26`. Each fact carries its source, and *Judgment* marks an assessment.

## 1. Answer

The maintainer is right about the direction but has the wrong component in mind. In 2025–26 the strongest results from LLM provers come from a model working together with automation and a checker, not from either one alone (§3). *Judgment:* what a language needs is for properties written in the program's own language to be checked by a machine. A separate interactive prover is one way to get that, and the most expensive way. Yo already ships an auto-active theorem prover. `law` and lemmas (`ghost_fn` plus `ensures` plus `decreases`) are proved by induction through the self-call hypothesis (`src/verifier/vc.yo:6575`), and the pinned Z3 discharges the result. Yo should own that tier: generating obligations, a std lemma library, scoped proof annotations, a closed set of decision passes, and failure reports an agent can act on. It should not own a kernel, a tactic language or proof states. Lean should stay an export target behind a measurable trigger, not a planned escape hatch. The only failure class measured so far, induction, closes in-house in under 50 ms. A Lean route would add a 594 MB toolchain, a second trust story and a second artifact, and no measured obligation needs it. The draft position holds on tactics. It is redundant on "pull T1/T4 forward", because TP_NEXT §10 already orders them that way. It is premature on the Lean hatch.

## 2. What the prior audits decided, and what changed

| Doc | Verdict on theorem proving | Status on develop | Still binding? |
| --- | --- | --- | --- |
| FV | No ITP or tactics: "Either Z3 discharges the VC or the author edits the annotations" (:97-99). No second solver (:100-103). "One artifact" (:1900). | V1–V7 landed. Vacuity gate, `paranoid` and mutation gate still planned. | Yes. The rationale at :1896 is out of date (§4 item 8). |
| MATCHING_LOGIC | No matching-logic or K foundation. Z3 proof logs plus a checker parked at "V8+". | Stands | Yes |
| BEND + addendum | No hand-written proofs. Keep Z3. Z1–Z4 accepted, Z5 parked. "Every false proof … was a bug in `vc.yo`" (:822-824). | B0/B1 landed. B4 evals and Z1–Z4 not landed. | Yes |
| SELF_VERIFICATION | Proof assistants rejected. External oracle is a non-goal (D5, :622). | Only M0 (one module, two functions) | Yes |
| ATS_STYLE / ATS_LESSONS | "Z3 does not do induction". Std should ship frame lemmas. Tactics rejected (:227). | R1/R2 landed (#1057, #1075, #1106, #1107). Std lemmas never shipped, although A1 is marked Done. | Yes. A1 is still open in substance. |
| TP_NEXT | Four tiers. Tier 3 parked (§8). Tier 4 "never" (§9). | None of T1–T4 landed. `std/spec/` holds only `numeric.yo` and `refine.yo`. | Yes, as amended in §4 |
| K_FRAMEWORK | No proof-state viewers. Plans L1 (obligation ids) and L4 (clause coverage). | None landed | Yes |
| LEAN | Yo is "the Lean-blaster posture promoted". No importing of Lean theorems (§4:318). Re-encode from the Yo side (P1). | LE1–LE8 not landed | Yes |
| FSTAR | No tactic language (F12). Ambient SMTPat lemmas land with T1 (F3). Name the assumptions first (F4). | None landed | Yes. F3 contradicts LEAN §1. |
| DEPENDENT_TYPES | No universes, Eq types or dependent matching | Stands | Yes |
| ADA_SPARK | One user-facing solver; cvc5 only as a CI oracle. "364 of the 364 provable queries" proved, but the result "needs a harder corpus" (:21, :48). | None landed | Yes |

**What changed** (facts unless marked):

- None of the roughly 45 adoption items has landed. Every `src/verifier/` commit since 2026-10-08 is either a VBD migration or a soundness fix (#1574).
- This audit found three new gaps:
  - `assert(P)` is checked but not assumed afterwards. `vc.yo:4621-4632` emits the obligation and never pushes `P`. In a probe, `assert(x > 5); assert(x > 3)` refutes the second assert with `x = 3`.
  - Nonlinear bit-vector goals (`x*x >= 0`, `a*b <= a*c`) stay `unknown` after the 5M rlimit plus the 20× retry (about 44 s). The same goals over `Int` are `unsat` in 0.01–0.12 s. `VcSort` has no integer sort (`terms.yo:24-40`).
  - Deleting the lemma call from `lemma_member_frame.yo` gives `unknown` with reason `incomplete (theory array)`. Adding one induction-schema instance, with the hypothesis `member(xs,n,v) => member(out,n,v)` reverted into it, gives `unsat` in about 46 ms. A schema over the goal alone stays `unknown`.
- Unsat cores are empty. Production code calls only `q.assume` (`vc.yo:1367`), and `assume_named` (`terms.yo:283`) is used only in tests. This blocks LE2, L4 and the trust pins, as FSTAR F4 already recorded.
- *Judgment:* "0 unproven" is survivorship. `tests/spec/fixtures/valid` is required by construction to pass, so its 335/336 proved count says little (the 1 refuted is by design, `refine_literal.yo:14`). `std/collections` emits 0 obligations, because 9 of its 13 functions are `assumed()`.

## 3. The LLM-era evidence

| Result | Source (date) |
| --- | --- |
| Same specs in three languages: Dafny 82.2%, Verus 44.3%, Lean 26.8% (union over models). On APPS, Verus 38.8% vs Lean 38.5%. | Vericoding, [arXiv 2509.22908](https://arxiv.org/abs/2509.22908) (2025-09-26) |
| GPT-5.3 Codex: Dafny 49.4%, Verus 14.3%, Lean 23.4%. Lean errors frequently cite lemmas that do not exist. | AlgoVeri, [arXiv 2602.09464v2](https://arxiv.org/html/2602.09464v2) (2026-06-03) |
| Lean proof generation: o3 4.9% at one trial. o4-mini goes from 7.41% to 22.22% on VERINA-A after 64 feedback rounds. | VERINA, [arXiv 2505.23135v3](https://arxiv.org/abs/2505.23135) |
| Agentic Lean on CLEVER: 92.3% of implementations certified, 96.2% end-to-end on entries with sound premises. About 80 of 161 reference specs are arguably wrong. | [arXiv 2605.23772](https://arxiv.org/abs/2605.23772) (rev. 2026-10-30) |
| Competition math: Seed-Prover 1.5 solves 580/660 PutnamBench problems. AlphaProof is in *Nature*. | [arXiv 2512.17260](https://arxiv.org/abs/2512.17260) (2025-12); [doi:10.1038/s41586-025-09833-y](https://www.nature.com/articles/s41586-025-09833-y) (2025-11-12) |
| LLM plus automation beats either alone. Thor: 39% → 57%. seL4: 77.6% vs 40.5% for Sledgehammer alone. CoqPilot: 51% vs 39%. | [arXiv 2205.10893](https://arxiv.org/abs/2205.10893); [2603.19715](https://arxiv.org/html/2603.19715); [2410.19605](https://arxiv.org/pdf/2410.19605) |
| Verus → Lean (Vermilion): 31 of 40 merge-sort obligations automatic, 9 interactive | [proofsandintuitions.net](https://proofsandintuitions.net/2026/10/18/vermilion-experiment-lean-backend-verus/) (2026-10-18) |
| Lean kernel hunt: 4 kernel-logic bugs and 2 runtime bugs, fixed in v4.33.1 | [de Moura postmortem](https://leodemoura.github.io/blog/2026-8-24-postmortem-for-the-kernel-soundness-bug-hunt/) (2026-08-24) |
| Lean itself is moving toward auto-active verification (`vcgen`, `grind` with E-matching). Solvers that "return a binary pass or fail" give AI nothing to learn from. | [de Moura](https://leodemoura.github.io/blog/2026-2-28-when-ai-writes-the-worlds-software-who-verifies-it/) (2026-02-28; follow-up post 2026-03-14) |

*Judgment:*

- FV:1896's rationale ("global proof-state reasoning is exactly what LLMs are bad at") is now contradicted by the evidence. The non-goal still stands, but for other reasons: cost, trust, determinism and corpus.
- "Auto-active beats tactics" is really "Dafny beats everything", and training data confounds that result. Verus vs Lean is mixed.
- The training-data argument applies to Yo's own dialect too, which has no corpus. The hedge is building one (the lemma library, B4, examples), not choosing a different proof style.
- De Moura's "binary pass/fail" critique applies to Yo's `Unproven(reason : String)` (`driver.yo:89`). Yo already returns counterexamples on refutation (`:87`).

## 4. The recommended path, ranked

1. **E1: `assert` assumes what it proved.** Push `P` onto the path after it is emitted.
   - **Effort:** XS. **Gate:** now.
   - **Bug record:** filed as `issues/2026-11-04-assert-is-not-assumed-after-it-is-proved.md` (S3), with the probe as its test; the fix amends FV:733.
   - **Trade-off to state:** after a refuted assert, later counterexamples are no longer independent (TP_NEXT:225-226).
   - **TP_NEXT:** add a new §10 row ahead of T1. It is the precondition for T3's cut rule (:229).

   ```yo ignore
   f :: (fn(x : i32) -> i32)({
     assert(x > i32(5));
     assert(x > i32(3));   // today: REFUTED x = 3, because the first assert is not assumed
     x
   });
   ```

2. **Schedule B4 evals before T1** (BEND :664-700; the scoring and cheat rules already exist).
   - **Effort:** about 1 week. **Gate:** now.
   - **Why first:** T2, F15 and the Lean trigger all wait on B4, which has been unstarted since 2026-09-18.
   - **TP_NEXT:** make B4 a scheduled §10 dependency, not a trigger.

3. **Decide lemma scoping, then build T1, T4a/T4b, F4 and LE1 together.**
   - **Scoping recommendation:** explicit opt-in per function or module, plus one curated default group. Verus does this with [`broadcast use`](https://verus-lang.github.io/verus/guide/broadcast_proof.html) and `group_vstd_default`. It refines F3's implicit import scope and resolves LEAN §1 against F3.
   - **Sequencing:** F4 (named assumptions) comes before T4a.
   - **Effort:** 4–5 weeks. **Gate:** the scoping decision.
   - **TP_NEXT §3:** delete the claim "no new builtin". T4b is seed-gated.

4. **E2: scoped proof blocks, `assert_by(P, { … })`.** Facts from the block are dropped except `P`, following Dafny §8.17 and Verus `assert … by`.
   - **Why:** facts currently build up along straight-line blocks (guards keep `guard ==> fact`, `vc.yo:2986-3005`).
   - **Effort:** S. Ship it with T1. It is a new builtin (Generation A/B).

5. **E3: an integer-lifted isolated assertion**, which is the first slice of ADA item 5 (MathInt).
   - **What it does:** run one isolated `Int` query plus in-range obligations, then assume the bit-vector form.
   - **Design constraints:** design it alongside ADA item 1 (`int_to_bv`) and against the `Int` terms queries already contain (`terms.yo:150-154`). Weigh it against FSTAR F12's canonicalization pass.
   - **Effort:** M. Follow it with E6, an arithmetic lemma family on the Dafny `Std/Arithmetic` / vstd layout.

   ```yo ignore
   ghost(assert_by(count(ys, v) == (count(xs, v) + i64(1)), { count_push_frame(xs, x, v); }));
   ghost(assert_int((w * h1) <= (w * h2), requires(w >= i64(0), h1 <= h2, h2 <= i64(1000000))));
   ```

6. **T2-lite: auto-induction scoped to lemmas**, as Dafny does by default ([Leino, VMCAI 2012](https://link.springer.com/chapter/10.1007/978-3-642-27940-9_21)).
   - **TP_NEXT §4 amendment:** the schema must revert the `requires` that mention the recursive function. "Instances at strictly smaller measures" alone is not enough (the M3/M4 measurement above).
   - **Gate:** unchanged (measured repetition), but a spike over the existing lemma fixtures is allowed now.

7. **E7 `assert_forall` and T3 `calc`**, both after E1.

8. **Rewrite the rationale for the tactic non-goal.** Replace it at FV:1896-1897 and at its copy in LEAN:316 (which cites a stale line). The new grounds are cost, trust, determinism and the measured benefit of LLM plus automation. Docs only.

9. **Lean export: amend the TP_NEXT §8 row only** (see the question doc). This is the verdict on the lean-export design:
   - **Do not adopt it as a P0/P1/P2 track.** Its theory table and its granularity rule (lemmas only, not path VCs) are recorded as design constraints.
   - **What gets built anyway:** the source-name map and stable obligation ids (K L1), because T4a and `--explain` need them.
   - **What waits for the trigger:** structured `VcDatatype` and a tagged `Ctor`.

## 5. What stays a non-goal

- **A tactic language inside Yo.** The operational test: a mechanism is a tactic if it exposes a proof state, has proof-step combinators, or lets users define proof procedures. A choice from a closed set of whole-obligation passes is an annotation. E1–E7 pass this test.
- **Why3-style transformations and Meta-F\*.** They fail the test above.
- **A second user-facing prover.** This covers Lean as a discharger, Singular `integer_ring`, and Vampire (D2).
- **Compiler-trusting decision procedures.** `native_decide` and `bv_decide`, which rely on `ofReduceBool`, stay out of the trusted path.
- **Mathlib.**
- **Semantic preservation, and a self-hosted prover.**
- **Importing external theorems** (TP_NEXT §9), except as amended by the question doc.

## 6. Open questions

1. Lemma scoping: should it be explicit opt-in or import-ambient (LEAN §1 vs FSTAR F3)?
2. Is E1's loss of independent counterexamples acceptable, or should the agent loop get a mode that checks each assert in isolation?
3. Should E3 introduce an `IntS` sort ahead of ADA item 1, or wait for it?
4. If Lean is ever un-parked, should it target what Z3 cannot state (verified-unsafe std, semantic preservation) rather than collect leftover unknowns?
5. Who owns B4, and when does it start?

## Low-level references (the maintainer's follow-up question)

*Audit of 2026-11-04 against `origin/develop` 56cb88d26. Every row, number and quote below comes from a cited primary source. Rankings and effort/value calls are judgment and are marked **(J)**.*

### 1. Low-level languages and tools with theorem-prover support (ranked by usefulness to Yo, J)

| # | Name | How proofs work | Trust base | Industrial evidence | Closest Yo analogue | Audited by Yo? |
|---|---|---|---|---|---|---|
| 1 | **Frama-C** (ACSL, WP, E-ACSL) | Weakest preconditions → Why3 → SMT solvers; Coq or the in-tool TIP tactic engine handles what is left | WP, Why3, the solvers, the memory model | JavaCard VM: 85,000 goals, 800+ scripts, EAL6–7 ([TACAS 2024](https://allan-blanchard.fr/publis/cbdk_tacas_2024.pdf)) | `yo verify` plus runtime contracts | No |
| 2 | **SPARK** | Why3 + SMT; ghost lemmas; Coq only for AdaCore's lemma library | GNATprove, Why3, the solvers | Long-standing industrial use | `ghost_fn` lemmas, AoRTE | `ADA_SPARK_LESSONS.md` |
| 3 | **CN** + Fulminate (C) | Decidable SMT; anything outside it is a `lemma` exported to Rocq, or to Lean since 2026-09-01 ([rems-project/cn](https://github.com/rems-project/cn)) | Cerberus, SMT, the ITP | pKVM buddy allocator ([POPL 2023](https://doi.org/10.1145/3571194)) | `refine`, `assume_init`'s provenance check | No |
| 4 | **Low\*/KaRaMeL**, HACL\*, EverParse | F\* + Z3; proofs are erased; the C is the artifact | F\*, Z3, λow\* metatheory, KaRaMeL, cc | HACL\* in CPython, NSS; Hyper-V parsers ([PLDI 2022](https://fstar-lang.org/papers/EverParse3D.pdf)) | verify-once generics, guard elision | Partly: `FSTAR_ADOPTION_CANDIDATES.md` F14 (:648-657) |
| 5 | **Aeneas**/Charon (Rust → Lean) | Borrows become values; a returned `&mut` gets a backward function | Charon, Aeneas, Lean | SymCrypt: 16,680 Rust lines, 237,160 Lean lines ([arXiv 2609.15648](https://arxiv.org/html/2609.15648v1)) | the VC walk's `&mut` state-passing | No |
| 6 | **VeriFast** | Symbolic heap of separation-logic chunks + Z3 | VeriFast (unverified) | Rust std challenges 5 and 19 ([arXiv 2606.17374](https://arxiv.org/abs/2606.17374)) | none | No |
| 7 | **Creusot**, Prusti/Viper | Rust → Why3 or Viper, then SMT; prophecies, permissions | translator + SMT | research | `seq_of` + `assumed()` | Parallel Verus audit |
| 8 | **hax**, **Cogent** | Translation to F\*/Rocq/Lean; Cogent proves C refinement in Isabelle | translator; Cogent's is proved | ext2/BilbyFs on seL4 | none | No |
| 9 | RefinedC/RefinedRust, seL4/AutoCorres, VST, Bedrock2 | Coq/Iris or Isabelle, foundational | the ITP kernel + a formal semantics | seL4 | none | Tier 4 / `SELF_VERIFICATION.md:49` |

**Fact: interactive provers close very few goals.**
- Moving Coq lemmas to lemma functions cut the Coq goals to 1, 1 and 0 across three case studies ([NFM 2019](https://allan-blanchard.fr/publis/blk_nfm_2019.pdf)).
- On the JCVM, the ITP scripts cover about 0.9% of goals, and they "often have to be recreated" after edits.

**Fact: interactive proof is expensive.**
- SymCrypt: about 7.5 Lean proof lines per Rust line.
- CN on pKVM: 165 lines of lemma statements needed 1,219 lines of Coq.
- VeriFast's verified RawVec is 3.5× the size of the original.

### 2. Lessons that change or sharpen Yo's direction

**R1. Prove the raw buffer behind `ArrayList` instead of assuming it** (CN's `W`/`RW` cells, `LowStar.Buffer`'s `as_seq`; F14 did not assess the latter).
- Widen `List_<elem>_mk` (`src/verifier/vc.yo:353-365`) with `cap`.
- Resolve `self._ptr.add(i)` syntactically to `Cell(self, i)`, with no proof search.
- Reads need `i < len`; writes need `i < cap`.
- `_buf_resize` keeps one small `assumed()` clause.

```yo ignore
swap : (fn(self : &mut Self, i : usize, j : usize, requires(i < self.len(), j < self.len()),
  ensures(self(i) == old(self)(j), self(j) == old(self)(i))) -> unit)(/* body unchanged, now proved */);
```

- Effort: 2–4 weeks; elements restricted to the integer/bool subset.
- Gate: T1 starts, because T1 needs element-level clauses that `array_list.yo:741-742` lacks today.
- (J) `issues/fixed/verifier-std-mutators-without-old-self-left-the-list-unchanged.md` may already count as the parked trigger. That reading is the maintainer's call.

**R2. Lower bounded quantifiers into runtime checks** (E-ACSL, Fulminate).
- Today a quantified clause is proof-only (`src/evaluator/builtins/contracts.yo:2894-2896`).
- A `forall` guarded by an integer range would lower to a loop of asserts. An unguarded one stays proof-only and is reported as such.

```yo ignore
requires(forall(i : usize, (i < n) ==> (a(i) == b(i))))   // => entry loop of assert(a(i) == b(i))
```

- Effort: M.
- Gate: after `ADA_SPARK_LESSONS.md` §4 #1.

**R3. Release contracts for `-> &mut` projections** (Aeneas backward functions, Creusot's `^self`).
- Assume the contract where the borrow's last use ends, over the places in the returned origin.
- Origins make that grouping a plain read of the signature.

```yo ignore
index_mut : (fn(self : &mut Self, idx : usize,
  released(r, seq_of(self) == seq_update(seq_of(old(self)), idx, r.*))) -> (r : &mut(T, self)))(...)
```

- Effort: M. The spelling is open.
- Gate: the first verified caller of `index_mut` or `walk_elem` (`array_list.yo:1082`, `:1350`), or N3.

**R4. If an ITP hatch is ever unparked, follow CN and Frama-C, not SPARK.**
- Export lemma statements, not VCs.
- Key each proof on the position-free query hash (`encode.yo:407`), not on obligation names, which carry positions (`vc.yo:1246-1257`).
- An obsolete proof fails the run. A distinct outcome `proved-external` is never plain `ok` (`driver.yo:541-551`).
- This needs an amendment to `THEOREM_PROVING_NEXT.md:358-363`.
- (J) The audits disagree on what to export:
  - One prefers exporting the program from the typed AST, as a diverse oracle that would have caught the early-`return` gap.
  - The other prefers exporting the SMT-LIB obligations, to close `unknown` lemmas.
- Reconciliation (J): program export is for cross-checking the verifier; lemma export is for proving. Both stay parked, and `:301` should name both.
- Effort: L for either.

**R5. Treat a Z3 pin bump as a migration** (F\* [#3631](https://github.com/FStarLang/FStar/pull/3631), [#3880](https://github.com/FStarLang/FStar/pull/3880), [#4654](https://github.com/FStarLang/FStar/pull/4654)).
- Diff the verdicts between the old and new pins.
- Keep the old pin installable during the transition.
- Effort: S.
- Gate: the next Z3 bump.

Cheap docs follow-ups (J, XS each):
- Write the "functional reading" down as the subset's soundness statement (Aeneas, hax).
- Record the cost figures above in `THEOREM_PROVING_NEXT.md` T1 and §9.

### 3. Do not adopt

- **In-tool tactic engines** (Frama-C TIP and `@strategy`, Lithium): tier 4 is a binding non-goal (`THEOREM_PROVING_NEXT.md:339-344`).
- **Separation-logic chunk heaps** (VeriFast, the CN engine): a second reasoning engine beside Z3.
  - Viper's permission masks are unnecessary, because `&` is frozen and `&mut` is exclusive.
- **Coq at the VC level**: the goals are written in the encoding and tied to code positions, so only experts can prove them and edits break them (Blanchard 2019, the JCVM).
- **SPARK's fail-open replay**: it is "still marked as proved" when the prover is missing. Yo's certificate rule fails closed (`:324-326`).
- **Lean as the primary proof path** (the SymCrypt model): about 14 Lean lines per source line contradicts the agent-loop thesis (J).
- **A verified-compiler ceiling** (CompCert, Bedrock2, seL4): `SELF_VERIFICATION.md:49`.
- **Cogent's restrictions** (no recursion, no loops): Yo has a subset discipline instead.
- **Fulminate's shadow init-bitmap**: low value, since ASan and the canaries already cover those bugs (J).
