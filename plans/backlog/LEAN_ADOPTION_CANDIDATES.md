# What to take from Lean: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-10-14 at the maintainer's
request.** Formal verification only: Lean-the-language candidates outside
the verifier (the Perceus reuse calculus was already studied in
[`../archive/PERCEUS_REUSE.md`](../archive/PERCEUS_REUSE.md);
metaprogramming and notation are out of scope) are not audited here. The
companion audits are [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md)
(the adoptees' home) and
[`K_FRAMEWORK_ENGINEERING_LESSONS.md`](K_FRAMEWORK_ENGINEERING_LESSONS.md)
(the same shape for the K ecosystem);
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md) and
[`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md) carry the same
filter for their languages. Audited against Lean 4.35 / Mathlib / Lake
(2026-10-14) and the Yo tree at `74cbea229`: every "Yo today" claim below
was checked by read and grep on that tree; the Lean claims carry primary
sources (§7). Nothing here is adopted; each candidate ends with a verdict
and a trigger, and the maintainer picks.

## 0. The filter

A candidate survives only if it passes all four (RUST_ADOPTION_CANDIDATES
§0, adapted):

1. **Not already rejected.** The binding non-goals: no tactic language,
   proof states or interactive stepping
   ([`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) §Non-goals); no
   second solver — decision D2, "Z3 only" (`FORMAL_VERIFICATION.md:14-19`);
   no runtime dependent types
   ([`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md)); no
   importing external theorems as trusted axioms (THEOREM_PROVING_NEXT §9).
2. **Fits the model.** "Either Z3 discharges the VC or the author edits the
   annotations" (FORMAL_VERIFICATION §The surface). Everything below is
   diagnostics, library, or driver machinery; nothing adds a proof engine,
   a solver, or a second dialect.
3. **Pays for an LLM author.** Yo's users are mostly models; the
   verifier's job is keeping the agent loop iterating. A diagnostic that
   names the next edit beats one that adds proving power the loop cannot
   steer.
4. **Not already here** (§1, so nobody re-proposes it).

## 1. Already here (do not re-propose)

| Lean | Yo today | Where |
| --- | --- | --- |
| `termination_by` + `decreasing_by` side goals | `decreases(m1, m2, …)` with per-call `decreases-step` and entry `decreases-nonneg` obligations; lexicographic order by bit-vector concatenation; mutual recursion by cliques (one measure per fn, strictly decreasing at every clique edge) | `src/verifier/vc.yo:6944`, `:6104`, `:305`; `FORMAL_VERIFICATION.md:1388` |
| measure inference (`termination_by?` prints what it found) | deliberately absent: the author writes the measure they mean — a model guessing wrong here is worse than a model writing one | design stance, no work |
| `partial def` (runs, opaque to reasoning) | uncontracted recursion is simply outside the verified subset; D12 partial correctness by default | `vc.yo:6123`; `FORMAL_VERIFICATION.md` D12 |
| `sorry` (warning, everything still elaborates) | `assumed()` / `outside-subset` pass by design, counted in every summary, fail under `--strict` | B0; `src/verifier/driver.yo:576` |
| Mathlib's zero-`sorry` merge policy | T1 rule 1: the lemma library itself verifies under `--strict` in the CI verify job | THEOREM_PROVING_NEXT §3 |
| per-module `.olean` proof caching + Lake `depHash` | per-**VC** verdict cache: sha256 over (epoch, z3 pin, rlimit, seed, timeout, SMT content); a corrupt entry is a miss; hit-rate in the summary — finer-grained than Lean's per-module form | `driver.yo:261-344`; `FORMAL_VERIFICATION.md` §Caching |
| elaborate-everything error recovery | verify walks every task, reports every function, throws once at the end | `driver.yo:813`; `src/main.yo:3279` |
| the non-stepping half of the InfoView (see the goal) | `--explain <fn>` renders one fn's obligations and verdicts; the JSON report carries per-obligation outcomes | T4's base (THEOREM_PROVING_NEXT §6) |
| `get_elem_tactic` (index side goals auto-discharged) | bounds obligations are generated and Z3-discharged automatically (V3 AoRTE) | `FORMAL_VERIFICATION.md` §V3 |
| solver-model counterexamples (`bv_decide`, Lean-blaster `gen-cex`) | every `Refuted` carries the Z3 model, unmangled to source names, as paste-able literals | `encode.yo:582`; `z3.yo:630`; `FORMAL_VERIFICATION.md:797` |
| run-level cost summary | `elapsed_ms`, `queries`, `cached` in every run summary | `main.yo:3426` |

Two validations worth recording:

- **Yo's explicit `ghost(lemma(args))` calls make Lean's central
  library-maintenance problem structurally absent.** Mathlib's `@[simp]`
  curation, simp normal forms, `register_simp_attr` sets, the `simpNF`
  linter and rewrite-lemma deprecation all exist because `simp` rewrites
  *ambiently* — every lemma is live in every proof. A Yo lemma is an
  annotation applied at a call site (`vc.yo:4130`), so nothing rewrites
  ambiently and nothing needs curating. The curation burden is the price
  of ambient automation; Yo does not pay it (and §3 keeps it that way).
- **Lean's `.olean` files lacked integrity checks** (lean4#13615, since
  closed): importing bypassed the kernel. Yo's cache key *is* a content
  hash of the query, so the integrity question does not arise. Keep that
  shape.

## 2. The candidates, ranked

### LE1 — A lemma search for the author: `exact?`'s lesson

**Lean:** the single biggest usability fact of a 200k-lemma library is
*finding what is in it*. `exact?`/`apply?` search Mathlib by conclusion
shape (a discrimination-tree index over conclusions, not names or full
text), and the search is what lets authors treat the library as
infrastructure rather than reading.

**Yo today:** lemmas are applied only where the author writes the call
(`ghost(lemma(args))`, `vc.yo:4130`); there is no lemma database, no
index, no search anywhere in `src/verifier/`. T1 will ship the families
(`seq_of`, member/count, sortedness, `ms_of`, permutation); T2's failure
diagnostic tells the author *"write a lemma for this case"* without
naming one.

**Candidate:** a conclusion-shape index (head symbol + argument shapes of
each library lemma's `ensures`) over `std/spec`'s lemmas; on an `unproven`
verdict, the diagnostic — or `yo verify --suggest <fn>` — names the
matching library lemma and prints the paste-able call:

```yo
// unproven: count(remove(xs, v), w) == count(xs, w) - occurrences
// suggests std/spec/list_lemmas.yo: count_remove_frame —
//   ghost(count_remove_frame(xs, v, w));
// no match: the template T2's diagnostic already renders
```

This is not a proof engine: it proposes an annotation, the author applies
it, Z3 still discharges (filter rules 2–3; the stuck state in the agent
loop is lemma *discovery*, not proof writing — B4's premise). The index
also feeds LE6.

**Verdict: adopt with T1** (an index over five families is small; over
zero it is nothing). ~1–2 weeks.

### LE2 — Trust provenance: `#print axioms`' lesson

**Lean:** `#print axioms thm` prints the axioms a theorem *transitively*
depends on; `sorry` shows up as `sorryAx` in any dependent; `native_decide`
was made to depend on an explicit `trustCompiler` axiom precisely so the
audit could see it. Mathlib merges with zero `sorry` and audits for that.

**Yo today:** `assumed`/`outside-subset` are counted at run level and
`--strict` fails them — but a *proved* fn whose obligations rest on a
callee's `assumed()` `ensures` reports plain `ok`: the trust chain is
invisible per-fn (the AGENTS.md pitfall "a green `yo verify` is not
'everything proved'"). The datum that resolves it is already computed: the
unsat core says exactly which clauses carried each proof (`driver.yo:291`,
captured into the cached verdict) — and the renderer throws it away
(`main.yo:3654` prints `PROVED` for `.Proved(_)`).

**Candidate:** render, per proved fn, the assumed-clause subset of its
unsat cores — the same data K_FRAMEWORK L4 renders as clause-usage
*coverage*, read here as trust *provenance*; one PR serves both. Plus a
run-level trust summary: *N proved fns; M distinct `assumed()` clauses
load-bearing; K proved laws used*. `--strict` stays the gate; this is the
report that makes "green ≠ everything proved" visible without tracing
calls by hand.

**Verdict: adopt — in K L4's PR.** Days.

### LE3 — Shrunk counterexamples: Plausible's lesson

**Lean:** Plausible's counterexamples are *shrunk* to minimal witnesses
before reporting; grind's arithmetic solvers surface counterexample info
when they cannot close a goal. A shrunken witness is what makes a
counterexample actionable rather than merely true.

**Yo today:** the first Z3 model renders as-is (`z3.yo:630` → unmangled at
`driver.yo:955`), and first models are frequently huge bit-vector values.
FORMAL_VERIFICATION's own diagnostic spec (§:810) shows the ideal as
minimal — `counter-example: i = 0, arr.len() = 0` — but nothing minimizes.

**Candidate:** a bounded, deterministic shrink loop after a `Refuted`
verdict: for each model value, one cached sat re-query with that value
bounded smaller; keep the smaller model while the query stays sat; fixed
step budget, fixed order. Every step is a cache-keyed query, so verdicts
stay byte-identical per pin.

**Verdict: adopt** — driver work, ~1 week. High LLM value: the paste-able
repro (the spec's "literals the author can paste into a test", §:817)
becomes readable.

### LE4 — Verification-time regression tracking: radar's lesson

**Lean:** Mathlib tracks per-declaration elaboration cost (the FRO's radar
bench replays the library's proofs and reports per-declaration times);
proof check-time is a maintained asset and a PR can be flagged for making
it worse. Proofs are Mathlib's payload, so their cost is tracked like Yo
tracks compile time.

**Yo today:** run-level `elapsed_ms` and cache hit-rate only
(`main.yo:3426`); per-obligation cost is recorded nowhere, so nothing
catches "this PR made std's cold verify 3× slower" or "these 40 cached
verdicts flipped to `unknown`".

**Candidate:** the cached verdict entry gains rlimit-consumed and wall-ms;
`yo verify --profile` prints the top-N obligations by cost; a std CI guard
diffs total verify cost against the battery head. SELF_VERIFICATION makes
proofs Yo's payload too — the same argument Mathlib made for radar.

**Verdict: adopt when the corpus grows** (T1/T2/SELF_VERIFICATION scale);
the counter half is days, the guard is a CI line.

### LE5 — Parallel cold verification: Lake's lesson

**Lean:** Lake elaborates modules in parallel; per-module independence is
what lets a library of proofs scale past one core.

**Yo today:** strictly serial — the driver runs cache → encode → spawn →
parse one obligation at a time (`driver.yo:345`, `:813`), the budget retry
is serial (`driver.yo:370`). The prerequisites for parallelism are already
in place: temp files are collision-safe across concurrent processes
(`z3.yo:210`), every verdict is per-query independent, and the cache makes
merge order irrelevant.

**Candidate:** fan obligations across a bounded `--jobs N`, merge in fixed
order. The per-query contract — pin, rlimit, one fresh process, file IO —
is untouched; this is *not* the rejected solver-daemon (K L7): same shape
as today, more of them at once, nothing long-lived.

**Verdict: candidate, measure first** — time a cold `yo verify` of std once
SELF_VERIFICATION's M-milestones land; build when that wall time is the
long pole. ~2–3 weeks.

### LE6 — Library lint: `simpNF`'s lesson, minus simp

**Lean:** Batteries' `simpNF` linter rejects lemmas whose left side is
itself rewritable by another lemma; the library is *linted*, not just
tested, because bad entries poison every downstream use.

**Yo today:** T1's rules (bugged twins, measurement against the
implementation) *test* the library; nothing detects that two lemmas have
unifiable conclusions (a duplicate) or that one lemma's `ensures` is an
instance of another's (subsumption) — both are noise a search (LE1) would
return and a reader would have to triage.

**Candidate:** a lint over LE1's conclusion index — duplicate and subsumed
conclusions flagged at library build time. No orientation rule transfers:
without ambient rewriting there is no normal form to orient toward
(§1's validation).

**Verdict: adopt with T1** — days, once LE1's index exists.

### LE7 — "Try this", not silent magic: `grind?`'s lesson

**Lean:** `grind?`/`finish?` do not just close the goal — they print the
`Try this:` tactic script that reproduces the proof, replayed before being
suggested. A committed script is version-stable in a way silent automation
is not.

**Yo today:** T2's design (gated) auto-retries with induction hypotheses
assumed, reports `proved (auto-induction)`, and puts the retry in the
cache key — correct determinism, but the next pin can silently unprove it,
and the author never sees what the automation actually used.

**Candidate:** T2's success diagnostic also prints the annotation that
would make the proof explicit — the `ghost(lemma(...))` shape it
synthesized — so the author can pin it. Zero machinery beyond LE1's
suggester; a design requirement to write into T2 before it starts.

**Verdict: adopt as a T2 design requirement.** No separate work.

### LE8 — Decide-by-evaluation: `decide`'s lesson, probably parked

**Lean:** `decide` discharges closed propositions with the kernel's
evaluator — no solver involved at all.

**Yo today:** every obligation spawns Z3, ground or not (`driver.yo:345`);
the evaluator is already the compiler's trusted base, and "one contract
serves CTFE (free), Z3 (cheap/annotated) and the runtime assert (fallback)"
is the stated philosophy (K_FRAMEWORK L6) — this would be the missing
fourth consumer for obligations that are *fully ground*.

**Candidate:** discharge fully-ground obligations by CTFE evaluation
before spawning; report a visible `proved (eval)` tier; the cache key
gains an eval component. D2-adjacency, stated plainly: evaluation of
ground terms is not a solver — but the honest expectation is that few
verifier obligations are ground (they exist over symbolic states), so
**measure first**: a driver counter of ground obligations over std's own
verify corpus; build only if the spawn count removed is material.

**Verdict: measure first; likely park.**

## 3. Positions recorded (no work items)

### P1 — The external-solver posture, seen from Lean

Lean never trusted an external SMT solver as proof. Lean 3's native
SMT-*style* framework (congruence closure + E-matching — never actually
Z3-backed; `smt.prove` was a placeholder) was dropped in the Lean 4
rewrite for performance and maintenance cost. Today's Lean has exactly two
solver integrations, and both prove the point: **lean-smt** (cvc5)
reconstructs kernel-checkable proofs from certificates, and
**Lean-blaster** (Z3, no reconstruction) closes goals with `admit` — a
development convenience whose proofs do not count. Yo's verifier *is* the
Lean-blaster posture promoted to the primary design, with the
compensations Lean lacks: one pinned version, a fresh process per query,
deterministic rlimit budgets, byte-identical verdicts per pin, and a
content-addressed verdict cache. Two consequences:

- The parked certificates route (THEOREM_PROVING_NEXT §8) is lean-smt's
  shape — an independent check of solver output. When its trigger fires,
  the Lean4Lean/nanoda experience carries a caution: a checker *derived
  from* what it checks shares its bugs (Lean4Lean's own README says so
  about itself versus the C++ kernel). Yo's checker should re-encode from
  the Yo source side, not re-parse Yo's own SMT-LIB.
- D2's rejection of in-kernel decision procedures is Lean-endorsed from
  the other side: Lean rebuilt `omega` (core in v4.7, 2024) through `grind`
  ("real" by v4.22) natively, over years of release engineering. That is
  the price list of the road Yo declines. The reopen condition stays
  incident-shaped: pin unavailability on a target, licensing, or a
  measured determinism/cost cliff at SELF_VERIFICATION scale — recorded
  here so the row exists in §4 with its trigger.

### P2 — Untrusted automation: why Lean can sprawl and Yo cannot

Lean's kernel re-checks everything automation produces — ~10k lines of
kernel under ~400k lines of elaborator and tactics — which is why tactic
sprawl is affordable there. Yo has no kernel: the trusted core is Z3 plus
the VC walk. The equivalent discipline is already binding and this audit
does not relax it: automation must be deterministic, budgeted, cache-keyed
and annotation-first (T2's design obeys all four; LE7 keeps the last one
true). Validation, recorded.

### P3 — The `native_decide` cautionary tale

Lean proved `False` with zero axioms in October 2023 by leaking
nondeterministic IO into compiler-evaluated `decide`; the fix made the
trust explicit (a `trustCompiler` axiom) so `#print axioms` could see the
hole. The Yo equivalent would be counting runtime-splice asserts or CTFE
as *proof* — already rejected by design (the splice is a test,
K_FRAMEWORK L6). Recorded so LE8, if it ever builds, reports `proved
(eval)` as a visible tier, never silently.

## 4. Rejected (this document's additions to the standing table)

| Lean thing | Why not |
| --- | --- |
| in-kernel decision procedures (`omega`, `ring`, `norm_num`, `grind`, `bv_decide` shapes: a Presburger solver, ring normalizer, E-matching engine, SAT bit-blaster) | D2 "Z3 only" (`FORMAL_VERIFICATION.md:14-19`); no Presburger/`omega` position existed anywhere in the tree before this row — recorded here. Reopen: incident-shaped, P1 |
| ambient rewrite automation, user-facing lemma sets (`@[simp]`, `register_simp_attr`, `simp only [set]`) | lemmas are call-site-scoped `ghost(...)` calls; ambient rewriting imports Mathlib's normal-form curation burden (§1) for no measured need; T4's trigger observability is the sanctioned answer to "my fact did not fire". Trigger: T2-era evidence that explicit calls fail at scale |
| a tactic language, proof states, interactive stepping | binding non-goal; `FORMAL_VERIFICATION.md:97`, `:1762` ("global proof-state reasoning is exactly what LLMs are bad at"); THEOREM_PROVING_NEXT §9 |
| CIC / dependent-type proving, `Prop`, universes, proof terms | `DEPENDENT_TYPES_POSITION.md:104`; SELF_VERIFICATION's foundations table; the VC IR is first-order + theories by design |
| importing Lean/Mathlib theorems as trusted axioms | THEOREM_PROVING_NEXT §9 (the self-contained soundness story); and there is nothing to import — Yo already *is* the trust-Z3 posture (P1) |
| compiler/runtime trust tiers (`native_decide`, `implemented_by`) | P3's documented `False` proof; the runtime splice stays a test, never a proof |
| mandatory termination | D12: partial correctness by default; `decreases` is required only inside the verified subset |

## 5. Where the adoptees land

| Candidate | Lands as | Size | Depends on / trigger |
| --- | --- | --- | --- |
| LE2 trust provenance | K_FRAMEWORK **L4**'s PR (unsat-core rendering) | days | anytime |
| LE3 shrunk counterexamples | driver post-`Refuted` loop | ~1 week | anytime |
| LE1 lemma search | extension of THEOREM_PROVING_NEXT **T1** + **T4** (report surface) | 1–2 weeks | T1 lands |
| LE6 library lint | over LE1's index, in T1's CI battery | days | LE1 |
| LE4 verify-time tracking | cache entry + `yo verify --profile` | days | corpus scale (T1/T2/SELF_VERIFICATION) |
| LE5 parallel cold verify | driver fan-out, `--jobs N` | 2–3 weeks | measured cold-verify pain (SELF_VERIFICATION M-milestones) |
| LE7 "Try this" | a design requirement written into T2 | none | T2 starts |
| LE8 decide-by-evaluation | a driver counter, then park-or-build | counter: days | measure first |

None of the eight touches the evaluator, codegen or the language surface
— all are driver, report or `std/spec` work. All keep every landed
invariant: pinned Z3, deterministic rlimit budgets, byte-identical
verdicts per pin, ghost erasure, the verifiable-subset discipline, and
`--strict` as the honest gate.

## 6. Companion-doc relationships

- **THEOREM_PROVING_NEXT**: LE1 extends T1/T4; LE7 amends T2's reporting
  design; P1 adds the Lean-side evidence to §8's parked certificate route
  without reopening it.
- **K_FRAMEWORK_ENGINEERING_LESSONS**: LE2 shares L4's PR (one unsat-core
  rendering, two readings — coverage and provenance); LE5 is the
  parallelism L7 explicitly left alone; L8's single-pin rule is the frame
  P1 argues from.
- **ATS_STYLE_INDEXED_TYPES / ATS_LESSONS**: T1's families are those docs'
  exit condition; LE1/LE6 are the tooling that keeps the library usable
  as it grows.
- **SELF_VERIFICATION**: LE4 and LE5 exist because that campaign makes
  proofs Yo's payload at std scale.

## 7. References

- In-tree:
  [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) (T1–T4, §8
  certificates, §9 binding non-goals),
  [`K_FRAMEWORK_ENGINEERING_LESSONS.md`](K_FRAMEWORK_ENGINEERING_LESSONS.md)
  (L1/L4 the shared report surface, L7 the daemon rejection, L8 pinning),
  [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) (D2, §Caching,
  §Non-goals, the counter-example diagnostic spec at :797-825),
  [`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md),
  [`../SELF_VERIFICATION.md`](../SELF_VERIFICATION.md),
  [`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md).
- External, audited 2026-10-14: the Lean reference manual's
  [Tactic Reference](https://lean-lang.org/doc/reference/latest/Tactic-Proofs/Tactic-Reference/)
  (`omega`, in core since v4.7, pure Lean),
  [the `grind` page](https://lean-lang.org/doc/reference/latest/The--grind--tactic/)
  and Morrison & de Moura, *grind* (IJCAR 2026; in core since v4.16),
  [ValidatingProofs](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)
  and [Axioms](https://lean-lang.org/doc/reference/latest/Axioms/)
  (`sorry`/`sorryAx`, transitive `#print axioms`, the `native_decide`
  trust history),
  [RecursiveDefinitions](https://lean-lang.org/doc/reference/latest/Definitions/Recursive-Definitions/)
  (`termination_by`/`decreasing_by`/`partial def`),
  [Lake](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/)
  (trace hashes, `depHash`) and lean4
  [#13615](https://github.com/leanprover/lean4/issues/13615) (`.olean`
  integrity), the
  [Lean 3 `library/smt` tree](https://github.com/leanprover/lean3/tree/v3.4.2/library/smt)
  (native framework, placeholder `smt.prove`),
  [ufmg-smite/lean-smt](https://github.com/ufmg-smite/lean-smt) (cvc5,
  proof reconstruction; CAV 2025) and
  [input-output-hk/Lean-blaster](https://github.com/input-output-hk/Lean-blaster)
  (Z3, `admit`, counterexamples — the Yo posture),
  [bv_decide / LRAT](https://leanprover-community.github.io/mathlib4_docs/Lean/Elab/Tactic/BVDecide.html)
  (SAT certificates checked by a verified checker),
  [digama0/lean4lean](https://github.com/digama0/lean4lean) (arXiv
  2403.14064) and Mathlib's `check-nanoda` daily CI (external kernels; the
  derivative-checker caution),
  [Batteries' `simpNF`](https://github.com/leanprover-community/batteries/blob/main/Batteries/Tactic/Lint/Simp.lean),
  [Mathlib's simp/normal-form guide](https://leanprover-community.github.io/extras/simp.html)
  and [radar](https://radar.lean-lang.org/repos/mathlib4) (proof-cost
  tracking),
  [did_you_prove_it](https://leanprover-community.github.io/did_you_prove_it.html)
  (the zero-`sorry` policy), the
  [native_decide soundness incident](https://leanprover-community.github.io/archive/stream/270676-lean4/topic/soundness.20bug.3A.20native_decide.20leakage.html)
  (Oct 2023), and
  [plausible](https://github.com/leanprover-community/plausible) (shrunk
  counterexamples).

## Maintenance

As for the Rust and Zig documents: an adopted candidate moves into the
plan that lands it with a dated pointer here; a rejected one moves to §4
with the reason; re-check the file:line citations against the tree before
any PR acts on them.
