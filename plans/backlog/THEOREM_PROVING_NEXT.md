# Theorem proving after the lemma layer — the remaining surface

> **Status: PROPOSED 2026-10-08 — backlog (written, not started).**
> The theorem-proving surface Yo shipped in September–October 2026: `law`
> (B1), `yo verify --strict` (B0), and the lemma layer — recursive
> `ghost_fn` with `decreases` as an axiomatized function, lemmas proved by
> induction, `seq_of(xs)`, `produced(xs)`, `distinct(a, b)`,
> spec-transparent pure functions, lexicographic `decreases` (R2 of
> [`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md); A1–A6 of
> [`../ATS_LESSONS_BEYOND_INDEXED_TYPES.md`](../ATS_LESSONS_BEYOND_INDEXED_TYPES.md);
> PRs #1075, #1106, #1107; B0–B2 of
> [`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)).
> This doc owns what comes **after** that: the ranked remainder, the parked
> ideas with their revisit triggers, and the non-goals that stay binding.
> The campaigns that *consume* the surface are elsewhere and not re-planned
> here: [`../SELF_VERIFICATION.md`](../SELF_VERIFICATION.md) (L9's CTFE↔encoding
> consistency laws, M2–M5) and B4 (the evals corpus) of the BEND doc.

---

## Table of contents

1. [What "theorem proving" means in Yo — the tier model](#1-what-theorem-proving-means-in-yo--the-tier-model)
2. [The landed baseline — measured](#2-the-landed-baseline--measured)
3. [T1 — the std lemma library](#3-t1--the-std-lemma-library)
4. [T2 — auto-induction retry and case diagnostics](#4-t2--auto-induction-retry-and-case-diagnostics)
5. [T3 — calculational proof chains (`calc`)](#5-t3--calculational-proof-chains-calc)
6. [T4 — trigger observability](#6-t4--trigger-observability)
7. [Recorded limitations (not work items)](#7-recorded-limitations-not-work-items)
8. [Parked, with revisit triggers](#8-parked-with-revisit-triggers)
9. [Non-goals (binding)](#9-non-goals-binding)
10. [Order and cost](#10-order-and-cost)
11. [References](#11-references)

---

## 1. What "theorem proving" means in Yo — the tier model

Four tiers, so requests can be routed to a yes, a plan item, a parked
trigger, or a no:

| Tier | Content | Status |
| --- | --- | --- |
| 1. State theorems, Z3 discharges | `law`, lemmas by induction, recursive spec functions, quantifiers, ghost measures | **landed** (§2) |
| 2. Make that usable at scale | the std lemma library (T1), auto-induction (T2), readable chains (T3), trigger observability (T4) | **this doc** |
| 3. Trust reduction and external proofs | proof certificates, an external ITP/K audit oracle, verified-unsafe std | **parked**, each with a trigger (§8) |
| 4. A proof engine inside Yo | tactic languages, proof states, interactive stepping, a second solver, a self-hosted prover | **never** — binding non-goals (§9) |

The one rule every item below obeys, unchanged from
[`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) §Non-goals: **either Z3
discharges the VC or the author edits the annotations.** A lemma is an
annotation; a library of lemmas is a library of annotations; auto-induction
is a retry policy over the same Z3 call. Nothing in tiers 2–3 adds a proof
engine, a solver, or a second dialect — that is the line between this doc
and the scope creep the verifier's risk table already guards against.

## 2. The landed baseline — measured

| Construct | What it is | Where |
| --- | --- | --- |
| `law(fn-type)` | a body-less module-level claim; registers its own verify task (`law@<module>:<row>`) | `BF_LAW` (`src/expr.yo`), `evaluate_law` (`src/evaluator/builtins/contracts.yo`) |
| lemma | a unit `ghost_fn` with `ensures` (and `requires` / `decreases`); proved once by induction — the recursive self-call assumes its own `ensures` under the proven measure (the induction hypothesis); used via `ghost(lemma(args))`: prove `requires`, assume `ensures` | the call rule, `src/verifier/vc.yo` |
| recursive `ghost_fn` | with `decreases`: an uninterpreted `VcFunDecl` plus a `:pattern`-triggered definitional axiom; its own task proves `decreases-step` | `src/verifier/vc.yo` (~L3753), `src/verifier/terms.yo` |
| `seq_of(xs)` | the `ArrayList` ↔ `Seq` ghost view; extensional list equality; append via the triggered `__yo_lapp_<elem>` axiom | `BF_SEQ_OF` |
| `produced(xs)` | the elements a verified `for` has consumed; usable in the loop invariant | `BF_PRODUCED` |
| `distinct(a, b)` | proof-only `requires` clause: two list parameters are different lists (the alias frame condition) | `BF_DISTINCT` |
| spec-transparent pure fns | an uncontracted pure runtime fn is unfoldable inside specs; a recursive one needs `decreases` | ATS lessons A3 |
| `decreases(a, b, …)` | lexicographic measures | ATS lessons A5 |
| `yo verify --strict` | `assumed` / `outside-subset` / `unproven` fail the run; summaries always count them | B0 |

The measurement that justifies everything below (R2 task 1 of the
indexed-types plan; Z3 5.1.0, the verifier's own preamble): **Z3 does not
do induction.** Every inductive obligation over the list model is
`unknown` under both candidate encodings until a lemma is supplied:

| Obligation | no lemma | with the frame lemma | with the point-update lemma |
| --- | --- | --- | --- |
| frame: `cnt(store(c, k, x), m) = cnt(c, m)` for `k ≥ m` | `unknown` | `unsat`, 5 ms | — |
| push: `cnt(store(c, n, x), n+1)` | `unknown` | `unsat`, 21 ms | — |
| swap `i < j < n` keeps the count | `unknown` | `unknown` | `unsat`, 89 ms |

Corollary — the gap this doc fills: the lemma *mechanism* exists, but
**no lemma ships with std** (`std/spec/` holds only `numeric.yo` and
`refine.yo`; every project currently writes its own frame lemma). The
landed fixtures (`tests/spec/fixtures/valid/lemma_member_frame.yo`,
`dml_append_seq.yo`, `dml_sorted_insert.yo`, `dml_member.yo`, …) prove the
pattern; they are not a library.

## 3. T1 — the std lemma library

**"Use theorems, don't write them."** Ranked first: the mechanism landed
six days before this doc; the library is what turns it from a research
surface into a default.

**Motivation.** Every inductive property a caller states over an
`ArrayList` measure (`seq_of`, member/count, sortedness) needs one of a
small family of frame/update lemmas, and today each project writes them by
hand. ATS_LESSONS A1 already named this the exit condition ("std ships the
frame and point-update lemmas for every list measure it defines. Without
them, `push`, `swap` and every inductive property is `unknown`") — the
landing stopped at the fixtures. The cost ceiling for *not* shipping a
library is calibrated by KEVM (CAV 2020): ~200 lines of lemmas per ~1,000
lines of spec at the hard end, 5 of 7 person-weeks at the proof level.

**Deliverables** — new `std/spec/` modules (e.g. `list_lemmas.yo`), one
family per measure, every lemma a unit `ghost_fn` with `ensures` (+
`decreases` where recursive), used as `ghost(Lemma(args))`:

```rust
// Schematic — exact signatures follow the R1 std contracts; the shape is
// the landed lemma_member_frame pattern. Frame fact for a count measure:
//
//   count_push_frame :: ghost_fn((fn(
//     xs : ArrayList(i64), x : i64, v : i64,
//     ensures(count(push(xs, x), v) == (count(xs, v) + cond((x == v) => i64(1), true => i64(0)))),
//   ) -> unit)( ... proved once, by induction on xs.len() ... ));
```

- **`seq_of` family:** push/append frame; `set` (point-update); `insert` /
  `remove` frames; the take/drop split at the iteration index (composes
  with `produced(xs)`).
- **member / count family:** member frame under mutation; count
  point-update; swap-preserves-count (the measured triple above, at Yo
  level).
- **sortedness family:** the one-step lemma every `sorted_insert`-shaped
  invariant needs.
- **`ms_of` over `Array(T, N)`:** frame + point-update + swap — the
  measured pair, as Yo lemmas feeding the existing insertion-sort
  capstone's `Multiset`.
- **permutation composition:** multiset equality is stable under the
  lemmas above; state the compositions callers otherwise re-derive.

**Rules.**

1. A lemma is an obligation, not an axiom — the library itself verifies
   under `--strict` in the CI verify job
   (`tests/spec/fixtures/negative/lemma_member_frame_false.yo` already pins
   that a false lemma is refuted, and the law using it is *not* reported
   proved).
2. Every library lemma ships a bugged twin in `tests/spec/fixtures/`
   (repo discipline; also the guard against a lemma whose `ensures` is
   subtly stronger than what std's `assumed()` contracts justify — a wrong
   lemma here is unsound for every caller, same rule as R1's std
   contracts).
3. Each lemma is measured against the std implementation it talks about
   (the runtime-splice form executes in `runtime` mode tests — the
   `assumed()`-splice A/B precedent, ATS_STYLE §7.1).

**Seed gate.** All spellings are Phase-0 words (`ghost_fn`, `ensures`,
`decreases`, `ghost(...)`) — **no new builtin, no Generation A/B split**.
The one behavior to re-check against the seed is the proof-only clause
filter (a clause that quantifies or calls a `ghost_fn` is never spliced;
that filter is v0.2.49+, the `push` element-clause precedent) — run the
seed battery before merging, per the usual `std/` rule.

**Exit criterion.** The insertion-sort capstone re-spelled over
`ArrayList(i64)` — `sorted(xs) && permutation(xs, old(xs))` through
`seq_of` + a count measure — proves using **only** std lemmas: no
project-local lemma, no hand-written frame fact. Second exit: a
SELF_VERIFICATION M2-era caller states a quantified property over a list
and no local lemma appears.

**Estimate:** 2–3 weeks (the lemmas are small; the measurement and twin
discipline are the work).

## 4. T2 — auto-induction retry and case diagnostics

Today an obligation that needs induction reports `could not prove within
budget`, and the author must invent the lemma. The R2 measurement says the
shapes are mechanical — the frame/update family follows the measure's
recursion exactly. Automate the first attempt:

**Design.**

- **Trigger:** an obligation returns `unknown` after the existing
  escalation, **and** its goal mentions a contracted recursive spec
  function (or quantifies over a modeled datatype).
- **Retry:** synthesize the induction scheme the manual lemma embodies —
  add, as assumptions, the goal's instances at strictly smaller measures
  (exactly what the self-call's ensures-assume provides inside a lemma),
  then re-query **once**. Budget: the same deterministic rlimit policy as
  the existing escalation (5M → 20× precedent); the verdict cache key
  gains an `auto-induct` component so verdicts stay byte-identical per
  pin.
- **Reporting:** success reports `proved (auto-induction)`; partial
  failure names the case — *"the step case of `count` at `n−1` is
  unproven; the hypothesis for smaller measures was assumed — write a
  lemma for this case"* — the actionable-diagnostic rule, applied to
  proofs.

**Gate — do not build speculatively.** Start only on a measured need: B4's
evals corpus showing agents repeatedly stuck at exactly this step, or the
SELF_VERIFICATION M2/M3 annotation loops writing the same lemma shape ≥ N
times (N recorded when the gate fires). The repo's re-plan-gate discipline
applies: automation is added when the manual shape is demonstrably
repetitive, not before.

**Estimate:** 3–4 weeks. Depends on T1 (the schemes worth synthesizing are
the library's families; the library is also how the synthesis is
validated).

## 5. T3 — calculational proof chains (`calc`)

Dafny's `calc` was named as a model in the BEND audit's references but
never planned. A ghost-context builtin proving a chain
`e₀ ⊕ e₁ ⊕ … ⊕ eₙ` (for one operator `⊕ ∈ {==, ==>, <=, <}` per chain)
where each adjacent pair is its own obligation under the pairs proved so
far — sugar over sequential asserts plus lemma calls; **no new logic, no
proof state, no stepping** (the chain is one static annotation; Z3
discharges every link or the link is a compile error with its own
counter-example).

- **Value:** long equational proofs (the kind SELF_VERIFICATION's M3
  consistency laws will be) read top-to-bottom instead of as a wall of
  asserts; each link fails independently — the LLM-actionable property.
- **Surface:** open design question, constraints fixed: ASCII, one
  builtin, ghost-only, erased at codegen, fmt-stable.
- **Cut rule:** optional. If T1's library plus existing `assert` chains
  carry the M3 laws without readability complaints, `calc` does not get
  built.

**Estimate:** ~1 week, if built.

## 6. T4 — trigger observability

R2's definitional axioms fire by `:pattern`; V5 deferred user-facing
triggers ("explicit `:pattern` triggers DEFERRED until a benchmark needs
them") and promised "trigger-stability guidance" diagnostics that never
landed — `grep` finds no instantiation/trigger diagnostic in
`src/verifier/` today. When an obligation stays `unknown`, the author
cannot see *why*: whether an axiom never instantiated, or instantiated and
was insufficient.

**Design.**

- **(a) Observability first.** `--explain <fn>` (and the `unproven`
  diagnostic) renders, per query: every declared axiom/function, whether
  its trigger matched any term, and (where Z3's instantiation logs are
  affordable — measure; they may be an `--explain`-only cost) which
  instantiations fired. Message shape: *"the definitional axiom of
  `count` did not instantiate: no subterm matched its trigger — restate
  the goal mentioning `count(c, i)` at a concrete `i`, or use the
  `count_store_frame` lemma"* — the instantiation hint V5 sketched, made
  real.
- **(b) Control — deferred.** A user-facing trigger spelling (a ghost
  `trigger(...)` builtin selecting the E-matching pattern for a lemma's
  `ensures`) only if T1 + (a) leave measured gaps MBQI cannot close.

**Estimate:** (a) ~1 week; (b) unspecced, gated on (a)'s findings.

## 7. Recorded limitations (not work items)

- **Value `ghost_fn` `requires` are not checked at call sites** — their
  SMT reading is total. Tried and dropped in R2 slice 2: checking fires
  inside specifications whose guards are not on the path; the real fix is
  Dafny-style well-formedness obligations for spec functions. Revisit only
  on an incident attributable to totality (a spec accidentally applied
  outside its intended domain).
- **Aliasing is syntactic.** `distinct(a, b)` and the name-provenance
  rules stand in for object identity; a verified body that mutates beside
  a possible alias is a subset error. The real frame story arrives with
  the heap model (FORMAL_VERIFICATION Open Question 1; SELF_VERIFICATION
  L6/D2's singleton-then-flat-heaps sequence). No lemma-layer fix.
- **Quantified refutation search can diverge** (V5's lesson: wrong twins
  over quantified encodings must stay ground). If refutation latency ever
  blocks the agent loop, a bounded sat-search policy is a small future
  item — record it here if it fires.
- **Recursive enums are `ref(enum)` today**; the verifier's datatype view
  rides L3's immutable-reference discipline (SELF_VERIFICATION). The
  VALUES_BY_DEFAULT endgame (plain value enums) *simplifies* this —
  nothing in T1–T4 blocks on it, and each item should be re-measured
  against value enums when VBD's enum phases land.
- **Housekeeping, pending:** BEND's sequencing note — fold B0–B2 into
  `FORMAL_VERIFICATION.md` as a V8 "Laws and lemmas" banner — has not
  happened; that doc's §The surface still reads as if `law`/lemmas were
  future work.

## 8. Parked, with revisit triggers

| Idea | The cheaper route, when it triggers | Trigger |
| --- | --- | --- |
| **Proof certificates** — remove Z3 from the trusted base | Z3 proof logs + a small independent checker, itself written and verified in Yo ([`../reference/MATCHING_LOGIC_RESEARCH.md`](../reference/MATCHING_LOGIC_RESEARCH.md) §8; SELF_VERIFICATION D5) | a certification customer needing independent assurance ("V8+ at the earliest") |
| **An external audit oracle** — a K semantics of Yo, or exporting the deterministic SMT-LIB VCs to an external ITP (Lean/Isabelle) for a semantic-preservation-scale claim | build nothing inside Yo; export only (the SMT-LIB emitter is already golden-tested) | a semantic-preservation-scale claim anyone actually needs to make |
| **Verified unsafe std** — prove `ArrayList`'s raw-buffer bodies instead of `assumed()` | a raw-buffer model for `ArrayList` alone, not a general heap model (ATS_LESSONS §4, decided 2026-10-02) | a std bug traced to a wrong `assumed()` clause |

## 9. Non-goals (binding)

Each is recorded elsewhere; this doc does not reopen any of them, and
tier-2 items above must not creep toward them:

- **Tactic languages, proof states, interactive proof stepping** —
  FORMAL_VERIFICATION §Non-goals; ATS_LESSONS §5. The Z3-or-annotations
  rule is the enforcement line.
- **A second solver** (decision D2) and **a self-hosted prover**
  ([`../ROADMAP.md`](../ROADMAP.md) §Non-goals: "SMT solvers are the
  backend; Yo owns obligation generation").
- **Runtime dependent types**
  ([`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md)). The ATS
  *notation* was audited and rejected — index sorts, `{n}` / `[n]`
  binders, singleton types, constraint solving inside unification
  ([`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md) §4) — but
  the *substance* landed as the verifier's length-indexed collection
  model (that doc's R1) and the lemma layer (its R2): the doc is DONE for
  what it adopted, and §4 is the standing rejection of the rest.
- **Mandatory termination** (D12 — partial correctness by default).
- **Semantic preservation** — the emitted-C-means-what-Yo-means theorem
  needs a formal semantics of Yo and of C11 in a proof assistant
  (SELF_VERIFICATION: "What no milestone claims"). The parked external
  oracle (§8) is the only route, and only on demand.
- **Importing external theorems as trusted axioms** — anything
  `assumed()`-shaped that vouches for a proof made outside this
  compilation breaks the self-contained soundness story (a green `yo
  verify --strict` currently means: every claim was discharged by the
  pinned Z3 against the tree's own encoding). Certificates (§8) are the
  only sanctioned way to import external assurance.

## 10. Order and cost

| Item | Depends on | Size | Trigger to start |
| --- | --- | --- | --- |
| T1 std lemma library | nothing — the surface landed | 2–3 weeks | anytime; first consumers are SELF_VERIFICATION's M2/M3 laws and any `spec/` user |
| T4a trigger observability | nothing | ~1 week | alongside T1 — the library's fixtures will need the diagnostics |
| T2 auto-induction | T1 | 3–4 weeks | measured repetition (B4 evals or M2/M3 annotation loops) |
| T3 `calc` | T1 | ~1 week | optional; cut if asserts suffice (decided by the M3 laws' readability) |
| certificates / external oracle / verified-unsafe std | — | parked | their §8 triggers |

All four work items keep every landed invariant: pinned Z3, deterministic
rlimit budgets, byte-identical verdicts per pin, ghost erasure, the
verifiable-subset discipline, and `--strict` as the honest gate.

## 11. References

- In-tree:
  [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) (the verifier, V1–V7;
  §Non-goals is the line this doc enforces),
  [`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md) (R1/R2 — the
  landed indexed-type and lemma layers; R2 task 1's measurement table),
  [`../ATS_LESSONS_BEYOND_INDEXED_TYPES.md`](../ATS_LESSONS_BEYOND_INDEXED_TYPES.md)
  (A1–A6 closeout; §4's verified-unsafe-std decision),
  [`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
  (B0–B2; B4 evals as T2's gate),
  [`../SELF_VERIFICATION.md`](../SELF_VERIFICATION.md) (the consumer
  campaign; L6/D2 heap-model sequencing),
  [`../reference/MATCHING_LOGIC_RESEARCH.md`](../reference/MATCHING_LOGIC_RESEARCH.md)
  (§8's parked certificate route),
  [`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md).
- External: Dafny's `lemma` / `calc` and its standard libraries (the model
  for T1/T3); Why3's transformation and trigger surface (the model for
  T4's diagnostics); Park, Zhang, Roșu — *End-to-End Formal Verification
  of the Ethereum 2.0 Deposit Smart Contract* (CAV 2020), the KEVM
  lemma-cost calibration cited in T1; Creusot's `produced()` (the name the
  landed `for`-loop ghost measure uses).
