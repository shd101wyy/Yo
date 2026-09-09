# Matching Logic — research assessment for Yo's formal verification campaign

> **Status: DECISION RECORD (2026-09-09) — assessed and declined.**
> Investigation into whether Yo's FORMAL_VERIFICATION campaign
> ([`backlog/FORMAL_VERIFICATION.md`](../backlog/FORMAL_VERIFICATION.md),
> V1–V3 merged at the time of writing) should utilize
> Matching Logic — the logic underlying the K Framework — as foundation,
> substrate, or tooling.
>
> **Conclusion up front: do NOT adopt matching logic as the verifier's
> foundation. The Dafny/Boogie-shape, Z3-direct architecture (decisions
> D1/D2/D4/D5) stands.** Matching logic earns five specific borrowings
> (§7) and two explicitly parked ideas (§8). Everything below supports
> that verdict.

---

## Table of contents

1. [What matching logic is](#1-what-matching-logic-is)
2. [How the K Framework uses it](#2-how-the-k-framework-uses-it)
3. [The Z3 relationship — the decisive fact](#3-the-z3-relationship--the-decisive-fact)
4. [Ecosystem and maturity audit](#4-ecosystem-and-maturity-audit)
5. [Production-scale evidence](#5-production-scale-evidence)
6. [Assessment for Yo — the three utilization options](#6-assessment-for-yo--the-three-utilization-options)
7. [What Yo should actually take from it](#7-what-yo-should-actually-take-from-it)
8. [Explicitly parked ideas](#8-explicitly-parked-ideas)
9. [References](#9-references)

---

## 1. What matching logic is

Matching logic (Roșu, LMCS 2017; finalized as **matching μ-logic** with
Xiaohong Chen, LICS 2019) is a *unifying* logic for programming languages,
specification, and verification. Its official home is
<https://www.matching-logic.org/>; it is the logical foundation of the
K Framework.

**Syntax.** Parametric on a many-sorted signature Σ. Two disjoint variable
families — **element variables** `x, y, …` (denote one element) and **set
variables** `X, Y, …` (denote sets). Patterns:

```text
φ ::= x | X | σ(φ₁, …, φₙ) | ⊥ | φ → φ' | ∃x · φ | μX · φ   (X positive in φ)
```

with `¬φ ≡ φ→⊥`, `⊤`, `∨`, `∧`, `∀`, and greatest fixpoint `ν` derived.

**Semantics.** A pattern of sort `s` denotes a **set of elements** of the
carrier `Mₛ` (not a truth value) — "the configurations that match it":
- `|x| = {ρ(x)}`; `|X| = ρ(X)`; `|⊥| = ∅`;
- `|φ→ψ| = Mₛ \ (|φ| \ |ψ|)` (so `∨` is union, `∧` is intersection);
- `|σ(φ₁,…,φₙ)|` is pointwise-lifted through the symbol: crucially, each
  symbol is interpreted as `σ_M : Mₛ₁ × … × Mₛₙ → 𝒫(Mₛ)` — a **power-set
  codomain**;
- `|∃x·φ|` unions over valuations of `x`; `|μX·φ|` is the least fixpoint
  (Knaster–Tarski).

The power-set codomain is the whole trick: it lets **terms and formulas be
the same thing**. A symbol can act as a constructor (`σ(a,b)` = `{the value}`)
or as a predicate (`σ(x)` = `{x : x satisfies σ}`) with one interpretation
rule.

**What it captures, as theories/fragments** (per matching-logic.org):
first-order logic with equality and fixpoints, modal μ-logic / hybrid
logic, LTL/CTL, dynamic logic, **Hoare logic**, **reachability logic**,
**separation logic incl. recursive predicate definitions**, (order-sorted)
equational and rewriting logic, λ-calculus and pure type systems. The
internalization results show matching logic can define its own semantics
inside itself.

**Proof system.** Hilbert-style. LMCS 2017 gives system **P**, sound and
complete for theories that provide definedness symbols (from which equality
and membership are derived). LICS 2019 gives system **H**, sound and
(locally) complete for *fixpoint-free* matching logic over **all**
theories, and extends it to matching μ-logic with the Knaster–Tarski
rule — that μ-extension is proved **sound only**; no complete proof system
for the μ-fragment is claimed (none can exist: the logic defines the
standard model of the naturals). The fixpoint rule is not syntax-driven,
which is why Chen et al.'s OOPSLA 2020 *Towards a Unified Proof Framework
for Automated Fixpoint Reasoning Using Matching Logic* proposes an
automation-friendlier alternative system. Theory work continues (Fiedler's
2022 thesis on completeness conditions for system H; Leuștean & Trufaș's
2025 Tarski-style axiomatization; Coq mechanizations, ICTAC 2023) but
none of it changes the tooling picture in §3–§4.

**One disambiguation that will bite Yo docs:** matching-logic *patterns*
(formulas denoting sets) are **completely unrelated** to SMT-LIB
`:pattern` annotations (E-matching instantiation triggers). The two share
the word "pattern" and nothing else. Yo's V5 quantifier encoding
(FORMAL_VERIFICATION.md Phase V5, task 2) uses the SMT sense; anyone reading both
literatures will collide on the term.

## 2. How the K Framework uses it

K's pitch: write a language's formal semantics **once** — as rewrite rules
`lhs ⇒ rhs` over *configuration* patterns (algebraic structures holding
code, environment, heap, buffers) — and derive **all** tools from it:
interpreter, parser, symbolic executor, model checker, deductive verifier.
The semantics plays both the operational role (execution) and the axiomatic
role (proofs) with no separate soundness proof connecting them.

The execution pipeline in current K (v6/v7 era):

- **LLVM backend** — fast *concrete* execution only; rewrites concrete
  configurations.
- **Haskell backend** (Kore; basis redesigned on matching μ-logic) —
  *symbolic* execution: rewriting via **unification** ("two-way pattern
  matching", both the configuration and the rule LHS may contain
  variables), producing **matching-logic patterns** — disjunctions of
  constrained configurations using `#And`/`#Or`/`#Equals`, distinct from
  the language's own booleans.
- **Booster** (Haskell — `hs-backend-booster`, since folded into
  `haskell-backend` and archived 2025-10) — a simplified, faster rewrite
  engine that runs in front of the full Haskell backend and falls back to
  it for the hard steps.
- **Z3** — periodically checks accumulated path conditions for
  *feasibility* and trims infeasible branches. Stock pinned Z3; see §3.
- **kprove** — deductive verification: user states **reachability claims**
  `φ ⇒ φ'` (initial → final pattern), discharged by *symbolic execution to
  a matching problem* plus **circular (coinductive) reasoning** — a claim
  may be used as an axiom while proving itself, which is how loops and
  recursion are verified without separate Hoare-style invariants. The hard
  step, repeatedly, is the **implication check** between the symbolic
  result and the claim's RHS — see §3.

## 3. The Z3 relationship — the decisive fact

**There is no solver that decides matching logic, and no custom
Z3-with-matching-logic fork.** We verified: the K project pins **stock
upstream Z3** (the K README — latest release v7.1.337, 2026-06-18 — requires
Z3 4.12.1 and warns that other versions "are known to have bugs and
performance regressions likely to cause issues in the K test suite"; the
archived proof-generation work pinned 4.8.10). What bridges ML to Z3:

1. **Fragment translation.** The **fixpoint-free fragment** of matching
   logic converts to FOL with equality (patterns become unary predicates
   over the element sort; symbol application becomes guarded quantification
   — this is the `ml2fol` prototype in
   [kframework/matching-logic-prover](https://github.com/kframework/matching-logic-prover),
   which literally emits SMT-LIB 2).
2. **Division of labor.** In practice K does *not* send whole patterns to
   Z3. Structural matching (unification modulo the semantics' equational
   theory) is done by the Haskell backend itself; Z3 sees only the
   *constraint* part of path conditions (integer/boolean side conditions) —
   decidable theories, where it excels.
3. **Implication checks are the incomplete part.** Full ML pattern
   implication is undecidable; in practice kprove proofs die on **stuck
   symbolic execution** — unsimplified function symbols, unresolved
   `#Ceil`/definedness side conditions, an implication the backend cannot
   close structurally — with opaque failures. Z3 mostly sees
   quantifier-free constraints and is rarely the bottleneck. This is the
   classic K pain point.

**The consequence for Yo:** a verifier that reasons over general matching
logic must implement unification-modulo-theory and still translate to
SMT-LIB to discharge anything — i.e., it rebuilds the entire Kore
Haskell-backend machinery *and* keeps the FOL translation. Yo's plan
already is the FOL/SMT-LIB step, driven directly off the evaluator's
output. Matching logic would sit as an intermediate representation that
adds reasoning structure the solver cannot consume natively and that no
off-the-shelf prover discharges. It is a *logic of definition*, not a
logic of automation.

## 4. Ecosystem and maturity audit

GitHub state, checked 2026-09-09:

| Artifact | What it is | State |
| --- | --- | --- |
| [runtimeverification/k](https://github.com/runtimeverification/k) | The K Framework tools (LLVM + Haskell backends, kprove) | **Alive** — latest release v7.1.337 (2026-06-18); 586 stars |
| [kframework/matching-logic-prover](https://github.com/kframework/matching-logic-prover) | Standalone ML prover/checker written in K; `ml2fol` ML→SMT-LIB prototype | **Dormant** — last push 2021-04; 15 stars; README minimal |
| [runtimeverification/proof-generation](https://github.com/runtimeverification/proof-generation) | Metamath formalization of ML + proof-certificate generation (CAV 2021 line) | **Archived** 2024-02-15; automated generation covered *concrete* rewriting only; proof objects were large for small programs |
| [Pi Squared — Proof of Proof](https://docs.pi2.network/math-proof-checker) | The certificate line's successor: matching-logic (Metamath) proofs checked by a few-hundred-line checker running inside zkVMs, for verifiable computing / settlement | **Alive**, commercial (RV spin-off); a blockchain product, not a compiler-facing prover |
| matching-logic.org / FSL Illinois papers | Theory (LMCS 2017, LICS 2019 μ-logic, OOPSLA 2020/2023, CAV 2021, Coq mechanization ICTAC 2023, new axiomatization arXiv 2025) | Active literature; the unification results are solid math |
| Kontrol / verified-smart-contracts | RV's productized K-based verification (Foundry-integrated) | Commercial use, Ethereum ecosystem focus |

Reading: the **theory** is mature, respected and still active; the
**tooling around ML-as-a-logic** is research-grade (the prover), retired
(the Metamath certificate generator), or moved into a commercial product
with a different target (Pi Squared's zkVM proof checking). **None of it
is a reusable off-the-shelf prover a compiler can call.** Everything
production-grade in the K world discharges constraints by translating down
to Z3 — exactly the architecture decision Yo already made.

## 5. Production-scale evidence

The flagship case study: **end-to-end verification of the Ethereum 2.0
deposit contract** (Park, Zhang, Roșu — CAV 2020; ~100 LOC of Vyper /
~3,000 EVM instructions):

- **Effort: 7 person-weeks** — 2 on the algorithm-level proof, 5 at
  bytecode level. The bytecode specification was **~1,000 LOC plus 200 LOC
  of lemmas** — a ~10:1 spec-to-code ratio, plus ~20% re-verification
  overhead after fixes (specs anchored on hardcoded program-counter
  values broke on recompile).
- **What it bought:** full functional correctness of the *deployed
  bytecode* (compiler excluded from the trust base — the K semantics of
  EVM, not the Vyper compiler, defines meaning), negative behaviors
  (malformed calldata), and gas-liveness. It found **four real bug
  classes** manual review had missed — including one that risked fund
  loss — plus several Vyper compiler bugs.
- **Stated gaps:** specs are hard to write (the paper's own future work:
  "developers should ideally write them"); re-verification automation;
  the late-discovered gap between informal intent and formal spec.

This is the calibration point: K/matching logic delivers **ultimate
assurance for security-critical code at research-project cost**. Yo's
verifier targets **cheap, incremental assurance for everyday LLM-authored
code** (AoRTE on unannotated functions, milliseconds-per-obligation
budgets, clause-by-clause adoption). These are different points on the
cost/assurance curve, and Yo's plan (Dafny/SPARK model) is the right one
for its design center. A 10:1 spec ratio and opaque implication failures
are precisely what an LLM authoring loop cannot iterate against.

## 6. Assessment for Yo — the three utilization options

### Option A — adopt ML as the verifier's logical foundation ❌

Replace/augment `src/verifier/terms.yo` with matching-logic patterns.

- *What it buys:* one uniform term/formula language; recursive μ-predicates
  for future heap/RC reasoning; theoretically clean definitional extension
  (add a construct = add axioms, no new soundness story per feature).
- *What it costs:* Yo must implement unification modulo its definitional
  theory and ML implication checking — the multi-year core of K's Haskell
  backend (Kore). The only reusable standalone artifact
  (matching-logic-prover) has been dormant since 2021. No solver natively
  consumes ML, so every discharge still funnels through the FOL/SMT-LIB
  translation Yo already emits directly. Net: strictly more machinery, zero
  additional automated proving power.
- *Also:* K's central value proposition — "define the semantics once, get
  interpreter + verifier + tools for free" — does not transfer. **Yo already
  has its semantics: the evaluator and the C codegen.** A language-semantics
  framework solves a problem Yo does not have.

**Verdict: rejected.** Decisions D1/D2/D4/D5 of FORMAL_VERIFICATION.md stand.

### Option B — borrow specific ideas into the existing plan ✅ (§7)

### Option C — use K itself as an external verifier for Yo programs ❌ (now)

Write a K semantics of Yo, then kprove Yo programs against it (KEVM
model). See §8 — parked, not rejected forever.

## 7. What Yo should actually take from it

Mapped to the campaign phases:

1. **D6 reinforcement — proofs about the program that runs.** KEVM
   verified the *deployed bytecode*, not the source, precisely to avoid
   trusting the compiler. Yo's analogue — and it is already the plan's
   stance (D6: bitvector semantics matching `-fwrapv` C output) — is that
   the SMT model must mirror emitted C exactly, not an idealized Yo.
   Matching logic's "one semantics" discipline is the theoretical
   articulation of why D6 is non-negotiable. No change needed; keep the
   bugged-twin discipline as the enforcement.
2. **V6+ / Open Question 1 (the `object` heap model) — separation-logic
   capture as design input.** Matching logic's cleanest practical insight
   for us: separation-logic predicates (including recursive ones —
   lists, trees) are just recursively-defined patterns over a
   configuration, and the separating conjunction is *definable*, not
   primitive. When V6 designs the heap model, cite this as the
   mathematical ceiling; implement the pragmatic floor the plan already
   recommends (flat Burstall-Bornat heap keyed by abstract references +
   Z3 axioms, Dafny-style dynamic frames if framing is needed). Do **not**
   ship μ-binders — Z3 cannot decide them, and bounded-unfolding
   recursive `declare-fun`s get the same practical reach with stock SMT.
3. **V4 recursion — recognize what Yo already has.** kprove's circular
   (coinductive) reasoning is how K gets partial correctness of loops and
   recursion without termination measures. Yo's modular contract rule
   (assume `requires` on entry; at a recursive call, prove `requires`,
   assume `ensures`) is the Hoare-style twin of the same greatest-fixpoint
   argument — D12's partial-correctness default is not an approximation
   that needs upgrading; it is the same proof principle K uses. No plan
   change; noted so V4 doesn't re-litigate it.
4. **V5 documentation — the "pattern" name collision.** Yo's quantifier
   triggers (SMT `:pattern`/E-matching) and matching-logic patterns are
   unrelated things with the same name. The V5 diagnostics/docs should say
   "instantiation trigger" (or "E-matching trigger"), never bare
   "pattern", to avoid conflating the literatures for ourselves and for
   LLM authors who have read K material.
5. **D2/D7 reinforcement — solver pinning.** K pins stock Z3 4.12.1
   and warns that other versions "are known to have bugs and performance
   regressions" — the flagship ML project treats solver-version drift as
   a bug source and pins hard rather than tracking upstream. Validates
   Yo's pinned-solver + cache-keyed-on-pin + deliberate-bump policy (the
   pin moved 4.13.3 → 5.1.0 on 2026-09-08 with PR #484).

## 8. Explicitly parked ideas

- **A K semantics of Yo (KEVM-model) as an external audit oracle.** A
  third-party formal semantics of the Yo language, executed/proved with
  K, would give an independent oracle for auditing the stdlib or the
  verifier's own SMT encodings — the same role KEVM played against the
  Vyper compiler. Cost is research-collaboration-sized (the language
  would need: RC semantics, algebraic effects, closures, the CTFE
  boundary), it would lag the self-hosted compiler continuously, and it
  buys nothing for the product verifier. Park in backlog; revisit only if
  Yo ever needs certified assurance of a frozen language subset (e.g., a
  safety-critical embedded profile).
- **Proof certificates.** Matching logic's Metamath formalization enabled
  small-trusted-checker certificates; the open-source generator was
  archived in 2024 having covered concrete rewriting only, and its
  successor (Pi Squared's Proof of Proof) targets zkVM settlement, not
  compiler tooling. Yo's plan already rules out interactive/certificate
  proving (non-goals). If certificates ever matter, the cheaper path is
  Z3 proof logs + an independent checker over the SMT-LIB encoding — a
  V8+ idea at the earliest.

## 9. References

- Matching Logic — official site: <https://www.matching-logic.org/>
- Roșu, *Matching Logic* — LMCS 2017 (foundational survey; the SL/FOL
  capture results).
- Chen & Roșu, *Matching μ-Logic* — LICS 2019 (system H, complete for
  fixpoint-free ML over all theories; the μ-binder and its sound
  extension); CALCO 2019 abstract ("Foundation of K Framework").
- Chen, Trinh, Rodrigues, Peña, Roșu, *Towards a Unified Proof Framework
  for Automated Fixpoint Reasoning Using Matching Logic* — OOPSLA 2020
  (automation-friendly proof system):
  <https://dl.acm.org/doi/10.1145/3428229>; Lin et al., OOPSLA 2023
  (language-agnostic verifier + small trusted checker); Chen et al.,
  CAV 2021 (trustworthy proof generation).
- Fiedler, *Deduction in Matching Logic* — diploma thesis 2022
  (completeness conditions for system H); Leuștean & Trufaș, *Matching
  logic — a new axiomatization* — arXiv 2506.13801 (2025); Bereczky et
  al., *Interactive Matching Logic Proofs in Coq* — ICTAC 2023.
- Pi Squared, *Math Proof Checker* (matching-logic proofs checked inside
  zkVMs — the certificate line's commercial successor):
  <https://docs.pi2.network/math-proof-checker>
- Matching logic — Wikipedia (syntax/semantics précis used in §1):
  <https://en.wikipedia.org/wiki/Matching_logic>
- K Framework tutorial, Lesson 1.21 (symbolic execution, unification,
  `ensures`/`requires`, Z3 feasibility trimming):
  <https://kframework.org/k-distribution/k-tutorial/1_basic/21_symbolic_execution/>
- kframework/matching-logic-prover (dormant; `ml2fol` ML→SMT-LIB
  prototype): <https://github.com/kframework/matching-logic-prover>
- runtimeverification/proof-generation (archived 2024-02; Metamath ML
  formalization + certificate generation):
  <https://github.com/runtimeverification/proof-generation>
- runtimeverification/k (latest release v7.1.337, 2026-06-18; Z3 4.12.1 pin):
  <https://github.com/runtimeverification/k> ·
  releases: <https://github.com/runtimeverification/k/releases/>
- Runtime Verification, *Modernizing K* (Haskell backend on matching
  μ-logic): <https://runtimeverification.com/blog/modernizing-k-enhancing-functionality-and-ease-of-use>
- Park, Zhang, Roșu, *End-to-End Formal Verification of the Ethereum 2.0
  Deposit Smart Contract* — CAV 2020:
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC7363177/>
- Runtime Verification — K overview / verified-smart-contracts (production
  use): <https://runtimeverification.com/blog/k-framework-an-overview> ·
  <https://github.com/runtimeverification/verified-smart-contracts>
