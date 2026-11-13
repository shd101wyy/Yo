# A proved core for Yo: end-to-end correctness without proving the compiler

**Status: DECIDED 2026-11-13 — backlog. Nothing here starts before VALUES_BY_DEFAULT
closes (v0.2.79).** The maintainer set the goal ("Yo should be fully proven: compiler
correctness proved end to end") and accepted the four verdicts in §1. This is a
separate lane. It does not displace lane E's phase 4
([`POST_VBD_PLAN.md`](POST_VBD_PLAN.md)), and it does not replace the verifier.

This document reverses one recorded non-goal: *semantic preservation*. It leaves every
other non-goal of [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md),
[`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) and
[`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) standing (§9). The amendments it
makes to those documents are listed in §10. Tree citations are to `origin/develop`
`0f82f79ee`; measurements were taken with `yo 0.2.77` on 2026-11-13 (no commit touches
`src/verifier/` or `src/evaluator/builtins/contracts.yo` between that tag and the
cited commit). *Judgment* marks an assessment.

## 1. Verdicts (maintainer, 2026-11-13)

| # | Question | Verdict |
| --- | --- | --- |
| V1 | Is semantic preservation still a non-goal? | **No. It is a goal, reached by a checked core, never by proving `src/`.** The compiler stays untrusted; a small checker, proved sound in a proof assistant, re-validates what the compiler produced (§4) |
| V2 | Which proof assistant holds the specification? | **Lean 4.** K stays declined as a foundation ([`../reference/MATCHING_LOGIC_RESEARCH.md`](../reference/MATCHING_LOGIC_RESEARCH.md) §6); the external-oracle role that document parked is taken by the Lean reference evaluator (P1) |
| V3 | When does it start? | **After VBD.** No rung starts before v0.2.80, and P0 is first |
| V4 | Does the Dafny-style verifier go away? | **No.** `yo verify` with the pinned Z3 stays the only proof path a Yo author uses. Lean is where the language's meaning and the checker's soundness are stated; no user ever needs it (§5) |

## 2. The claim, and what it does not claim

The sentence this plan works toward:

> Every program `yo` accepts has a Core form that a checker proved sound in Lean has
> validated: it cannot use freed memory, read through a dead reference or break an
> ownership rule. Its contracts mean Lean propositions about that Core form. The C that
> `yo` emits for it is validated against the Core form. Every step that is not proved is
> a named premise, printed with the result.

What stays a named premise at the end of the ladder in §6:

- **Elaboration.** The meaning of a surface program is *defined* as the meaning of its
  Core form. A compiler bug that elaborates `a + b` into a well-typed `a - b` is not
  caught by any proof here. Tests, the differential in P1 and the readable Core dump are
  the guards. Lean, GHC and Idris define their surface languages the same way.
- **The C compiler, the linker, libc and the runtime C templates** (the async state
  machines' I/O runtimes, the parallelism runtime, the allocators).
- **Z3**, until proof certificates are un-parked ([`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) §8).
- **Every `unsafe(...)` body and every `assumed()` contract**, one premise each (§5.2).

The re-derived-numbers rule and the phrase-to-rung table of
[`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) ("The claim ladder") apply unchanged: a
published sentence cites only numbers a gate re-derives, and "fully proven" may appear
in `README.md` or `docs/` only once P4 is green, with the premise list beside it.

## 3. Why the contract route cannot reach it

- **The verifier is part of the compiler it would vouch for.** A green
  `yo verify --strict ./src` says the compiler has no runtime errors and meets its
  stated contracts. It cannot say the emitted C means what the source means, because no
  contract states what a Yo program means.
- **Proving `src/` directly is out of reach.** `src/` is 317k lines. The measured cost
  of interactive proof is 7.5–14 proof lines per source line
  ([`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md), "Fact: interactive
  proof is expensive"), which is two to four million lines.
- **`src/` is not in the provable shape.** On `0f82f79ee` it has 150 `unsafe(` sites in
  37 of 274 files, 591 `RefCell` mentions in 71 files and 382 `io.async` sites in 69
  files.
- **The compiler has three independent readers of one annotated tree.** The evaluator
  checks the AST and fills `ExprInfo`; `src/verifier/vc.yo` (8,076 lines) reads AST plus
  `ExprInfo`; 27 codegen files read them again. Nothing forces the three to agree,
  and recorded pitfalls come from exactly that: a parameter bound in three places, a
  rule enforced only in codegen (E0905), every false proof on record originating in
  `vc.yo` (`issues/questions/2026-11-04-should-yo-check-externally-proved-lean-theorems-for-obligations-z3-cannot-close.md`,
  option D).

## 4. The architecture

```text
source.yo
   │  lexer, parser, evaluator (comptime, monomorphization, borrow check)   UNTRUSTED, 317k lines of Yo
   ▼
Core Yo            explicit: monomorphic, every clone/drop/borrow spelled, no comptime left
   │  Core checker   small; its rules are Lean judgments; proved sound in Lean
   ▼
checked Core ──────────────► contracts read as Lean propositions over Core (P3)
   │  codegen
   ▼
C11  ── validated against Core per compilation (P4); a named premise until then
   │  cc, linker, libc, runtime templates                                   NAMED PREMISES
   ▼
binary
```

- **Core Yo** is the one new compiler artifact. It is what is left after comptime
  evaluation, monomorphization and the borrow check: first-order, monomorphic, with
  every clone, drop, move and borrow explicit. VBD makes that form natural (decisions
  17, 42, 43, 48: explicit clones, values, origins, deterministic `Drop`). Yo has no
  such IR today.
- **The Core checker** re-validates the evaluator's output. The pattern is Lean's own
  (an untrusted elaborator in front of a small kernel) and GHC's Core Lint. An
  evaluator soundness bug then has two outcomes: Core the checker rejects, or Core that
  is accepted and therefore safe. `TYPE_SYSTEM_SOUNDNESS.md`'s goal ("make `yo check` a
  gate, not a filter") gets a second, independent gate.
- **The Lean specification** holds Core's syntax, its typing and ownership judgments,
  and a fuel-indexed evaluator in which running out of fuel is a different outcome from
  getting stuck. Rules are executable definitions; every rule carries accepted, refused
  and trapping examples decided by running the definitions.
- **Why not write the compiler in Lean.** It would end self-hosting, and it would not
  close the gap it appears to close: a binary compiled from proved Lean definitions is
  still not the proved function. Every verified compiler pays for that step, by trusted
  extraction (CompCert), by bootstrapping inside the logic (CakeML) or by checking each
  compilation's output. The last one is the only route open to a self-hosted compiler,
  and it is this plan.

## 5. Three questions this plan must answer

### 5.1 Is the Dafny-style verifier abandoned?

No (V4). The two layers have different jobs.

| | `yo verify` (Z3 contracts) | The Lean layer |
| --- | --- | --- |
| Who writes for it | every Yo author and agent | whoever works on the language's specification |
| What it proves | this function has no runtime error and meets its contract | the rules of the language are sound; the checker enforces them; a contract means what the verifier assumes it means |
| Where it runs | `yo check` / `yo compile` / `yo verify` | one CI job; optionally a release-grade checker binary |
| Shipped with `yo` | yes (Z3 is fetched on demand) | no |

*Judgment:* the evidence that put the verifier on the auto-active path still holds
([`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md) §3: the same
specifications close at 82.2% in Dafny and 26.8% in Lean for model authors). What
changes for the verifier is P3: its meaning gets an independent definition to be
checked against, which it has never had.

### 5.2 `unsafe` code and concurrency cannot be translated. How can Yo verify itself?

Two different claims are involved, and neither needs the compiler translated to Lean.

- **"Yo verifies Yo"** is the [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) ladder. It
  runs `yo verify` over `src/` with Z3. `unsafe(...)` bodies sit behind `assumed()`
  contracts, and M4's sentence already says so: green "except the N functions at the
  FFI boundary, listed here". `Io`-taking functions are outside it by design. That
  ladder is unchanged.
- **"The compiler is correct end to end"** is this plan, and here the compiler is
  *untrusted*. Its `unsafe` sites, its `RefCell`s and its thread pool are not proof
  subjects. What is proved is the Core checker and the rules it enforces, and what is
  checked is each compilation's output.

For the programs being compiled (the compiler compiling itself included):

- **An `unsafe(...)` body is an opaque function in the Lean model.** Its `assumed()`
  contract is its specification and a named premise. This is how every functional
  translation treats foreign and unsafe code. The premise list shrinks when a raw-buffer
  model lands ([`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md) R1).
- **Concurrency and async are outside the first Core fragments.** The async and
  parallelism runtimes are C templates emitted by codegen
  (`src/codegen/async/`, `src/codegen/parallelism/`), so they are premises in any case.
  A program that uses them gets the claim for its sequential part and a report naming
  what fell outside the fragment.
- **The honest sentence is "proved or named", never "everything proved".** A fragment
  boundary or a premise that is not printed is the failure this plan exists to prevent.

### 5.3 Does Yo need Lean installed? How large is the Lean evaluator?

No. The Lean evaluator is a reference used by CI. It is not linked into `yo`, not
shipped in a release bundle, and not needed to build, install or use the compiler.

- **Who needs the toolchain:** the specification's CI job and a person editing the
  specification. The pinned Lean toolchain is about 594 MB on Linux
  (`issues/questions/2026-11-04-should-yo-check-externally-proved-lean-theorems-for-obligations-z3-cannot-close.md`,
  option A), which is why it stays out of every user path.
- **Size (estimate, not a measurement):** a fuel-indexed evaluator for the first Core
  fragment (integers, structs, enums, `match`, loops, calls, `&`/`&mut`) is in the
  low thousands of lines of Lean, with its judgments and examples. P1 records the real
  number.
- **The Core checker runs in two places.** The copy inside `yo` is written in Yo, so
  the compiler stays self-hosted and needs nothing extra. The reference copy is the Lean
  definition the proof is about; Lean compiles it to a standalone native executable that
  needs no Lean installation. *Judgment:* if a release-grade mode is ever wanted, that
  executable is fetched on demand the way the pinned Z3 is, and the rules already
  recorded for certificate checkers apply to it
  ([`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) §8: a separately versioned
  binary, exact-match pinning, fail closed).

### 5.4 What does a Yo user do to verify their own program?

They use `yo verify`, and nothing else. This works today and this plan does not change
it. No rung adds a step, a file or an install for a Yo author.

1. **Write the specification in the source:** `requires(...)` and `ensures(...)` on
   functions, `invariant(...)` on loops, ghost lemmas for inductive facts.
2. **Opt the module in** with `pragma(Pragma.Verify);` (or
   `pragma(Pragma.VerifyOrAssert);`, which keeps a runtime check for what the solver
   cannot decide within its budget).
3. **Run `yo verify <path>`.** `yo check` and `yo compile` run the same proofs for a
   module that carries the pragma. The pinned Z3 is downloaded on first use.

Measured 2026-11-13 with `yo 0.2.77`:

```yo
pragma(Pragma.Verify);
{ ArrayList } :: import("std/collections/array_list");

get_unchecked :: (fn(xs : &ArrayList(i32), i : usize) -> (r : i32))(xs(i));

get :: (fn(xs : &ArrayList(i32), i : usize, requires(i < xs.len())) -> (r : i32))(xs(i));

first :: (fn(xs : &ArrayList(i32), requires(!xs.is_empty())) -> (r : i32))(get(xs, usize(0)));
```

```text
  refuted  fn@user_demo.yo:3 [verify]
    fn@user_demo.yo:3/index-in-bounds@4:69: REFUTED  counter-example: i = #xffffffffffffffff, xs = (List_bv32_mk …)
  ok       fn@user_demo.yo:5 [verify] — 1 obligation(s) proved
  ok       fn@user_demo.yo:7 [verify] — 1 obligation(s) proved
```

- **Safety obligations need no annotation.** Bounds, division by zero and shift widths
  are generated automatically: `get_unchecked` carries no contract and is still caught.
- **A failure is a counter-example**, which the author or their agent acts on.
- **Callers are checked against callees:** `first` is proved because its precondition
  implies `get`'s.
- **`--strict` is the gate that means what it says:** it also fails on `assumed`,
  `unproven` and `outside-subset`.

What the author meets today, and which plan owns it:

| Limit | Owner |
| --- | --- |
| Closures, `RefCell`, `Io` and async are `outside-subset` | [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) levers L1–L6 |
| Most std bodies are `assumed()`, so a proof that calls std rests on those contracts | [`POST_VBD_PLAN.md`](POST_VBD_PLAN.md) phase 4, item 1 |
| Nonlinear arithmetic and un-lemma'd inductive facts come back `unknown` | [`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md) §4 |

What this plan gives that author is indirect: a green `yo verify` then rests on rules
proved sound, and on a definition of "contract" that something other than the verifier
states (P3). The only way Lean could ever reach an author is the parked hatch for an
obligation Z3 cannot close, which is optional, unbuilt and behind its own trigger
(`issues/questions/2026-11-04-should-yo-check-externally-proved-lean-theorems-for-obligations-z3-cannot-close.md`).

Whether verification should be *on by default* is a separate decision, taken the same
day: [`DEFAULT_ON_VERIFICATION.md`](DEFAULT_ON_VERIFICATION.md).

## 6. The ladder

Each rung is useful if the work stops there. Each has a sentence it licenses and an
exit gate. All rungs are after VBD.

| Rung | What is built | Sentence it licenses | Compiler change |
| --- | --- | --- | --- |
| **P0** | The ownership and origin rules as Lean judgments on a small calculus, a reference checker, and a reference evaluator that is stuck on a use of freed or dead memory | "Yo's borrow rules have an executable specification, and the compiler agrees with it on N generated programs." | none |
| **P1** | `--emit-core` for the verifier's subset; the Lean evaluator run against the compiled binary in CI | "For the programs in the Core fragment, the compiled binary and the reference evaluator agree on every observed result." | a Core printer beside codegen |
| **P2** | The Core checker (in Yo, in the compiler) and the soundness proof of its Lean definition | "Every accepted program in the fragment has a Core form validated by a checker proved memory-safe." | the checker pass |
| **P3** | A contract's meaning as a Lean proposition over Core; a functional export of Core functions to Lean | "`yo verify`'s verdicts are cross-checked against an independent definition of what a contract means." | an exporter |
| **P4** | Validation of the emitted C against Core, per compilation | the sentence of §2 | a validator |

### P0 — the borrow rules, specified (first rung, v0.2.80 or later)

- **Input:** [`REFERENCES_AND_ORIGINS.md`](REFERENCES_AND_ORIGINS.md),
  [`BORROW_CHECKER_COMPLETENESS.md`](BORROW_CHECKER_COMPLETENESS.md) and the 2026-11-11
  audit. The rules must be frozen first, which is why this rung waits for VBD.
- **Why first.** The checker's soundness claim is asserted by tests today, and the
  oracle is "rustc agrees" (`scripts/origins-diff-rustc.sh`, the `DIVERGENCES.tsv`
  ledger). rustc is a different language's checker: every divergence row needs a human
  to say which side is right. A Yo-native executable specification settles each row by
  running it.
- **The gate.** `scripts/origins-gen.py` already renders enumerated borrow programs.
  Each one gets three verdicts: `yo check`, the Lean reference checker, and (for
  accepted programs) the Lean evaluator, which must never be stuck. A disagreement is
  an `issues/` entry.
- **The proof comes last.** *Judgment:* run the soundness statement as a property test
  over generated programs first; it finds what a proof would find at a fraction of the
  cost. The mechanized proof follows, rule group by rule group.
- **Exit:** the three-way agreement is a CI job, green for a week; every
  `DIVERGENCES.tsv` row is classified by the specification.

### P1 — Core Yo exists, and it is executable

- A Core printer walks the evaluated tree the way `vc.yo` does, for the verifier's
  subset first ([`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) "The verifiable
  subset"). Codegen does not consume Core yet.
- The differential: for each test program in the fragment, the Lean evaluator's result
  against the compiled binary's. Expected results are written independently and are
  never recorded from compiler output.
- *Judgment:* re-basing `vc.yo` and then codegen on Core is the real fix for the
  three-readers problem of §3. It is a large refactor, and this rung measures whether it
  is worth it by counting the disagreements the differential finds.
- **Exit:** the differential is a CI job; the fragment's coverage of `tests/` is a
  re-derived number.

### P2 — the checker and its proof

- The checker is written in the safe value subset of Yo, so that P3's exporter can
  translate it and the two copies can be compared mechanically.
- Soundness: a checked Core program is never stuck under the reference evaluator.
- **Exit:** the proof is checked by the Lean kernel with no `sorry`, no `native_decide`
  and only the three standard axioms; the in-compiler checker and the reference checker
  agree on the corpus and on the generator's output.

### P3 — what a contract means

- A Core function with `requires`/`ensures` is exported as a Lean function plus a Lean
  theorem statement. After VBD the translation is direct, because values are the default
  and references are scoped: only a returned `&mut` projection needs the backward-function
  treatment (`THEOREM_PROVING_DIRECTION.md` R3).
- First use: cross-check `vc.yo`. For a sample corpus, a function the verifier reports
  `ok` must have a provable Lean statement, and a refuted one must have a replayable
  counter-example. This is the "diverse oracle" role
  (`THEOREM_PROVING_DIRECTION.md` R4), not a user proof path.
- The obligation hatch (a committed Lean proof for an obligation Z3 cannot close) keeps
  its own trigger and its own question document; this rung builds the exporter it would
  need and nothing else.

### P4 — Core to C

- Research-grade. A Clight semantics in Lean 4 exists but is experimental.
- **Trigger:** P2 is green and the P1 differential has been quiet for two releases.
  Until then the C leg is a named premise, guarded by the differential and the
  sanitizer batteries.

## 7. Where specifications and proofs live

| What | Where | Committed? |
| --- | --- | --- |
| Contracts on a function | in the source, as today | yes |
| Lemma libraries | `std/spec/` | yes |
| The language specification | `spec/` at the repository root: a Lean project importing nothing from the compiler. `spec/YoSpec/Spec/` holds the readable definitions and examples; `spec/YoSpec/Proofs/` holds the proofs, which nobody needs to read to learn a rule | yes |
| Proofs about the compiler | with the specification, and they are about Core and the checker, never about `src/*.yo` | yes |
| Lean generated from Yo (P3) | build output under `yo-out/` | never |
| Hand-written Lean proofs about a Yo program, if the hatch ever opens | a `proofs/` directory in that package, bound to the function by a hash of its signature, contracts, body and toolchain; a stale proof fails closed and reports in its own column | yes |

- **One repository, one SHA.** The conformance gates compare the compiler with the
  specification, so both must be pinned by one commit.
- **A separate CI job** with a pinned Lean, outside `merge-gate` until it has been green
  for a week (the rule `verify-src` followed).
- **Specification hygiene**, from the first file: every rule is exercised by an
  example; every stated law has a planted counter-example that must fail; one mutation
  per rule must be caught by some example; the kernel replay runs from a fresh directory.

## 8. Verifier honesty items found on the way (no Lean needed)

These are independent of the ladder. They belong to lane E and are listed here because
the same audit found them.

1. **A proved result is capped by what it rests on.** Measured: a caller of a function
   whose `assumed()` contract is contradictory is reported `ok — 1 obligation(s) proved`
   with `vacuous: false`, and in `verify` mode the binary runs with no check. Filed as
   `issues/2026-11-13-a-contradictory-assumed-contract-makes-every-caller-proved.md`.
   The fix belongs with the vacuity gate of [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md).
2. **Every gate has a registered mutation that makes it fail.** The bugged-twin
   discipline covers fixtures, and the planned mutation gate covers `src/verifier/`.
   Neither covers the gates themselves: the `verify-src` ratchet, the verification
   fixpoint, `--claim-check`. A gate that has never been seen red has not been tested.
   S-sized per gate.
3. **One trusted-base statement.** A generated list of everything a green result rests
   on (the Z3 pin, the encoder hash, the C compiler, the runtime templates, the
   `assumed()` inventory), compared with a committed golden so that a premise can never
   be added silently. Extends LE2 ([`LEAN_ADOPTION_CANDIDATES.md`](LEAN_ADOPTION_CANDIDATES.md))
   and the trust pins.
4. **A per-site report of implicit checks.** For every bounds, division, shift and
   overflow site: proved absent, guarded at run time, or elided with its evidence; an
   unknown is printed as unknown and never satisfies a policy. `yo effects` reports
   capabilities only. Feeds [`SAFE_MODE.md`](SAFE_MODE.md).

## 9. What stays a non-goal

- A tactic language, proof states or interactive stepping inside Yo.
- Lean as a proof path for Yo authors, and Mathlib.
- Rewriting the compiler in a proof assistant, and proving `src/*.yo` line by line.
- A second user-facing solver (D2).
- Replaying one obligation in several kernels: they all check the formula one generator
  produced, so agreement adds no independence.
- Mandatory termination (D12), and removing the solver from admission.
- A native backend. Core validates against C.

## 10. Amendments made with this document

- [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md): "What no milestone claims", the
  Non-goals list and D5 now point here. Its ladder and sentences are unchanged.
- [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md): the §8 external-oracle row and
  the §9 semantic-preservation bullet.
- [`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md): §5 and the
  "verified-compiler ceiling" row of its do-not-adopt list.
- [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md): the "No verified compiler"
  non-goal.
- `issues/questions/2026-11-04-should-yo-check-externally-proved-lean-theorems-for-obligations-z3-cannot-close.md`:
  option D is no longer blocked by a non-goal; its recommendation (B) is untouched.
- [`POST_VBD_PLAN.md`](POST_VBD_PLAN.md), [`../ROADMAP.md`](../ROADMAP.md) and
  [`../README.md`](../README.md): the lane entry.

## 11. Open questions

1. **How large is the first Core fragment?** The verifier's subset is the proposal. P1
   measures what share of `tests/` it covers.
2. **Does codegen move onto Core?** Decided by P1's disagreement count, not now.
3. **Effects and async in Core.** A handler that resumes needs a monadic encoding.
   Deferred until a fragment that needs it is proposed.
4. **Who owns P0, and in which release does it start?** It needs the origin rules
   frozen, so not before v0.2.80.

## References

- Aeneas (functional translation of a borrow-checked language):
  <https://github.com/AeneasVerif/aeneas>.
- CompCert and CakeML: the two ways a verified compiler closes the gap between proved
  definitions and the running binary.
- Translation validation: Pnueli, Siegel and Singerman, TACAS 1998.
- A Clight semantics in Lean 4 (experimental): <https://github.com/Certora/clean>.
- In-tree: `scripts/origins-gen.py`, `scripts/origins-diff-rustc.sh`,
  `src/verifier/vc.yo`, `scripts/verify-src-sweep.sh`.
