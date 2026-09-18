# Verifying the Yo compiler with Yo — what is possible, and the plan

**PROPOSED 2026-09-18 — backlog.** Answers the question "can `src/` be
formally verified by Yo itself to prove its correctness?" with a measured
baseline, an honest scope, and phases S0–S4 another agent can pick up.
Companion to [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) (the
verifier this plan applies to its own compiler) and
[`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
(whose `law`/lemma phases B1–B2 this plan's S2 laws depend on).

## The short answer

**A verified compiler in the CompCert sense — a proof that the emitted C
preserves the meaning of the Yo source — is not possible with this verifier
and stays a non-goal** (`FORMAL_VERIFICATION.md` §Non-goals: "No verified
compiler"). It needs a formal semantics of Yo and of C11 and a proof
assistant to relate them; Yo has no proof language by decision
([`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md)), and the
verifier proves *contracts on functions*, not *semantic preservation across
a translation*. Bend 2, which does ship a proof language, does not verify
its compiler either ("99% AI-written and has not been fully audited").

**What is possible is everything the verifier can prove about any Yo
program, applied to the compiler as a program** — absence of runtime errors
(bounds, division, shifts), contracts, loop invariants, laws about pure
kernels — and today that is **almost nothing**, for a measured reason: the
compiler is written in the part of Yo the verifiable subset does not yet
cover. Making the compiler verifiable therefore *is* the subset-growth work
the verifier plan defers, with the compiler as the measuring stick. Where
it pays off first is the compiler's **semantic kernel**: the places where
the compiler must agree with C (comptime integer arithmetic, struct layout,
byte decoding), which are integer functions and are provable today, and
where a wrong answer is a silent miscompile.

## Baseline — measured 2026-09-18

`yo verify ./src --format json --std-path ./std` on the tree at `4ef01a66a`,
`yo 0.2.36`, Z3 5.1.0, Apple M-series:

| Metric | Value |
| --- | --- |
| Wall time (evaluate `src/` + verify) | 199 s |
| Functions registered as verify targets | 4,049 |
| `ok` | 57 (1.4%) |
| `ok` with at least one obligation discharged | **2** (`src/types/utils.yo:65`, `:1348`) |
| `outside-subset` | 3,992 |
| `refuted` / `unproven` / `solver-error` | 0 |

Why the 3,992 are outside the subset (first blocking construct per fn):

| Count | Blocking construct |
| --- | --- |
| 3,636 | parameter outside the integer/bool/array subset (`str`/`String`, structs, enums with payloads, `ref`/`object`, closures, `Io`, `Exception`) |
| 104 | call to a callee without contracts |
| 101 | unbound runtime name (string literals and module-level globals such as `g_current_target`, `CURRENT_YO_VERSION`) |
| 77 | call to an uncontracted, untyped callee |
| 31 | non-atom enum variant in construction |
| 26 | field/method access (outside the V3 core subset) |
| 9 | malformed enum construction |
| 7 | `while` loop without a leading `invariant(...)` |
| 1 | untyped expression |

Two report defects surfaced by the sweep (filed as issues, fixed in S0):
48 of the 57 `ok` fn ids print as `fn@file:///<absolute path>/src/...`
(demand-loaded modules carry the `file://` cache key — the "two spellings of
a module path" pitfall, now in a machine-specific report and cache key), and
an `ok` with **zero obligations** is indistinguishable from a real proof
(55 of the 57 are vacuous: nothing in the body generated an obligation).

## What "correctness of the compiler" can mean here

| Tier | Property class | Provable with | Compiler examples |
| --- | --- | --- | --- |
| **T1** Absence of runtime errors | no OOB index, no div-by-zero, no over-wide shift, no panic on a reachable path | AoRTE (V3) — no annotations | index arithmetic in `src/types/utils.yo`, `target.yo` layout, token position math, chunk assembly offsets |
| **T2** The semantic kernel agrees with C | a Yo function computes exactly what the emitted C will compute | contracts + the verifier's own bitvector model (V3–V4) | comptime integer ops (`+ - * / % << >>` on every width, signed/unsigned), narrowing/widening casts, `parse_i64`-family wrapping, struct size/align/offset per target, UTF-8 decode/encode, semver total order |
| **T3** Pipeline invariants | side tables consistent, RC dup/drop balanced per scope, canonical module paths compared canonically, `ExprInfo` present for every emitted node | needs the heap model (`object`/`ref`), strings, HashMaps in the subset — FV Open Question 1 | `_optimize_dup_drop_pairs` soundness ("container outlives local"), `copy_func_contract_exprs` re-keying, `_canonical_module_path` idempotence |
| **T4** Semantic preservation | Yo meaning = C meaning | a proof assistant + formal semantics | **non-goal** |

T1 is free once a function is in the subset. T2 is the highest value per
effort and is reachable *today* for pure integer functions — and it has a
special property: **the verifier's integer model is the oracle.** The
verifier models `i32` as `(_ BitVec 32)` with `-fwrapv` semantics precisely
so that a proof is about the program that runs; proving that the
evaluator's comptime `i32` addition satisfies `ensures(r == (a + b))` under
that model is a *consistency proof between two parts of the compiler*: the
CTFE engine and the verifier's encoding must agree with each other and with
C, or one of them is wrong. The `u64`-as-`i64`-bit-pattern history (div,
mod, shr and comparisons had to be redone unsigned) is exactly the bug
class this catches.

## Trust: who verifies the verifier

The verifier is part of the compiler, so "the compiler verifies itself" has
the same shape as self-hosting: a binary vouching for its own source. The
bootstrap answer applies unchanged. The seed release (the previous
published `yo`) verifies the tree; the tree-built binary verifies the tree;
the two verdict reports must be **byte-identical** after path
normalization — a *verification fixpoint* next to the emission fixpoint
(`scripts/bootstrap/fixpoint_only.sh`). Z3 is pinned and the budget is
`rlimit`-deterministic, so a mismatch is a compiler difference, never
solver noise. What this does not cover: a bug shared by seed and tree, and
the encoding itself (mitigated, as in the verifier plan, by the bugged-twin
discipline — every positive fixture has a deliberately broken sibling that
must refute).

## Phases

Each phase is its own PR. S0 first; S1 and S2 interleave (S2's kernel
contracts are the first consumers of every S1 subset step and the proof
that the step matters); S3 after S0; S4 waits for the heap model.

### S0 — Measure, fix the report, ratchet (1–2 days)

1. `scripts/verify-src-sweep.sh`: runs `yo verify ./src --format json
   --std-path ./std`, writes `outcomes.tsv` (fn, outcome, blocking
   construct) and prints the two tables above (outcome counts, blocker
   histogram with quoted names normalized). Resumable is unnecessary
   (199 s); deterministic ordering is (sort by fn id).
2. Fix the report's fn ids: `VerifyTask.fn_id` is built from the token's
   `module_path`; canonicalize with the same rule codegen uses
   (`_canonical_module_path`: strip `file://`, make relative to cwd) so the
   id is `fn@src/types/utils.yo:65` for entry and demand-loaded modules
   alike. The cache key must not contain an absolute path either. Issue:
   `issues/verify-report-fn-id-carries-file-scheme-absolute-path.md`.
3. Distinguish vacuous proofs: an `ok` task with zero obligations reports
   `ok (no obligations)` in text and `obligations : []` plus
   `vacuous : true` in JSON; `--strict` (B0 of the Bend plan) treats it as
   passing but the sweep counts it separately. Issue:
   `issues/verify-ok-with-zero-obligations-is-indistinguishable-from-a-proof.md`.
4. Ratchet: `scripts/bootstrap/verify-src-baseline.tsv` records, per
   module, the number of `ok`-with-obligations fns; the sweep fails when a
   module's count DROPS or when any fn is `refuted`; it prints the new
   counts when they rise so the baseline is re-recorded deliberately (the
   `known-failing.tsv` pattern). A CI job (`verify-src`, not required
   until it has been green for a week) runs the sweep and uploads
   `outcomes.tsv`.

**Exit:** the sweep runs in CI; the baseline file exists; both report
defects fixed with cli-case goldens.

### S1 — Grow the subset where the compiler is blocked (the 90%)

The blocker histogram is the work list, largest first. Every step
re-runs S0 and records the new `ok`-with-obligations count in the phase
banner — that number, not the step, is the deliverable.

1. **Plain `struct` parameters and field reads.** Datatypes are already
   encoded (`declare-datatypes` with selectors — FV §Sorts); the gate that
   rejects them is the *parameter-type* check, not the encoding. Accept a
   struct whose fields are all in the subset (recursively), lower field
   access to selectors, struct literals to constructors. Expected to unlock
   `target.yo` (layout structs), `token.yo`, `version.yo`'s parsed
   version, the resolver's semver structs.
2. **Enums with payloads**: construction (`non-atom enum variant`, 31 +
   9 malformed) and `match` destructuring over payload variants (the V3
   enum path handles atoms; payload binders map to selectors under the
   tester).
3. **`str` / `String` as first-class subset values**: today only ghost
   `str_bytes(s)` (V5) sees a string. Make `str` a subset parameter type
   encoded as `Seq (_ BitVec 8)` with `len()`, byte indexing, `==` and
   `+` (concat) as `seq.len`/`seq.nth`/`=`/`seq.++`; string LITERALS
   (101 "unbound runtime name" hits are mostly these) as `seq.unit`
   chains or `(as seq.empty ...)` plus literal bytes. Content reasoning
   beyond that (UTF-8 validity) stays axiomatized — FV Open Question 3.
4. **Module-level globals read in a body**: a `::`-bound comptime constant
   (`CURRENT_YO_VERSION`) folds; a mutable global (`g_current_target`) is
   a havoc'd input unless the fn is pure with respect to it — encode as an
   extra implicit parameter, document the rule.
5. **Contract-less callees** (104 + 77): the honest fix is contracts on
   the callee (S2), not a rule change; `verify+`'s fallback covers the
   rest. Report the callee's name in the blocker so S2 can rank by
   fan-in.
6. Out of scope for S1, named so nobody waits for it here: `ref`/`object`
   parameters and `HashMap`/`ArrayList` internals (heap model, FV Open
   Question 1), closures, `Io`/`Exception` parameters (effects are the
   frame rule: a fn taking `Io` is not pure and is not a verify target by
   design).

**Exit criteria per step:** the `ok`-with-obligations count rises and the
count is recorded; no `refuted` appears that is not a real bug (a real bug
becomes an `issues/` entry with a reproducer — this is the point).

**Estimate:** steps 1–2: 2–3 weeks; step 3: 2–3 weeks; steps 4–5: 1 week.

### S2 — The semantic kernel, contract-first

These are integer functions; most are provable before S1 lands. Each item:
find the functions, write `requires`/`ensures` that state agreement with
the C semantics, put the module under `pragma(Pragma.Verify)` (whole
module) or add `assumed()` only where the body is genuinely outside the
subset, run `yo verify`, fix what refutes.

1. **Comptime integer arithmetic** (`src/evaluator/` — the comptime
   operator implementations for `i8..i64`, `u8..u64`, `usize`; grep the
   `comptime_u64` / `parse_raw_int` / `parse_i64` family). Contracts state
   the bitvector result per width and signedness; the narrowing/widening
   casts state `extract`/`sign_extend`/`zero_extend`. The proof is a
   consistency proof between CTFE and the verifier's model (see above).
   **Highest value in the plan**: a refutation here is a silent
   miscompile of every constant expression.
2. **Struct layout** (`src/target.yo` and the codegen size/align/offset
   helpers): `ensures((size % align) == 0)`, offsets monotone and
   aligned, the per-target empty-aggregate rule (MSVC 4 bytes, GNU 0) as
   an explicit `ensures` per `CompilationTarget`.
3. **UTF-8 decode/encode** (string utils): over a byte array + index,
   `ensures` the decoded scalar is in range and the consumed length is
   1–4 and matches the lead byte; encode ∘ decode round-trips (a `law`
   once B1 lands). Waits for S1 step 3 if the functions take `str`.
4. **Semver / range grammar** (`src/resolver.yo`): `compare` is a total
   order — antisymmetry and transitivity as `law`s over the version
   struct (needs S1 step 1 + B1); `choose_ref` picks the maximum
   satisfying version (`ensures`).
5. **The verifier's own tables** (`src/verifier/encode.yo`): sort widths
   per type and target, `_measure_is_signed`, mangling determinism — the
   small pure helpers get contracts so the verifier cannot silently
   disagree with `src/target.yo` about `usize`'s width.

**Exit:** items 1, 2 and 5 verified in CI with the module-level pragma and
zero `assumed()`; 3 and 4 recorded as waiting on their S1 step.

**Estimate:** items 1, 2, 5: 2 weeks; 3–4: 1 week each after their
dependencies.

### S3 — The verification fixpoint (2–3 days, after S0)

Extend `scripts/bootstrap/fixpoint_only.sh` (or a sibling
`verify_fixpoint.sh`) so stage-1 and stage-2 binaries each run the S0
sweep with `--no-cache` and the two `outcomes.tsv` files must be
byte-identical. Wire into the fixpoint CI job as a non-required step
first. A mismatch is a compiler bug by construction (pinned Z3, rlimit
budgets, canonical ids from S0).

### S4 — Pipeline invariants (long-term; waits for the heap model)

Recorded as target properties so the heap-model design (FV Open
Question 1) is made with them in view; nothing here starts before
`object`/`ref` parameters enter the subset:

- `_optimize_dup_drop_pairs` soundness: a cancelled pair's container
  outlives the local (the emit-diff gate is today's oracle).
- Scope-end drop balance: every deferred `___dup` on an RC value in a
  scope is matched by exactly one drop on every exit path (a ghost counter
  + `invariant`).
- `copy_func_contract_exprs` re-keying: the side tables are readable under
  the FuncVal id iff they were registered under the fn-type id.
- `_canonical_module_path` is idempotent and identifies the two spellings.

## Non-goals

- Semantic preservation (T4); verifying the emitted C or the runtime C
  templates (a C-level tool such as CBMC or Frama-C would be a *different*
  project, and the verifier plan dropped external model checkers in D2);
  verifying Z3; verifying the async state machines (FV Open Question 7).
- Making `Pragma.Verify` mandatory anywhere in `src/`. Modules opt in as
  S2 reaches them; `runtime` mode stays the default.

## Open questions

1. **Whole-module pragma vs per-function opt-in in `src/`.** A module under
   `Pragma.Verify` pays verification time on every `yo check ./src`
   (199 s for the whole tree today, but that is with 98% of fns exiting
   at the parameter gate). Measure after S1 step 1 and decide whether
   `src/` uses `verify+` with the CI sweep as the strict gate.
2. **Seed gate for contracts in `src/`.** A contract clause is ordinary
   syntax the seed already parses (Phase 0 landed long ago), so S2 needs
   no generation split; `law`s (S2 items 3–4) do, via B1.
3. **Where the comptime operator implementations live** and whether they
   are one function per (op, width) or a generic over the width — decides
   whether S2 item 1 is 50 contracts or 5 abstract ones (V6 task 2 verifies
   generic bodies abstractly; width-dependent semantics may force
   per-width instantiation).

## References

- [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) — the verifier;
  §Non-goals ("No verified compiler"), §The verifiable subset, Open
  Questions 1 (heap model) and 3 (strings).
- [`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
  — B0 (`--strict`), B1 (`law`), B2 (lemmas), which S2 items 3–4 use.
- [`../archive/BOOTSTRAPPING.md`](../archive/BOOTSTRAPPING.md) and
  `scripts/bootstrap/fixpoint_only.sh` — the fixpoint discipline S3
  extends.
- [`../reference/MEMORY_SAFETY.md`](../reference/MEMORY_SAFETY.md) — the
  unsafe boundary the verifier refuses to cross (relevant to S1 step 6).
- CompCert (Leroy) — what a verified compiler is and why it is out of
  scope here; CakeML — the self-hosting verified-compiler precedent, built
  in HOL4, not in its own language's verifier.
