# Yo verifies Yo — the self-verification campaign

**ACTIVE 2026-09-18.** The maintainer made "the Yo compiler is verified by
Yo's own verifier" a goal (this document started the same day as a
feasibility note in `backlog/`; it was promoted when the decision was
made). It is a selling point only if the claim behind it is true at every
stage, so the campaign is a **ladder of claims**, each checked in CI the
day it is made, each strictly stronger than the last. Companion plans:
[`backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md) (the
verifier), [`backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
(B0 `--strict`, B1 `law`, B2 lemmas — this campaign consumes them),
[`reference/MATCHING_LOGIC_RESEARCH.md`](reference/MATCHING_LOGIC_RESEARCH.md)
(the foundation alternative already assessed).

## The claim ladder

| Milestone | The sentence Yo may print on the box | What must be true |
| --- | --- | --- |
| **M0** | "Every function of the compiler is measured against the verifier; the number cannot go down." | S0 sweep + ratchet in CI; honest report (no vacuous `ok`, canonical ids) |
| **M1** | "Every arithmetic and layout decision the compiler makes about your program is proved against the same model it proves your program with." | comptime integer ops, casts, struct layout, the verifier's own width tables under `Pragma.Verify`, zero `assumed()`; verification fixpoint (seed vs tree) |
| **M2** | "The Yo front end (lexer, parser, formatter) is verified free of runtime errors." | strings, payload enums, exceptions, immutable-ref datatypes in the subset; every loop in ~7.6k LOC carries an invariant or is inferred |
| **M3** | "The verifier is verified: the code that checks your proofs is itself proved free of runtime errors, and its encoding is proved consistent with the evaluator." | `src/verifier/` + `src/types/` verified; consistency laws (B1) between CTFE and the SMT encoding |
| **M4** | "`yo verify --strict ./src` is green: the compiler is verified free of runtime errors and meets every stated contract, except the N functions at the FFI boundary, listed here." | the mutable-heap model, globals, invariant inference at scale over evaluator + codegen (156k LOC) |
| **M5** | "These passes are proved correct: …" | functional contracts on chosen passes (dup/drop balance, side-table re-keying, path canonicalization) |

What no milestone claims: **semantic preservation** (the emitted C means
what the Yo source means). That is CompCert's theorem, it needs a formal
semantics of Yo and of C11 in a proof assistant, and it stays a non-goal
(`FORMAL_VERIFICATION.md` §Non-goals). "Verified" on this ladder means what
it means for Dafny, SPARK and Prusti programs: no runtime errors on any
input, and every stated contract holds. Say exactly that.

Precedents, so the claim is calibrated: no SMT-contract language has
verified its own compiler. Dafny's newer backends written in Dafny are
verified for absence of runtime errors, not correctness; SPARK's compiler
is not in SPARK; CompCert and CakeML are verified compilers, but in Coq
and HOL4, not in themselves. M4 would be a first of its kind; M1–M3 are
each already a stronger statement than any competitor makes about its
toolchain.

## Baseline — measured 2026-09-18

`yo verify ./src --format json --std-path ./std`, tree `4ef01a66a`,
`yo 0.2.36`, Z3 5.1.0, Apple M-series:

| Metric | Value |
| --- | --- |
| Wall time (evaluate `src/` + verify) | 199 s (one 3.5k-LOC module alone: 6 s) |
| Functions registered as verify targets | 4,049 |
| `ok` | 57 (1.4%) |
| `ok` with at least one obligation discharged | **2** |
| `outside-subset` | 3,992 |
| `refuted` / `unproven` / `solver-error` | 0 |

First blocking construct per function:

| Count | Blocker |
| --- | --- |
| 3,636 | parameter outside the integer/bool/array subset |
| 104 | call to a callee without contracts |
| 101 | unbound runtime name (string literals, module-level globals) |
| 77 | call to an uncontracted, untyped callee |
| 31 + 9 | enum variant with payload in construction / malformed enum construction |
| 26 | field/method access |
| 7 | `while` without a leading `invariant(...)` |

**Re-measured by M0's own sweep** (`scripts/verify-src-sweep.sh`, the
tree-built binary `0.2.36-16-gc4fa8b4b8` rather than the seed): 3,673 functions,
52 `ok` of which **50 are vacuous**, 2 proved, 196 s. The proved count — the one
the ratchet tracks — is identical; the task count differs because the tree is 16
commits ahead of the seed that produced the first table. Read the numbers as a
pair: the seed's view and the tree's view of the same source.

Two report defects found by the sweep, filed and fixed in M0:
`issues/fixed/verify-report-fn-id-carries-file-scheme-absolute-path.md` (48 of
57 `ok` ids print as `fn@file:///<abs>/…`) and
`issues/fixed/verify-ok-with-zero-obligations-is-indistinguishable-from-a-proof.md`
(55 of 57 `ok` are vacuous).

## What the compiler needs from the verifier — the census

`scripts/verify_src_census.py` (M0) over the 3,799 `fn(...)` signatures in
`src/` — a function counts once per kind it needs; 19.4% need none of them.
The numbers below are the tool's, so they are reproducible and re-measurable
after every lever:

| Share | Signatures that take | Verifier work it implies |
| --- | --- | --- |
| 43.5% | `str` / `String` | strings as first-class subset values (Seq of bytes) — lever L1 |
| 43.8% | `AstExpr` / `ExprInfo` / `TypeValue` / `EvalValue` (`ref(enum)`) | **immutable reference types as datatypes** — lever L3 |
| 20.1% | `ArrayList` / `HashMap` / `HashSet` (`ref(struct)` over raw buffers) | collections through their std contracts — lever L4 |
| 14.0% | `EvalContext` / `Environment` (`ref(struct)`, mutated in place at 646 sites) | the mutable-heap model — lever L6 |
| 13.7% | `Exception` (1,413 `exn.throw` sites) | exceptions as exit paths — lever L2 |
| 4.6% | `Io` | not verified, by design (effects are the frame rule) |
| 2.9% / 0.6% | `own`/`inout` params / closures | already in the subset / stays out |

Other sizes that shape the plan: **3,382 `while` loops** (each needs an
invariant in `verify` mode), **285 module-level mutable registries**
(`g_*`: 79 `HashMap(String, …)`, 35 `ArrayList(String)`, …), **108
`unsafe(...)` sites** (the `assumed()` boundary), and **only 2 in-place
writes through a `ref(enum)`** in the whole tree (`src/env.yo:726`,
`src/evaluator/builtins/contracts.yo:2242`).

That last number is the finding that makes the campaign tractable.
Reference semantics only matter to a verifier under *mutation*. The AST,
the type values and the evaluated values are built and then read, never
written through (the AST's clone is share-on-recursion by design), so for
verification they are **algebraic datatypes, not heap objects**: no heap
model, no framing, just `declare-datatypes` — which the encoder already
emits for structs and enums. The genuinely mutable heap is confined to the
evaluator's context and environments, the global registries, and the
collections, and each of those has a cheaper answer than a general heap
model (L4–L6 below). LOC by area, for sizing the milestones:

| Area | LOC | fn signatures |
| --- | --- | --- |
| front end (`lexer`, `token`, `parser`, `expr`, `formatter`) | 7,624 | 96 |
| `src/verifier/` | 6,736 | 142 |
| `src/types/` | 9,808 | 285 |
| `src/evaluator/` | 98,397 | 766 |
| `src/codegen/` | 58,302 | 575 |
| `src/lsp/`, `src/doc/` | 13,774 | 188 |

## Foundations: do we have to stick to SMT contracts?

The maintainer asked whether the SMT-contract approach is the only route
and whether matching logic is related. The answer, per alternative:

| Foundation | What it would give self-verification | Verdict for this campaign |
| --- | --- | --- |
| **SMT contracts** (Dafny, SPARK, Prusti/Verus, Why3) — the current verifier | Automation: the solver does the per-iteration and per-branch reasoning; no proofs written | **Keep as the backend.** Its two known weaknesses are exactly the two campaign risks: annotation burden (3,382 loops) and framing (mutable refs). Both have known mitigations *inside* the SMT tradition — L6 and L7 below |
| **Dependent types / proof assistant** (Bend 2, Lean, Rocq, F*) | Full expressivity; CompCert/CakeML prove semantic preservation this way | Rejected for Yo (`backlog/DEPENDENT_TYPES_POSITION.md`); the Bend comparison shows the cost (hand-written inductions). Would also *not* make M4 cheaper: every loop still needs its invariant, now proved by hand |
| **Matching logic / K** | Define Yo's semantics once in K, get a symbolic executor and a reachability-logic prover | Assessed and declined 2026-09-09 (`reference/MATCHING_LOGIC_RESEARCH.md` §6 Option A): no solver decides it, every discharge funnels back through FOL/SMT-LIB, and its selling point ("semantics once") solves a problem Yo does not have — the evaluator *is* Yo's executable semantics. **Related, not alternative**: its §7 borrowings (proofs about the program that runs, flat-heap capture of separation logic) are the design input for L6. Its §8 parked idea — a K semantics of Yo as an *external audit oracle* — is the one thing that could ever check the M4 claim from outside, and it stays parked at research-collaboration cost |
| **Abstract interpretation** (Astrée, Frama-C EVA, Infer) | Absence of runtime errors on unannotated code, whole-program, no invariants written | **Adopt as a lever, not a foundation** (L7): an interval/octagon pass generates candidate loop invariants that the SMT verifier then *proves*, so the claim stays "verified", not "analyzed". This is how the 3,382 loops get done; it is the industry answer to AoRTE at scale |
| **Translation validation** (Alive2 for LLVM; per-compilation equivalence checks) | Check each compilation's output instead of the compiler | Out of scope: needs C11 semantics and an equivalence checker; D2 dropped external model checkers. Differential testing (CTFE vs compiled output over the corpus) already plays the pragmatic version of this role |
| **Ownership-based framing** (Prusti/Viper permissions from Rust ownership) | Framing for mutable heap without separation-logic annotations | Partially applicable: Yo's `inout` exclusivity and `own` give Prusti-style framing for parameters; shared RC refs do not. L6 chooses between this and Burstall-Bornat flat heaps for the mutable remainder |
| **Proof certificates** (Z3 proof logs + a small checker) | Remove Z3 from the trusted base | Parked (`MATCHING_LOGIC_RESEARCH.md` §8); relevant to M3's "the verifier is verified" sentence — the checker would be the thing to verify in Yo. V8+ at the earliest |

So: the backend stays SMT; the *front* grows two things the current
verifier plan does not have — invariant inference and a mutable-heap
model — and takes the datatype view of immutable references. None of that
changes decisions D1–D12 of `FORMAL_VERIFICATION.md`.

## Trust: who verifies the verifier

The verifier is part of the compiler, so "the compiler verifies itself" has
the shape of self-hosting: a binary vouching for its own source. The
bootstrap answer applies unchanged. The **seed release** verifies the tree;
the **tree-built binary** verifies the tree; the two verdict reports must
be byte-identical after path normalization — a *verification fixpoint*
next to the emission fixpoint (`scripts/bootstrap/fixpoint_only.sh`). Z3
is pinned and budgets are `rlimit`-deterministic, so a mismatch is a
compiler difference, never solver noise. Uncovered: a bug shared by seed
and tree, and the encoding itself (mitigated by the bugged-twin
discipline: every positive fixture has a deliberately broken sibling that
must refute, and M3's consistency laws check the encoding against CTFE).

## The levers — verifier work the campaign needs

Each lever is a slice of `FORMAL_VERIFICATION.md`'s deferred subset growth,
ordered by the census. Every lever ships with the S0 sweep re-run and the
new `ok`-with-obligations count in its PR description.

- **L1 Strings.** `str`/`String` as subset parameter and local types,
  encoded as `Seq (_ BitVec 8)`; `len()`, byte indexing, `==`, `+` as
  `seq.len` / `seq.nth` / `=` / `seq.++`; string literals as byte
  sequences. `str_bytes` (V5) becomes the identity view. UTF-8 validity
  stays axiomatized (FV Open Question 3). Unlocks 43% of signatures.
- **L2 Exceptions as exit paths.** `exn.throw(e)` is an abnormal exit:
  like `panic`, no `ensures` obligation on that path, but *recoverable*, so
  a call to a throwing callee splits into a normal path (assume `ensures`)
  and a throwing path (nothing assumed, control leaves the caller unless a
  handler is in the verified body — handlers stay outside the subset
  initially). An `Exception` parameter is accepted as an opaque token.
  Optional later: `throws(P)` exceptional postconditions.
- **L3 Immutable reference types as datatypes.** A `ref(struct)` /
  `ref(enum)` type that the verified body never writes through is encoded
  as its value datatype. The verifier checks the discipline syntactically
  per verified function (no `x.*.f = …`, no `inout` method call on the
  value); a violation is a subset error naming the write. The two existing
  writes are made explicit (`env.yo:726` is a `Variable` cell update, a
  mutable heap object by design → L6; `contracts.yo:2242` rewrites a
  FuncVal body during the `verify+` strip and is outside verified code).
  Unlocks 47% of signatures at once.
- **L4 Collections through their contracts.** `ArrayList(T)` is a
  `ref(struct)` over a raw buffer whose core ops already carry contracts
  and `assumed()` (V6 task 5). The verifier models an `ArrayList(T)` value
  as `(Seq T)` (and `HashMap(K, V)` as `(Array K (Option V))`,
  `HashSet(T)` as `(Array T Bool)`) and reads each std op's `ensures` as
  the transition on that model — no body opened. Aliasing (two refs to one
  list) is excluded for now by the same syntactic discipline as L3 on the
  *container* value plus `inout` exclusivity where it is mutated; a
  function that stores a collection into another heap object is a subset
  error until L6.
- **L5 Globals as implicit state.** A module-level `::` comptime constant
  folds. A mutable `g_*` registry is an implicit `inout` parameter of every
  function that reads or writes it (the effect analysis in
  `src/evaluator/effects/` already knows which functions touch which
  globals): entry value havoc'd, writes tracked two-state, `old(g)` legal.
- **L6 The mutable-heap model** — `EvalContext`, `Environment`, `Variable`
  cells and any collection stored in a heap object. Decision between (a)
  Burstall-Bornat flat heaps: one SMT array per (type, field), references
  as an uninterpreted sort, writes as array stores, framing by the effect
  analysis's write set; and (b) singleton-object treatment: a type with one
  live instance per verified call (`EvalContext`) is an implicit `inout`
  parameter like a global. Recommendation: (b) for `EvalContext` and
  `Environment` first (measure how much of the 14% it covers), (a) for the
  rest. FV Open Question 1 is decided here, for the compiler's shapes.
- **L7 Invariant inference.** An interval + zone (difference-bound)
  abstract interpretation over the verified body proposes candidate
  invariants per loop (bounds on the loop counter, `len` relations,
  monotone indices; D3); Houdini-style
  elimination keeps the inductive subset; the SMT verifier proves the
  result as if the user had written it, and `--explain` shows the inferred
  clauses. The user-written `invariant(...)` stays authoritative when
  present. Without L7, M4 is 3,382 hand-written invariants; with it, the
  hand-written ones are the interesting few.
- **L8 Incremental `yo verify`.** The cache is per query; add a per-function
  skip keyed on the function's source hash + callee contract set +
  solver pin (the `INCREMENTAL_COMPILATION_ZIG_LESSONS.md` per-definition
  hash), so `yo check ./src` under `Pragma.Verify` pays only for edited
  functions. Needed before any `src/` module opts in by default.
- **L9 Laws and lemmas** (B1/B2 of the Bend plan): the M1/M3 consistency
  proofs between CTFE and the encoding are `law`s over recursive spec
  functions.

## Milestones

Each milestone is several PRs; each PR states which lever or module it
lands and the sweep numbers before/after. Seed gate: contracts, pragmas
and invariants are old syntax (Phase 0), so annotating `src/` needs no
generation split; only `law` (B1) does.

### M0 — Measure, fix the report, ratchet (1–2 weeks)

1. `scripts/verify-src-sweep.sh`: runs the whole-tree sweep, writes
   `outcomes.tsv` (fn, outcome, blocker, obligations), prints the outcome
   and blocker tables; `scripts/verify-src-census.py` produces the
   signature census above. Both deterministic (sorted by canonical id).
2. Fix the two report issues (canonical fn ids; `ok (no obligations)` +
   `vacuous : true`).
3. Ratchet file `scripts/bootstrap/verify-src-baseline.tsv`: per module,
   the `ok`-with-obligations count; the sweep fails on a drop or on any
   `refuted`; a rise prints the new numbers to re-record deliberately.
4. CI job `verify-src` (not required until green for a week) runs the
   sweep and uploads `outcomes.tsv`; the README badge-level sentence is
   M0's claim.

**Exit:** sweep + ratchet in CI; both issues in `issues/fixed/`.

### M1 — The semantic kernel (4–6 weeks)

1. Comptime integer arithmetic (`src/evaluator/builtins/comptime_numeric_fns.yo`;
   D4): first the refactor that hands the pure carrier helpers
   `(bits : u8, signed : bool)` instead of a `TypeValue`, then `ensures`
   stating the bitvector result per op for every width and signedness
   (`apply_bounds` = the wrap, division/modulo/shift by signedness,
   `check_int_overflow`, `bit_not_int`, the `parse_i64`/`parse_raw_int`
   family, narrowing and widening casts); module under `Pragma.Verify`;
   zero `assumed()`. A refutation here is a silent
   miscompile of a constant expression — file it as an issue with the
   counter-example.
2. Struct layout (`src/target.yo` + codegen size/align/offset helpers):
   alignment divisibility, monotone aligned offsets, the per-target empty
   aggregate rule (MSVC 4 bytes, GNU 0) as explicit `ensures`.
3. The verifier's own tables (`src/verifier/encode.yo`): sort widths per
   type and target, `_measure_is_signed`, mangling determinism.
4. Verification fixpoint: `scripts/bootstrap/verify_fixpoint.sh` — the
   S0 sweep under the seed-built and tree-built binaries with
   `--no-cache`; `outcomes.tsv` byte-identical. Non-required CI step
   first.
5. Docs: `docs/{en-US,zh-CN}/SELF_VERIFICATION.md` stating M1's claim and
   exactly what it covers.

**Exit:** the three modules verify with zero `assumed()`; the fixpoint
step is green; M1's sentence is true and documented.

### M2 — The front end (one quarter)

Levers **L1, L2, L3, L4** (in that order — each re-measured), then annotate
`src/lexer.yo`, `token.yo`, `parser.yo`, `expr.yo`, `formatter.yo` under
`Pragma.Verify` with hand-written invariants (96 functions; count the
loops when starting — this is also the calibration for L7's value). Fix
what refutes; every refutation is an `issues/` entry. `assumed()` only at
`unsafe(...)` sites, each listed in the docs.

**Exit:** `yo verify --strict` (B0) green over the five modules; M2's
sentence documented with the `assumed()` list.

### M3 — The verifier and the type layer (one quarter)

Levers **L5, L8, L9**; annotate `src/verifier/` and `src/types/` (427
signatures). The consistency laws: for each comptime integer op, a `law`
stating that CTFE's result equals the encoder's bitvector term applied to
the same operands (M1 proved each side against the model; M3 states the
equality between the two implementations directly). `yo verify` becomes
incremental (L8) before `src/verifier/` opts in, so `yo check ./src` stays
usable.

**Exit:** `yo verify --strict src/verifier src/types` green; the
consistency laws in CI; `yo check ./src` wall time within 2× of today's.

### M4 — Evaluator and codegen (two to four quarters)

Levers **L6, L7**; then the long tail: 1,341 signatures, most of the 3,382
loops and the 646 context writes. The annotation work is done the way the
language is designed to be written — by an agent loop against
`yo verify --strict` with `--explain` and the counter-examples, module by
module, with the sweep's ratchet as the progress meter. Expect the
verifier to find real bugs in the evaluator and codegen (the std
dogfooding did); each is an issue + regression test.

**Exit:** `yo verify --strict ./src` green; the `assumed()` list is
exactly the FFI / raw-pointer boundary and is published; M4's sentence
goes on the README. Gate inside M4 (D2): after L3+L4+L5 and the singleton
treatment, re-run the census; flat heaps are built only if more than 5%
of signatures remain outside the subset for heap reasons.

### M5 — Proved passes (open-ended)

Functional contracts on the passes whose bugs have cost the most: dup/drop
balance per scope (a ghost counter + invariants; the emit-diff gate is
today's oracle), `_optimize_dup_drop_pairs` soundness (container outlives
local), `copy_func_contract_exprs` re-keying, `_canonical_module_path`
idempotence. Each is a `law` or an `ensures`, each a separate PR.

## Non-goals

- Semantic preservation; verifying the emitted C or the runtime C
  templates; verifying Z3; verifying the async state machines (FV Open
  Question 7); verifying `Io`-taking functions (they are the effect
  boundary by design).
- An external oracle for the self-verification claim (D5).
- Making `Pragma.Verify` mandatory for contributors' *user* code. `src/`
  opts in module by module; `runtime` stays the default for everyone else.

## Decisions (2026-09-18 — the maintainer asked for the recommended call on each open question)

| # | Question | Decision | Consequence in the plan |
| --- | --- | --- | --- |
| D1 | `verify` vs `verify+` for `src/` modules | **`verify+` while a module is being annotated, flipped to `verify` in the PR that finishes it.** The ratchet counts only `verify` modules; a `verify+` module contributes nothing to any claim on the ladder | M2–M4 module PRs come in pairs: "annotate under `verify+`" (build stays green, refutations are still errors) and "flip to `verify`" (the claim) |
| D2 | L6 heap model: flat per-type heaps vs singleton `inout` objects | **Singleton `inout` treatment first** for `EvalContext`, `Environment` and `Variable` cells (one live instance per verified call, modeled exactly like a global under L5), **then measure**: if the signatures still outside the subset after L3+L4+L5+singletons exceed 5% of the census, add Burstall-Bornat flat heaps for the remainder; otherwise flat heaps are not built | L6 in M4 starts as an extension of L5, not a new model; the 5% trigger is written into the M4 exit criteria |
| D3 | L7 inference domain | **Zones (difference-bound constraints) plus interval bounds and `len` relations** — the AoRTE shapes are `0 <= i < len(a)` and `j <= i`, which zones capture at O(n²) cost; full octagons are not built unless the measured closure rate on the M2 front-end loops is below 80% | L7 = intervals + zones + Houdini; the 80% number is measured on the M2 modules before M4 starts |
| D4 | Where the comptime operator implementations live | **Fact, not a choice** (looked up): one width-generic core in `src/evaluator/builtins/comptime_numeric_fns.yo` — `apply_bounds(n : i64, ty : TypeValue)` wraps to the width, `check_int_overflow`, `bit_not_int`, `make_int_val`, dispatched by `evaluate_yo_comptime_numeric_functions` over the op name and the `TypeValue`. So M1 task 1 is ~5–10 contracts on the carrier helpers, quantified over width and signedness, **after a small refactor**: the dispatcher extracts `(bits : u8, signed : bool)` from the `TypeValue` once and the pure helpers take those integers, so they verify before L3 exists | M1 task 1 gains the refactor as its first step; the `TypeValue` → `(bits, signed)` extraction is itself contracted (`ensures` bits ∈ {8,16,32,64}) |
| D5 | An external oracle for the M4 claim (K semantics or proof certificates) | **Not in this campaign.** The checks are the verification fixpoint (seed vs tree), the M3 consistency laws between CTFE and the encoding, and the bugged-twin discipline. Revisit only if a certification customer needs independent assurance; if so, Z3 proof logs + a checker written and verified in Yo is the cheaper route (`MATCHING_LOGIC_RESEARCH.md` §8) | Removed from the milestone list; kept as a sentence in Non-goals so nobody re-opens it without a customer |

## References

- [`backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md) —
  the verifier; §Non-goals, §The verifiable subset, Open Questions 1, 3, 7.
- [`backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
  — B0 `--strict`, B1 `law`, B2 lemmas (L9).
- [`reference/MATCHING_LOGIC_RESEARCH.md`](reference/MATCHING_LOGIC_RESEARCH.md)
  — the declined foundation, its §7 heap-model input (L6) and §8 parked
  external oracle (Open Question 5).
- [`backlog/DEPENDENT_TYPES_POSITION.md`](backlog/DEPENDENT_TYPES_POSITION.md).
- [`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md),
  `scripts/bootstrap/fixpoint_only.sh` — the fixpoint discipline M1 task 4
  extends.
- [`INCREMENTAL_COMPILATION_ZIG_LESSONS.md`](INCREMENTAL_COMPILATION_ZIG_LESSONS.md)
  — per-definition hashing (L8).
- [`reference/MEMORY_SAFETY.md`](reference/MEMORY_SAFETY.md) — the unsafe
  boundary = the `assumed()` list.
- External: Dafny (compiler backends written in Dafny, AoRTE-verified);
  Prusti/Viper (ownership-based framing); Frama-C EVA and Astrée
  (abstract interpretation for AoRTE at scale); Houdini (Flanagan &
  Leino, candidate-invariant inference); CompCert and CakeML (what a
  verified compiler is, and that neither is verified in itself).
