# K Framework engineering lessons — the ecosystem, not the logic

> **Status: PROPOSED 2026-10-08 — backlog (assessment + candidate items, nothing started).**
> The sibling of
> [`../reference/MATCHING_LOGIC_RESEARCH.md`](../reference/MATCHING_LOGIC_RESEARCH.md),
> which decided (2026-09-09) that Yo does **not** build on matching logic as
> the verifier's foundation. That decision stands; this doc audits the K
> *ecosystem* — the repository, the `pyk` tooling API, KEVM's testing
> discipline, Kontrol's product shape — for engineering lessons Yo can take
> without touching the foundation. Audited against `runtimeverification/k`
> at its latest release v7.1.337 (2026-06-18), the pyk 7.1.337 API docs,
> and the `evm-semantics` and `kontrol` repositories, on 2026-10-08.
> Adoptees land as extensions of
> [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) items where noted.

---

## Table of contents

1. [What was audited](#1-what-was-audited)
2. [The lessons, ranked](#2-the-lessons-ranked)
3. [Not taken](#3-not-taken)
4. [Where the adoptees land](#4-where-the-adoptees-land)
5. [References](#5-references)

---

## 1. What was audited

| Artifact | What it is | One line |
| --- | --- | --- |
| [`runtimeverification/k`](https://github.com/runtimeverification/k) | the framework | `k-frontend` (JVM), `llvm-backend` (fast concrete execution), `haskell-backend` (symbolic; Booster folded in and archived 2025-10), `pyk` (Python tooling, merged in from its own repo 2024-04) |
| [`pyk` API docs](https://kframework.org/pyk/api/pyk.html) | the programmatic surface | term interchange (`pyk.kore`), an RPC solver protocol (`pyk.kore.rpc`), persistent proof objects and explorations (`pyk.proof`, `pyk.kcfg`), fuzzing (`pyk.ktool.kfuzz`), coverage (`pyk.kcovr`), a bug-report bundler (`pyk.utils.BugReport`) |
| [`evm-semantics` (KEVM)](https://github.com/runtimeverification/evm-semantics) | the flagship semantics | two backends from one definition (LLVM to run, Haskell to prove); continuously executes the official Ethereum test suites (VMTests/BlockchainTests, a pinned submodule) through the concrete backend |
| [`kontrol`](https://github.com/runtimeverification/kontrol) | the product shape | Foundry integration: existing Solidity tests become symbolic proof harnesses — "verification meets users where their tests already are" |
| the K releases page | release engineering | 100 pages of automated master releases (latest v7.1.337, 2026-06-18) with boilerplate bodies and no changelogs |

## 2. The lessons, ranked

Each lesson: what K does (grounded), what Yo has today (grounded), verdict.

### L1 — Proof artifacts are persistent, resumable, inspectable objects

**K:** a proof in pyk is not a batch run. `KCFGStore` persists the
exploration graph; `APRProof` (with `APRProofUseCacheResult`,
`APRProofExtendResult`, `APRProofExtendAndCacheResult`, `APRProofSubsumeResult`)
records which steps were discharged so re-running after an edit *extends*
the proof instead of restarting; `parallel_advance_proof()` advances
independent branches concurrently; `APRProofViewer`/`KCFGViewer` inspect
the result; every result type carries `FailureInfo`.

**Yo today:** the verify cache is a per-query verdict store keyed on a
hash of (source, contracts, callee contract set, solver pin, mode);
`--explain <fn>` renders one function's obligations and verdicts; the JSON
report carries per-obligation outcomes. There is no obligation-level
*identity* an agent can address: "re-run exactly this obligation with a
bigger budget", "which obligations changed after my edit" are not
expressible.

**Verdict: adopt — extend [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) T4.**
Give every obligation a stable id (the mangling scheme already makes
query names deterministic — surface them), and add `yo verify
--obligation <fn>/<id> [--rlimit N]` re-running one obligation with an
overridden budget, plus a stale/fresh marker when the cache key changed.
The line that must NOT move: this is inspection and re-query, **not**
interactive proof stepping — the non-goal is stepping through a proof
state and editing it in place; addressing a finished obligation's verdict
by id is diagnostics.

### L2 — The stuck-state lesson: observability before scale

**K:** KCFG TUIs and `FailureInfo` types exist because K's batch failures
were famously opaque — `kprove` dies on stuck symbolic execution with
unresolved side conditions (the ML research doc §3's "classic K pain
point"). The tooling to explore failures was built *after* the pain.

**Yo:** T4a (trigger observability) is deliberately ordered before T2
(auto-induction) in THEOREM_PROVING_NEXT's cost table for exactly this
reason: automation multiplies whatever the diagnostics can explain. An
`unproven` that says *why* (axiom never instantiated, budget, missing
case) keeps the LLM loop iterating; an opaque one ends it.

**Verdict: validation — no new work; keep the ordering.**

### L3 — A standing conformance corpus for trusted contracts

**K:** KEVM keeps its semantics honest by *running* it: the official
Ethereum VMTests/BlockchainTests are a pinned submodule, executed through
the concrete LLVM backend on every test run. The formal artifact is never
trusted on faith; a conformance corpus continuously executes it.

**Yo today:** std's `assumed()` contracts are axioms — a wrong `ensures`
on `push` is unsound for every verified caller. The R1 rule is "each
contract gets a runtime-mode fixture that executes it", landed as *per-PR
fixtures*; ATS_STYLE §7.1 measured that the runtime splice is kept
(+0.45% on a push-heavy workload) precisely so the asserts stay live.

**Verdict: adopt — a standing corpus, not per-PR fixtures.** One
CI battery executes every contracted std op's runtime-spliced asserts over
an edge-case grid (empty / one / capacity boundary / after growth /
after remove), so a wrong clause in `array_list.yo` or `hash_map.yo`
fails a named corpus row instead of waiting for a caller's refutation.
This is the cheap, continuous cousin of SELF_VERIFICATION's L9/M3
consistency *proofs*, and the safety net for THEOREM_PROVING_NEXT T1's
library (whose lemmas talk about those same contracts). Estimate: ~1 week,
mostly corpus authoring.

### L4 — Contract-clause usage as a coverage report

**K:** `pyk.kcovr` maps executions back to the rules that fired and
renders coverage — "which parts of the definition did this run exercise"
is a first-class artifact.

**Yo today:** the verifier already computes the data — `:named` VC
clauses + `(get-unsat-core)` give per-clause attribution ("the smallest
violated clause" diagnostics use it). But it is surfaced only on failure.

**Verdict: adopt (small) — surface it as coverage.** A report line per
verified function: which of the callee's `ensures` clauses the proof
actually *used*. The killer application is std: a clause of an
`assumed()` contract that no proof ever uses is either dead weight or a
specification nobody needs — and, in a trusted-axiom library, each unused
clause is unearned trust. Fold into T4's report surface; ~2–3 days.

### L5 — A reproducible bug-report bundle for verifier issues

**K:** `pyk.utils.BugReport` packages the commands, files and solver
requests that produced a failure into one attachable artifact — the
project's own experience: when the bug is in symbolic execution, "works
on my machine" is useless.

**Yo today:** verifier bugs are filed by hand into `issues/` with a
reproducer (repo discipline); assembling the SMT-LIB script and solver
pin by hand is the tedious part (`--explain` shows the goal, but the full
query context must be reconstructed).

**Verdict: adopt (small) — `yo verify --bug-report <fn>`** writes a
directory (the function source, contract predicates, the emitted
SMT-LIB scripts, verdicts, cache keys, solver pin and platform) ready to
attach to an `issues/` entry. Fits the existing `yo explain` / `yo fix`
diagnostics family. ~2–3 days.

### L6 — One spec, many engines — but Yo already made the better trade

**K:** Kontrol's pitch is reuse: the Foundry tests a team already runs
become symbolic proof harnesses; `kfuzz` fuzzes from the same definition.
One specification artifact feeds execution, fuzzing and proof.

**Yo today:** the same philosophy is already structural — one contract
serves CTFE (free), Z3 (cheap/annotated) and the runtime assert
(fallback); KEVM's calibration of *cost* (the ML research doc §5) is what
chose the Dafny tier. The one piece K has that Yo lacks: `.test.yo`
files are compiled with `--no-verify` by the test runner (a recorded V3
deviation), so the tests a user already wrote never feed the verifier.

**Verdict: park, with a trigger.** "A `test(...)` body is a proof harness"
— its asserts become obligations, its concrete inputs become CTFE-folded
facts — is a real candidate, but it changes what a test file *means*
under `yo verify`, and nobody has asked for it. Trigger: B4's evals
corpus or SELF_VERIFICATION M2 annotation loops showing agents
duplicating test content as laws. Revisit there, not here.

### L7 — The solver as a daemon: rejected with a measurement to beat

**K:** `pyk.kore.rpc` serves the rewriting engine over JSON-RPC
(`KoreClient`, `KoreServer`, `BoosterServer`, connection pooling) because
a JVM/Haskell process startup per query is genuinely expensive.

**Yo today:** one Z3 process per query, deliberately (V2 deviation #2) —
spawn cost measured at ms scale, and process isolation is part of the
determinism story. Nothing to fix while the spawn cost is ms.

**Verdict: reject, with the reopen condition stated.** A long-lived
solver process returns to the table only if a *measured* verify-round
latency budget (e.g. the LSP per-keystroke path or L8's incremental
rounds) shows process spawn as the dominant term — and then as an
implementation detail behind the same pinned-solver, rlimit-deterministic
contract, never as an API change.

### L8 — Calibration: pinning and release discipline (what not to copy)

Three observations, each a validation of a Yo rule or a caution:

1. K's own docs carry **two different Z3 pins** — the README requires
   exactly 4.12.1; the release-notes boilerplate says 4.8.15 "not
   supported older and newer". Lesson: a pin stated in prose multiplies;
   Yo's single manifest constant in `src/verifier/z3.yo` (with the cache
   keyed on it) is the right shape. Keep it.
2. KEVM pins its K version (`deps/k_release`) — a semantics repo pinning
   its toolchain is the same relationship as Yo's `SEED_VERSION` pinning
   the bootstrap compiler. Validation.
3. 100 pages of automated master releases with boilerplate bodies and no
   changelogs, then silence after 2026-06-18 — release notes nobody
   curates are release notes nobody reads. Yo's one-curation-pass-per-
   release rule (the v0.2.38 format) is the deliberate opposite. Keep it.

## 3. Not taken

- **A K semantics of Yo** (KEVM-model) as an external audit oracle —
  unchanged, parked in the ML research doc §8 and SELF_VERIFICATION's
  foundations table (research-collaboration cost; revisit only for a
  frozen safety-critical profile).
- **Using K/kprove as Yo's verifier backend** — rejected 2026-09-09 (ML
  research §6 Option C, with Option A): no solver decides matching logic;
  every discharge funnels back through the FOL/SMT step Yo already emits.
- **Proof-state TUIs / interactive viewers** — Yo's non-goal is proof
  states and stepping. L1's obligation surface (inspect, re-query) is the
  sanctioned form; an interactive proof editor is not, even dressed as a
  viewer.
- **The K tutorial/docs shape** — nothing for Yo beyond what
  `yo context` already does more directly.
- **Adopting K's frontend/backend split as architecture input** — Yo's
  D4 (a separate verifier pass over the evaluator's output) already
  delivers the same separation with one concrete interpreter; K's split
  exists because a K definition *is* the semantics, which is not Yo's
  situation (the ML research doc §6 Option A makes this exact point).

## 4. Where the adoptees land

| Lesson | Lands as | Size | Notes |
| --- | --- | --- | --- |
| L1 obligation ids + re-query | extension of THEOREM_PROVING_NEXT **T4** | ~1 week | stable ids in the JSON report; `--obligation` re-run with budget override |
| L4 clause-usage coverage | extension of THEOREM_PROVING_NEXT **T4** (report surface) | 2–3 days | unsat-core data already computed; render it always, not only on failure |
| L3 std conformance corpus | new small item beside THEOREM_PROVING_NEXT **T1** (its safety net) | ~1 week | a named CI battery over contracted std ops; extends R1's per-fixture rule |
| L5 `--bug-report` | standalone diagnostics item | 2–3 days | the `yo explain` / `yo fix` family |
| L6 tests-as-harnesses | parked (B4 / SELF_VERIFICATION trigger) | — | re-open where the corpus measures the duplication |
| L2, L7, L8 | validations / rejections, recorded | 0 | no work; the reasons above are the deliverable |

If T1–T4 are adopted from THEOREM_PROVING_NEXT, fold L1/L4 into T4's PRs
and L3 into T1's; L5 can land independently. None of the five touches
the evaluator, codegen or the language surface — all are verifier-driver
and report work.

## 5. References

- In-tree:
  [`../reference/MATCHING_LOGIC_RESEARCH.md`](../reference/MATCHING_LOGIC_RESEARCH.md)
  (the declined foundation; its §7 borrowings and §8 parked ideas are the
  prior record),
  [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) (the adoptees'
  home),
  [`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md) (R1's
  per-contract runtime fixture rule; §7.1's splice A/B),
  [`../SELF_VERIFICATION.md`](../SELF_VERIFICATION.md) (L9/M3, the proof-
  level conformance story L3 complements),
  [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) (the determinism
  contract L7 must preserve).
- External, audited 2026-10-08:
  [runtimeverification/k](https://github.com/runtimeverification/k)
  (repository layout; README's Z3 4.12.1 pin),
  [K releases](https://github.com/runtimeverification/k/releases)
  (v7.1.337 latest, 2026-06-18; boilerplate bodies with a 4.8.15 pin),
  [pyk API docs 7.1.337](https://kframework.org/pyk/api/pyk.html)
  (`pyk.proof`, `pyk.kcfg`, `pyk.kore.rpc`, `pyk.ktool.kfuzz`,
  `pyk.kcovr`, `pyk.utils.BugReport` — the L1/L4/L5/L6/L7 evidence),
  [evm-semantics](https://github.com/runtimeverification/evm-semantics)
  (the Ethereum-test-suite conformance discipline behind L3),
  [kontrol](https://github.com/runtimeverification/kontrol) (the
  tests-become-harnesses shape behind L6).
