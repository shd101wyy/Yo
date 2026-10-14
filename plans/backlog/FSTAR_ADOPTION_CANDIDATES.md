# What Yo could take from F\*: dependent types the F\* way, verification, tactics

**Status: BACKLOG — research, written 2026-10-14 at the maintainer's
request.** The maintainer asked three things: whether Yo, having rejected
runtime dependent types, could support them *the way F\* does*; what the
verifier can learn from F\*; and whether anything like F\*'s tactics
belongs in Yo. Nothing here is adopted; each candidate ends with a verdict
and a trigger, and the maintainer picks. Every "Yo today" claim was checked
on the 2026-10-14 tree (develop `960a3904c`, seed v0.2.61) by grep or by
reading the cited file; an audit pass against develop on 2026-10-14
(seed v0.2.62) corrected 17 claims and settled the two that had been
marked unverified (refined results, F1; closed `ghost_fn` folding, F7) by
running probe programs through `yo verify`.
Every F\* claim cites a primary source (§8). Companions:
[`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md) (the charter;
this PR adds its "The F\* question" section),
[`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md) (the sibling
audit, whose shape this follows),
[`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) (T1–T4; several items
below are amendments to it, written here with evidence and pointed to from
there), [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) (the verifier),
[`K_FRAMEWORK_ENGINEERING_LESSONS.md`](K_FRAMEWORK_ENGINEERING_LESSONS.md)
(L1 stable obligation ids, which F4 builds on), and the format precedents
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md) /
[`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md).

## Table of contents

0. [The verdict in five sentences](#0-the-verdict-in-five-sentences)
1. [What F\* actually is (the model, not the folklore)](#1-what-f-actually-is-the-model-not-the-folklore)
2. [Where Yo and F\* already agree](#2-where-yo-and-f-already-agree)
3. [The dependent-types question, answered against F\*](#3-the-dependent-types-question-answered-against-f)
4. [Candidates](#4-candidates)
5. [Rejected, with the reason](#5-rejected-with-the-reason)
6. [Order and cost](#6-order-and-cost)
7. [Companion edits in this PR](#7-companion-edits-in-this-pr)
8. [Sources](#8-sources)

## 0. The verdict in five sentences

1. F\* is three separable things: **(a)** a full dependent type theory with
   a universe hierarchy — its own tutorial says "without the stratification
   of universes, F\* would be unsound" and that type checking "is
   undecidable in general"; **(b)** refinement types `x:t{φ}` whose
   checking is an SMT query, not a proof term ("F\* checks that `17` fits
   `x:int{x >= 0}` by asking the SMT solver to prove `17 >= 0`"; "no proof
   of φ is materialized"); **(c)** erasure — `GTot`, `erased`, `Lemma` and
   every proof are deleted before extraction, and the C that KaRaMeL emits
   is first-order Low\* code.
2. **(a)** is exactly what [`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md)
   rejects, and F\* is a confirmation of the cost, not a counter-example:
   F\* needs universes because its propositions are types (`prop`,
   `squash`); Yo's propositions are `bool` expressions in ghost context
   and a proof is never a value, so there is nothing to stratify.
3. **(b) + (c)** is Yo's Layer 2 as it stands today: `refine(T, p)` assumed
   at entry and proved at every call site (`refine#N`), literal
   obligations folded without a solver, ghost code erased, lemmas proved by
   induction, `decreases` with lexicographic measures.
4. "Support dependent types like F\* does" therefore means *keep every
   value dependency erased and SMT-discharged* — the design Yo already
   has. What the audit finds Yo lacks is the **pervasiveness and
   ergonomics** of that layer, not a type former: refinements ride only
   signatures (a binder erases them, no refined fields — F1, F2); lemmas
   fire only when named (F3); proofs replay from nothing on every change
   (F4); a recursive spec function needs a hand-written measure (F8); a
   definition the solver should not see cannot be hidden (F6).
5. On tactics, F\*'s own stance supports Yo's non-goal: "we only use
   tactics on those assertions that are particularly hard for the SMT
   solver", and "Meta-F\* does not yet allow a fully interactive style of
   proof". The jobs F\* tactics do most — normalization, arithmetic
   canonicalization, goal splitting — are fixed verifier passes Yo can
   ship without a tactic language (F12).

## 1. What F\* actually is (the model, not the folklore)

| F\* feature | What it is | Source |
| --- | --- | --- |
| **Core** | A dependently typed λ-calculus with `Type u#0 : Type u#1 : …`; universe polymorphism on top-level definitions only; `prop` as the type of propositions and `squash p` as its proof-irrelevant `Type u#0` form | tutorial, *Universes* |
| **Refinement types** | `x:t{φ}`; subtyping and construction are SMT queries; proof-irrelevant; "typechecking is undecidable in general"; "F\* trusts the encoding and Z3" | tutorial, *Propositions and assertions*; ICFP 2015 |
| **Effects** | WP-indexed computation types: `Tot t = PURE t (fun post -> forall x. post x)`; `Pure a req ens` = `PURE a (fun post -> req /\ (forall x. ens x ==> post x))`; `Lemma (requires pre) (ensures post) [SMTPat …]` desugars to `Lemma unit pre (fun _ -> post) [pats]`; ordering `Tot < GTot`, `Tot < Dv`; user-defined effects as Dijkstra monads (POPL 2017) and indexed/layered effects (Rastogi et al.) | tutorial, *Primitive effect refinements*; DM4Free; *Indexed Effects* |
| **Termination** | "a semantic check, not a syntactic criterion": a measure over the arguments must decrease on each recursive call under the well-founded `<<` (naturals; sub-term ordering on inductive values; `%[a; b]` lexicographic); the default measure is "the lexicographic ordering of all the non-function-typed arguments" left to right | tutorial, *Proofs of termination* |
| **Erasure** | `GTot` computations are erased; `erased t` with `hide : a -> erased a` and `reveal : erased a -> GTot a`; `[@@erasable]` inductives extract to `unit`; the non-informative promotion rule (`GTot s` is `Tot s` when `s` carries no information); "it is crucial that `GTot` terms cannot be used in `Tot` contexts" | tutorial, *Erasure and the Ghost effect* |
| **SMT encoding** | Z3, E-matching with explicit patterns — F\* "completely turns off the SMT solver's fancy quantifier instantiation techniques" (MBQI); `fuel`/`ifuel` bound recursive unfolding and inversion ("each unfolding consumes a unit of fuel"); `assert_norm` runs the normalizer "before encoding the problem to the SMT solver"; `[@"opaque_to_smt"]` + `reveal_opaque` hide a definition and reveal it in one scope; `--z3rlimit` (deterministic), `--z3refresh`, `--split_queries`, `--query_stats`, `--log_queries` | wiki: *Quantifiers and patterns*, *Fuel and the normalizer*, *Hiding definitions from Z3*; proof-copilot `smtprofiling` |
| **Hints** | `--record_hints` writes `foo.fst.hints`: "an unsat-core for every proof obligation that was successfully verified"; `--use_hints` sends the core first and, on failure, "the verification condition is fed again to Z3, without any hints"; "Having successful hint replay is a *prerequisite* to ensure that your file will continue to verify in the face of changes to F\* and Z3" | wiki: *Robust, replayable proofs using unsat cores* |
| **Lemmas** | "Proofs by induction in F\* are represented by total recursive functions"; intrinsic (in the type) vs extrinsic (a lemma) proofs — "generally useful properties are often good candidates for intrinsic specification", "more specific properties are better stated and proven as lemmas"; `calc` is "simply a desugaring artifact" whose steps are justified by SMT (`{}`) or a lemma call, with a transitivity side condition | tutorial, *Lemmas*; wiki, *Calculational proofs* |
| **Meta-F\*** | Tactics are metaprograms in a custom effect, attached to one assertion (`assert P by tac`); they "operate on the 'goal'", split or normalize it, and hand the rest to Z3; `compute`, `norm`, `trivial`, `smt`, `mapply`, `dump`; no interactive style; the `smt` tactic only queues the goal | tutorial, *An overview of tactics*; ESOP 2019 |
| **Low\* / KaRaMeL** | "a shallow embedding of a small, sequential, well-behaved subset of C in F\*"; specifications and proofs are erased at extraction; the translation to C is proved to preserve semantics and side-channel resistance; ~28k lines of verified crypto (HACL\*) "competitive with existing unverified C cryptographic libraries" | ICFP 2017 |
| **Pulse / PulseCore** | A concurrent-separation-logic DSL embedded in F\* ("similar in many ways to Iris"), grown from Steel, on PulseCore (PLDI 2025, formalized inside F\*); now part of the F\* repository; used for verified firmware, data formatting and CPU/GPU programs, extracted to OCaml, C or Rust | tutorial, *Pulse*; PulseCore; FStarLang/pulse |
| **LLM authorship** | FStarDataSet: 940k lines, 54k top-level definitions, each "given an F\* type as a specification, produce a matching definition", with a checker in the loop; "fine-tuned smaller language models … compare favorably with large language models (such as GPT-4)"; retrieval by types "boosts performance significantly". `proof-copilot`: eight agent skills (`smtprofiling` with "a catalog of 10 proven stabilization techniques", `proofdebugging`, `fstarmcp` for re-typechecking "without restarting F\*", …) | ICSE 2025; FStarLang/proof-copilot |

Two facts shape every verdict below. F\* **is** a proof assistant with an
SMT front: the dependent core exists so that specifications, lemma
statements and indices can be first-class terms, and the whole engineering
surface around it — fuel, patterns, hints, `opaque_to_smt`, `--split_queries`,
the ten stabilization techniques — exists to keep the SMT skeleton stable
*despite* that expressiveness. And the F\* code that ships (HACL\*,
EverParse, the Windows/Linux/Firefox crypto) is Low\*: first-order, erased
to C, exactly the shape Yo's verifiable subset already is.

## 2. Where Yo and F\* already agree

Listed so nobody proposes it again.

| F\* | Yo today | Where |
| --- | --- | --- |
| `x:t{φ}` refinement, erased, SMT-discharged | `refine(T, p)`: the callee assumes `p(param)` at entry, every call site proves `refine#N`; `NonZero(T)`, `Bounded(T, lo, hi)`, `Positive(T)`, … | `docs/en-US/FORMAL_VERIFICATION.md` §Refinement types; `src/evaluator/types/function.yo:638` (`g_func_refined_params`); `std/spec/refine.yo` |
| Proof irrelevance (`squash`, refinements materialize no proof) | predicates are `bool`; `ghost` values never reach codegen; "ghost value escapes specification context" is an error | FV §Ghost erasure (V5) |
| `Lemma` as a total recursive function = induction | a unit `ghost_fn` with `ensures` (+ `decreases`) is proved once by induction; the self-call's `ensures` is the hypothesis | `src/verifier/vc.yo` (~L6086, `is_lemma`); `docs/en-US/FORMAL_VERIFICATION.md` §Lemmas |
| `Pure a req ens`, `Lemma (requires) (ensures)` | `requires(...)` / `ensures(...)`, named return `-> (r : T)` | FV D3 |
| `decreases %[m; n]` | `decreases(m, n)` | ATS lessons A5 |
| `GTot`, `erased`, `hide`/`reveal` | `ghost(...)` bindings, `ghost_fn`, erased in verify mode | FV V5 task 3 |
| `assert_norm`, the normalizer | literal obligations constant-fold at emission (`folded`, never a query); comptime functions need no VCs | `src/verifier/vc.yo:672`, `_fold_*` / `_fold_term` (L885–L1177, applied to the goal at L1421); FV §`comptime` functions need no VCs |
| `--z3rlimit`, fixed seeds | `:rlimit` budgets, `:random-seed 0`, one deterministic 20× retry, cache keyed on the pin | FV D7; `src/verifier/driver.yo:349` |
| `--z3refresh` (fresh solver per query) | always: one fresh Z3 process per obligation (`run_vc_query`, `src/verifier/driver.yo:355`) | `driver.yo`, `z3.yo:333` |
| `assume` / `admit` — "a proof isn't done until it's free of them" | `assumed()` on std's trusted contracts; `yo verify --strict` denies `assumed`, `outside-subset`, `unproven` | BEND B0 |
| Intrinsic vs extrinsic proofs | `ensures` on the function vs `law` / lemma beside it | BEND B1 |
| Unsat cores | plumbing only: `:produce-unsat-cores` and `(get-unsat-core)` are emitted and `Proved` carries the core, but production assumptions are unnamed, so the core is empty | `src/verifier/encode.yo:580–587`, `vc.yo:1310`, `driver.yo:291` |
| Inductives as SMT datatypes | value enums as `declare-datatypes`, `match` as `ite` over testers | `docs/en-US/FORMAL_VERIFICATION.md` §The verifiable subset |
| Low\*: a verified C-like subset | the verifiable subset (SPARK's discipline) and safe mode | FV §The verifiable subset; `plans/SAFE_MODE.md` |
| Interfaces (`.fsti`) hide an implementation from clients | `_`-prefix privacy and `export(...)`; the SMT-visibility half is F6 | `plans/reference/MEMBER_VISIBILITY.md` |
| `calc` | planned as T3 | THEOREM_PROVING_NEXT §5 (confirmed by F10) |

## 3. The dependent-types question, answered against F\*

### 3.1 What F\*'s dependent core costs, in F\*'s own words

The position document's reason 1 — "type equality becomes proof search" —
is F\*'s daily reality, and F\* says so: type checking "is undecidable in
general"; a refinement check "trusts the encoding and Z3"; the universe
hierarchy is mandatory for soundness ("without the stratification of
universes, F\* would be unsound", demonstrated by encoding Russell's
paradox). The surface a user tunes is the evidence of the cost: `fuel` and
`ifuel` per scope ("Increasing the fuel is expensive"), explicit `:pattern`
triggers on every quantifier because "one shouldn't rely on" inferred
ones, `opaque_to_smt` born of HACL\* proofs that "had been relying on
workarounds like `--using_facts_from`, higher `z3rlimit` values, and
splitting code into smaller functions", and hints because proofs "may start
failing as F\* and Z3 evolve". None of this contradicts F\*'s success; it
is what a dependent core with an SMT front costs *at scale*, and it is the
cost the position declined to pay.

### 3.2 What dependent types buy in the F\* code that ships

HACL\* and EverParse are Low\*: buffers whose lengths are machine integers
refined by `{ n = len }`, ghost sequences (`erased`) describing contents,
lemmas relating the two, and every index, proof and ghost field erased
before KaRaMeL emits C. The dependent core is used to *state* these
(indices and views are first-class terms); the *checking* is refinement
subtyping by Z3, and the *runtime* types are C types. That is, line for
line, Yo's two layers: comptime indices (`Array(T, N)`,
`generic(N : usize)`) where the length is a constant, and the verifier's
length-indexed `ArrayList` model, `seq_of(xs)`, `ms_of(a)` and `refine`
where it is not ([`ATS_STYLE_INDEXED_TYPES.md`](ATS_STYLE_INDEXED_TYPES.md)
§3 draws the same correspondence for ATS, and F\*'s Low\* lands on the
same side of it).

### 3.3 The one real gap: pervasiveness

Where F\* genuinely differs from Yo's Layer 2 is that a refinement is a
*type* that flows through every binding position — a `let x : nat = e`
is an obligation, a record field can be `n:nat{n < 100}`, a function's
result type `x:nat{x > 0}` is proved at every exit and assumed at every
call — and a ghost value can live *inside* a runtime value (`erased`
fields). In Yo today a refinement lives in the function signature only:
the callee assumes it, the caller proves it, a call's result keeps its
declared `refine(...)` for dispatch, but "a binder erases a refinement"
(`tests/spec/refine_types.test.yo:148`); a `refine(T, p)` annotation may be
written in any type position and evaluates to the nested-distinct type
`RefineT(T, p)`, which every binder erases to `T` (`src/env.yo`,
`t_refine_inner`); the verifier reads it only from a function's resolved
parameter types (`g_func_refined_params`,
`src/evaluator/types/function.yo:638`, filled at `:4502–4523`; the
node-id registry `register_refine_annotation` at `:683` has no reader), so
a refined field or local carries no obligation and no assumption; and
there is no ghost field or ghost parameter anywhere in the tree (grep over
`plans/`, `docs/`, `issues/`: none). Closing that is F1 and F2, and it is Layer-2
work: obligations stay in the verifier pass, the checker only records
where a refinement sits — ATS audit §4's reasons 3–4 (no solver inside
unification) are untouched.

### 3.4 Verdict

**Uphold the position; amend it with this audit.** F\* does not have a way
to "support runtime dependent types" that avoids the costs the position
names — it pays them, and tames them with a decade of SMT engineering that
Yo would also have to copy. What F\* has that Yo wants is the erased,
SMT-discharged layer made pervasive (F1, F2), and the engineering that
keeps SMT proofs stable (F3–F9). The non-goals in the position (universes,
propositional equality in the core, type-level computation over runtime
values, dependent pattern matching) all stand.

## 4. Candidates

Each item: F\* fact → Yo today (cited) → proposal → verdict and trigger.
Yo sketches are fenced ` ```yo ignore ` because their spellings are open.

### F1 Refinements that flow: binders, returns, fields

**F\*.** `let x : nat = e` is a subtyping obligation `e >= 0`; a result
type `x:nat{x > 0}` is proved at the function's exits; record fields carry
refinements.

**Yo today.** A refined *parameter* is assumed at entry and proved by the
caller (`refine#N`); the caller may pass a plain value and prove `refine#N`
from its own path, so a refined parameter needs no gate in verified code
(`tests/spec/fixtures/valid/refine_nonzero.yo:17`). A refined *result* is
not a spec: the call's ExprInfo keeps its declared `refine(...)` type
(operator and method dispatch erase it, `refine_types.test.yo:148–159`),
but the verifier neither proves the predicate at the callee's exits nor
assumes it after the call. `get_func_refined_params` is per-parameter only
(`src/verifier/vc.yo:6155`, `6235`, `6818`), and
`issues/fixed/an-operator-on-a-refined-value-finds-no-impl.md` records that
a refined result type is never read as a spec: a function declared
`-> refine(i32, p)` that returns a value violating `p` verifies with no
obligation. A refined *local* annotation `d : NonZero(i32) = e` erases to
`i32` with no obligation ("a binder erases a refinement"). A refined
*field* type is accepted, and its type is a `RefineT`, but the verifier
never reads it: it strips every `RefineT` with `t_refine_inner` except on
parameters, so `struct(n : NonZero(i32))` is a plain `i32` field to the
verifier. A plain `T` even converts to a refined type silently, for
example as a return value (`refine_types.test.yo`'s `abs_nn`), so
`std/spec/refine.yo`'s "a plain `T` does not coerce silently" is stale.
The `check_*` gate (an `Option`) or the unsafe-capable `unchecked` cast is
only the way to manufacture a refined value outside a proof. What verified
code lacks is a refinement that a binder, a result or a field *carries*
once proved, so the fact survives being stored or returned.

**Proposal.**

- (a) **Binder obligation.** `d : refine(T, p) = e` (and `d := e` against
  a declared refined type) emits `refine#` for `e` under the path
  condition and the binding carries the refinement from then on. In a
  verified function, `if(x != i32(0), { d : NonZero(i32) = x; … })`
  proves from the branch condition. Inside one function this buys little
  (the divisor obligation in the sketch below already proves from the
  path today); it matters once the fact must outlive the path that proved
  it, as a loop-carried binder or a value passed on.
- (b) **Result obligation.** A refined return type is proved at every
  normal exit (like `ensures`) and assumed after every call (like
  `ensures`); then `abs_nn :: (fn(x : i32) -> refine(i32, _nonneg_i32))`
  means what it says to callers.
- (c) **Field refinement.** `struct(n : Bounded(usize, 0, 99))` proves at
  construction and at every write through `&mut`, assumes at every read.
  This is a one-field type invariant: it is where D11 (type invariants,
  FV Open Question 6) starts, and it is the erased form of F\*'s
  dependent record.

```yo ignore
// (a): verifies today from the path; with (a), `d` itself carries NonZero
safe_recip :: (fn(x : i32) -> (r : i32))(
  if(x != i32(0), { d : NonZero(i32) = x; i32(1) / d }, i32(0))
);
```

**Cost and risk.** (a) and (b) are verifier-pass work plus a binder rule
in the evaluator (the type is already "nested-distinct"); the type-identity
campaign owns how a refined type compares, and (a) must not add a new
type-variable kind. (c) touches construction, `&mut` writes and VBD's
value semantics and should wait for the heap/ownership model of
`SELF_VERIFICATION` L6.

**Verdict: adopt (a) and (b), size S–M; (c) as the first slice of D11
when type invariants are prioritized.** Trigger: the SELF_VERIFICATION M2
census finds a verified function that has to re-prove a predicate it
already established (a refined result or field restated as `ensures` or
`requires`).

### F2 Ghost fields and ghost parameters (F\*'s `erased`)

**F\*.** `erased t` is "the computationally irrelevant counterpart" of
`t`; a vector carrying an `erased nat` index extracts it to `()`; ghost
state rides beside runtime state at zero cost, and `reveal` is only legal
in ghost context.

**Yo today.** Ghost state exists as `ghost(...)` bindings and `ghost_fn`
values only. A struct cannot carry a ghost field; a function cannot take a
ghost parameter. The idioms that need one — a verified wrapper carrying its
`Seq` view beside the buffer, a parser carrying its ghost consumed prefix,
a typestate handle carrying a ghost state value instead of a phantom type
(ATS lessons A6) — are not expressible.

**Proposal.** `ghost(f) : T` as a struct-field and parameter spelling:
readable only in ghost context (the existing escape error), initialized
in ghost context at construction, erased by codegen exactly as V5 erases
ghost bindings, and present in the verifier's struct model as an ordinary
component. A ghost parameter is the F\* `erased` argument: passed in
ghost context, free at runtime.

**Verdict: adopt, size M, after F1(c)** (a ghost field is a field, and its
erasure and the field-refinement obligation share the construction and
write sites). Trigger: the first SELF_VERIFICATION lever (L6's heap model
or an M2 module) that wants a specification view beside a runtime value
and today has to thread it as a separate ghost binding.

### F3 Auto-firing lemmas (`SMTPat`), and the T1 ↔ T4b coupling

**F\*.** "a forall quantifier is instantiated only when its pattern is
triggered"; a lemma with `[SMTPat (f x)]` becomes an ambient fact, and
"Without it … lemmas do not get added to the proof context and have to be
called and fully instantiated manually"; F\* turns MBQI off and demands
"good patterns for all quantifiers one introduces". The hazards are
documented in the same place: a lemma that never fires because no trigger
term appears, and "this trivial equality is simplified to True before the
SMT solver sees it", so the trigger term vanishes.

**Yo today.** Quantifiers use MBQI ("explicit `:pattern` triggers are
deferred until a benchmark needs them", `src/verifier/vc.yo:3623`;
`terms.yo:180`); definitional axioms of `decreases`-carrying `ghost_fn`s (`vc.yo:5902`),
the list-append contents axiom (`vc.yo:3790`) and the `ms_of` axioms
(`vc.yo:4581`, `5306`) are triggered; a lemma
is used only by naming it, `ghost(lemma(args))`. THEOREM_PROVING_NEXT T1
(the std lemma library) and T4b (a user-facing `trigger(...)`) are
separate items with T4b gated on T1's gaps.

**The lesson.** F\*'s lemma libraries (`FStar.Seq`, `FStar.Math.Lemmas`)
are usable at scale because many of their lemmas carry `SMTPat` and fire
ambiently; a library whose
every lemma must be named and instantiated by the caller still makes the
caller know the lemma's name and its instance — which is the burden T1
exists to remove. T1 and T4b are one item.

**Proposal.** A lemma may declare a trigger (spelling open: a ghost clause
in the signature, say `trigger(count(xs, v))`); such a lemma is added as a
`:pattern`-triggered quantified axiom to every obligation of a module that
imports its `std/spec` module. Manual `ghost(lemma(...))` stays. Ship
with the F\*-documented guards: T4a observability first (which axioms were
declared, which triggers matched — the "did not instantiate" diagnostic),
F4 hint replay as the brittleness detector, and a per-module cap on
ambient lemmas. Keep MBQI for user quantifiers until a measurement says
otherwise: V5's goals discharge through MBQI today, and F\*'s global
switch-off is a decision for a library that has already been written
against patterns.

**Verdict: adopt — amend T1's exit criterion from "proves using only std
lemmas" to "proves using only std lemmas, without naming them", and land
T4b with T1 instead of after it.** Trigger: T1 start.

### F4 Hint replay: unsat cores as persisted, replayable proof artifacts

**F\*.** `foo.fst.hints` holds one unsat core per obligation; replay sends
the core first and falls back to the full query; successful replay is "a
prerequisite to ensure that your file will continue to verify in the face
of changes to F\* and Z3"; the wiki's title promises replay "in
milliseconds instead of minutes". Caveat, also theirs: "Z3 does not
guarantee that it will be able to *prove* that an unsat core is indeed
unsatisfiable".

**Yo today.** The encoder can name assertions (`encode.yo:527`) and
requests `(get-unsat-core)` (`encode.yo:580–587`), and `Proved` carries the
result (`driver.yo:291`). But no production assumption is named:
`vc.yo:1310` pushes every one through the unnamed `q.assume`, and only a
unit test calls `assume_named`. Today's cores are therefore empty. The
verdict cache (`~/.cache/yo/verify-cache/`) is per obligation, keyed on the
sha256 of the encoded query plus the Z3 pin, rlimit, seed, timeout and a
cache epoch (`src/verifier/driver.yo:252–270`). It is a cache, not a
proof: an obligation whose query changes, and every obligation after a pin
bump, is re-proved from nothing, with no record of what the old proof
used, and nothing tells an author that a proof only passes because
of a heuristic the next Z3 may not share. K L1 (stable obligation ids) is
the prerequisite already filed.

**Proposal.**

- Name the assumptions first (`assume_named` at `vc.yo:1310`, plus the
  goal); until then every core is empty and nothing below has input.
- Per obligation id, persist the core's clause names beside the verdict;
  on a cache miss with a recorded core, send the core-only query first;
  `unknown` falls back to the full query **unconditionally** (the verdict
  stays a function of the input, D7 intact; replay is a speed path).
- Report honestly: `proved (hint)` in the summary and JSON; the cache key
  gains the hint component so a replayed verdict is never confused with a
  full one.
- `--hint-info`: an obligation whose recorded core stops replaying is a
  **brittleness** diagnostic (T4a) — F\*'s "Hint-replay failed" with its
  recipe (binary-search the clause, add an assert or lemma, fix the
  trigger).
- Where the cores live: the user cache first; an in-tree sidecar for
  `std/spec` and `tests/spec` only if CI replay time justifies it (F\*
  commits its `.hints`; Yo's `plans/reference/` discipline would want the
  sidecar byte-stable and generated by one command).

**Measure first.** Core size versus context for (i) quantifier-free AoRTE
goals, where the context is a few assertions and the gain is likely nil,
and (ii) lemma-layer / `seq_of` / `ms_of` goals with triggered axioms —
the F\* case. Build only if (ii) shows the F\* ratio.

**Verdict: adopt, measurement-gated, size M.** Trigger: SELF_VERIFICATION
M2's verify wall time, or the first Z3 pin bump that flips a verdict.

### F5 Brittleness sweeps: seed variation

**F\*.** `--z3refresh` "detect[s] flaky proofs"; `smtprofiling`'s
stabilization catalog starts from seed and refresh variation.

**Yo today.** A fresh process per obligation and `:random-seed 0` always:
reproducible by construction, but a proof that passes *only* under seed 0
is invisible.

**Proposal.** `yo verify --seeds N` (CI-only, for `std/spec` and
`tests/spec`): re-run each proved obligation under N seeds and report the
ones that fail under any — a diagnostic that never changes the verdict.

**Verdict: adopt, size XS; fold into T4a.** Trigger: the T1 library's
first landing (it is the artifact whose brittleness matters to every
caller).

### F6 Scoped hiding: `opaque` and `reveal`, the dual of spec-transparent functions

**F\*.** `[@"opaque_to_smt"]` hides a definition from Z3; `reveal_opaque`
unfolds it in one proof scope; on HACL\*'s MD5 it "simplified the proofs a
lot by not needing `--using_facts_from`, higher `z3rlimits`, or smaller
unnecessary functions".

**Yo today.** An uncontracted pure function is transparent to every spec
that names it (ATS lessons A3, `_transparent_call_term`,
`src/verifier/vc.yo:5712`); the only ways to make one opaque are to give
it contracts or to mark it `assumed()`. Nothing is scoped: a definition is
visible to every obligation or to none.

**Proposal.** `opaque` on a pure function: specs see only its contracts
(none ⇒ uninterpreted). `ghost(reveal(f))` as a statement: from that
point in the function, obligations see `f`'s definition: the reveal
brings the definitional axiom into scope.

**Verdict: adopt when measured, size S.** Trigger: SELF_VERIFICATION M2
obligations whose contexts carry more than N transparent definitions, or
the 20× escalation firing on goals whose core (F4, once it names the
assumptions) uses none of them.

### F7 Fuel: bounded unfolding of recursive spec functions

**F\*.** "each unfolding consumes a unit of fuel, and each inversion
consumes a unit of ifuel"; defaults are small, raised per scope; "Increasing
the fuel is expensive"; closed computations "should be reduced directly by
F\*'s normalizer".

**Yo today.** A recursive `ghost_fn` is an uninterpreted function plus the
definitional axiom `forall ps. f(ps) == body[ps]` triggered on the
application (`_ghost_fn_app_term`, `src/verifier/vc.yo:5771–5910`):
unfolding depth is bounded only by E-matching's own limits and the rlimit.
A spec-transparent runtime function (A3) uses the same encoding
(`_transparent_call_term` → `_ghost_fn_app_term`, `vc.yo:5712`); only a
`ghost_fn` without `decreases` is inlined once per call
(`_ghost_fn_inline_term`, `vc.yo:5912`). A closed application of a
`decreases`-carrying `ghost_fn` is not folded: it reaches Z3 as an
uninterpreted application plus its definitional axiom, and E-matching
unfolds it (`sum_to(i32(3)) == i32(6)` is a solver query today).
`_fold_term` (`vc.yo:1077`) folds operator applications only, and the
evaluator does not CTFE a runtime-typed `ghost_fn` call. The inlined
kind does fold: `sq(i32(3)) == i32(9)` reports `PROVED (folded)`.

**Proposal.** (i) Fold closed ghost terms through the evaluator before
encoding — Yo's normalizer is CTFE, and `count(seq_unit(1), 1) == 1`
should never reach Z3. (ii) Diagnose: an `unproven` goal mentioning a
recursive spec function says "its definition may need unfolding beyond
the trigger — add a lemma (T1) or raise `--fuel`". (iii) Only if T4a
shows runaway instantiation: F\*'s fuel-indexed encoding (the function
takes a fuel argument; the axiom at `n+1` unfolds to the body at `n`),
with `--fuel N` defaulting to 2 and part of the cache key.

**Verdict: adopt (i) and (ii), size S; (iii) on measurement.** Trigger:
T4a's instantiation counts.

### F8 Default termination measure and structural ordering

**F\*.** The default measure is "the lexicographic ordering of all the
non-function-typed arguments" left to right; `<<` includes the sub-term
ordering on inductive values, so `length (Cons _ tl)` recursing on `tl`
needs no annotation.

**Yo today.** Recursion without `decreases` is a subset error (A5
reconciled it with D12: loud, not partial); measures are integers,
lexicographic since A5; there is no structural ordering (recursive enums
are `ref` today; their value form arrives with VALUES_BY_DEFAULT, which
THEOREM_PROVING_NEXT §7 already notes).

**Proposal.** (a) When a recursive function or `ghost_fn` writes no
`decreases`, try the lexicographic tuple of its integer and list-length
(`xs.len()`) parameters in order; on success `--explain` reports
`decreases (inferred: a, xs.len())`; on failure the subset error stays,
now with the inferred candidate named ("`n` does not decrease on the call
at L12; write `decreases(...)`"). (b) The sub-term ordering on value enums
(`Box` payloads) once VBD's enum phases land, so a lemma over a list enum
recurses on its tail with `decreases(xs)`.

**Verdict: adopt (a), size S, after measuring how many `tests/spec`
fixtures and T1 lemmas carry the trivial measure; (b) after VBD's enum
phases.** Trigger for (a): that count.

### F9 Split queries: one obligation per top-level conjunct

**F\*.** `--split_queries always` decomposes a compound VC into sub-goals;
`proof-copilot` reports "a 50% rlimit reduction with the same
reliability" on one case study.

**Yo today.** One obligation per clause argument (`requires#N`,
`ensures#N`, `src/verifier/vc.yo:6331`, `7039`); a clause written
`ensures(a && b)` is one query, and the counter-example names the clause,
not the conjunct. Loop-invariant conjuncts are already walked in order
(`vc.yo:3162`) so the later ones may read under the earlier.

**Proposal.** Split a clause's top-level `&&` into `ensures#N.k`
obligations with the same ordered-conjunct rule; FV §Diagnostics'
"smallest violated clause" then falls out by construction instead of from
the core (which is empty today, F4). Pairs with F4's stable ids.

**Verdict: adopt, size S.** No trigger needed.

### F10 `calc` — confirmation for T3

F\*'s `calc` "ha[s] no special semantics, [it is] simply a desugaring
artifact"; justifications are thunked; the relation may be "either symbols
or any parenthesized term"; F\* adds a transitivity check; steps are "not
in logical scope of each other" yet "everything is encoded in a single VC
for now". T3's design (sugar over sequential asserts and lemma calls, one
relation per chain) is confirmed; the one improvement over F\* is to emit
each step as its own obligation (F9), which T3 already intends. No new
item.

### F11 Effects: Dijkstra monads, layered effects, Pulse — what transfers

**F\*.** Effectful code is specified through WP-indexed computation types;
user-defined effects are Dijkstra monads (POPL 2017) and indexed monads
(*Indexed Effects*: "programs are written in a direct style and are
elaborated into a core language of pure, total functions, where the
monadic structure is explicit"), with case studies in information flow,
algebraic effects and binary parsers. Low\* states footprints with
`modifies` over a region-based heap; Pulse replaces that with concurrent
separation logic (`pts_to`, `par`).

**Yo today.** Effects are outside the verifiable subset by design — purity
*is* the frame rule (FV §Purity and the effect frame rule). Two open
questions sit exactly where F\*'s machinery would: which arguments a
callee may change (`issues/questions/modifies-clause-for-callee-side-effects.md`,
inferred from `old(...)` today, with an acknowledged unsound corner for
`assumed()` bodies) and the heap model (FV Open Question 1). Async is
Open Question 7.

**What transfers, without the dependent core.**

- (a) **An explicit `modifies` clause.** Low\* converged on an explicit
  footprint after years of C-like verification; Dafny has one; Yo's
  "`old(p)` mentions ⇒ may modify" is a convention. Recommendation: when
  OQ1's heap model is designed, make the footprint explicit for callees
  with reference-typed or `&mut` parameters, and keep the inference only
  as a default for `assumed()` std contracts that are "the whole truth".
- (b) **Effect-operation contracts.** A `ctl` operation declared with
  `requires`/`ensures` over ghost state lets a body that performs it stay
  in the subset: the perform site proves `requires` and assumes `ensures`
  (the modular call rule, unchanged), and a handler's own verification
  proves it meets the operation's contract. That is the layered-effects
  picture — "the handler implements the effect's specification" — reduced
  to contracts, with no WP calculus.
- (c) **Pulse/PulseCore as design input for OQ1**, the role
  `MATCHING_LOGIC_RESEARCH.md` §7 gave separation logic: Pulse proves
  exclusivity with `pts_to` permissions at proof time; Yo's unique
  ownership (VALUES_BY_DEFAULT §0) and `&mut` exclusivity give it
  statically, so Prusti-style ownership framing is one of the two
  candidates SELF_VERIFICATION's foundations table leaves to L6
  ("partially applicable" for parameters; D2 starts L6 with singleton
  `inout` treatment), with flat heaps as the other.
- (d) Nothing for async: Pulse's `par` is structured concurrency under
  separation logic — relevant to `src/codegen/parallelism/`, not to the
  single-threaded event loop.

**Verdict: (a) and (c) are inputs to OQ1, not items; (b) is a design
question, filed as
`issues/questions/2026-10-14-effect-operation-contracts.md` with the
recommendation that it come after L2 and before the heap model** (the
assessment that followed this audit found it is the difference between
`VerifyOrAssert` verifying user code and verifying only its pure leaves).
The counter-position on (a) is appended to
`issues/questions/modifies-clause-for-callee-side-effects.md`. Trigger for
(b): the SELF_VERIFICATION census count of functions blocked only by an
effect parameter.

### F12 Meta-F\* tactics — the jobs, not the language

**F\*.** Tactics are metaprograms in a custom effect attached to single
assertions; "we only use tactics on those assertions that are particularly
hard for the SMT solver" while "the rest of the proof, called the
'skeleton,' is still handled by Z3"; "Meta-F\* does not yet allow a fully
interactive style of proof, so the whole proof is re-checked after every
edit"; the `smt` tactic "does not immediately call the SMT solver".

**Yo's non-goal.** Tactic languages, proof states and interactive stepping
are binding non-goals (FV §Non-goals; THEOREM_PROVING_NEXT §9; the "Z3
discharges or the author edits the annotations" rule). This audit gives
the non-goal a second reason: the F\* authors keep SMT as the skeleton and
tactics as the exception, and their LLM work (F13) synthesizes
definitions against types with the checker in the loop, not tactic
scripts.

**The jobs F\* tactics do, mapped.**

| Job in F\* | Tactic | Yo | Status |
| --- | --- | --- | --- |
| Normalize a closed goal | `compute`, `norm`, `assert_norm` | CTFE folding before encoding | have; extend per F7(i) |
| Canonicalize AC / non-linear arithmetic | `canon_semiring`, `canon_monoid` | a fixed verifier pass normalizing polynomial terms before bit-blasting | **candidate**: ship as a pass, never a language |
| Apply a lemma to the goal | `mapply`, `apply_lemma` | `ghost(lemma(args))` | have |
| Split a goal | `split`, `focus` | F9 per-conjunct obligations | candidate |
| Inspect the proof state | `dump` | `--explain`, T4a | have / planned (diagnostics, not stepping) |
| Prove by reflection (Vale's verified assembly) | tactic-driven | out of scope | — |

Yo's comptime and macros could host a tactic language; that they could is
not a reason to. The canonicalization pass is the one job with a plausible
Yo trigger: SELF_VERIFICATION M1's arithmetic laws over bitvectors are
where AC-rearrangement goals will first return `unknown`.

**Verdict: no tactic language (reaffirmed); the canonicalization pass on
trigger, size M.** Trigger: a measured class of `unknown` goals on M1's
arithmetic laws that neither a lemma nor F7 carries.

### F13 The agent loop: FStarDataSet, proof-copilot, `fstarmcp`

**F\*.** The ICSE 2025 dataset frames each top-level definition as "given
an F\* type as a specification, produce a matching definition", with a
checker that "queries F\* to check the correctness of candidate
solutions"; retrieval by types helps most. `proof-copilot` ships
`smtprofiling` ("a catalog of 10 proven stabilization techniques mined
from real verification projects"), `proofdebugging` ("isolating failures,
factoring lemmas, and hardening proofs") and `fstarmcp` ("re-typecheck
modified code without restarting F\*").

**Yo today.** B4 (the evals corpus) is the live Agent-loop item and is
unstarted; `yo mcp` is a precedent-backed idea in
[`AGENT_LOOP_NEXT.md`](AGENT_LOOP_NEXT.md); the resident checker exists
for `check` and `build` (`--watch`) but not for `verify`;
`docs/*/FORMAL_VERIFICATION.md` §Troubleshooting has seven rows,
including the extreme-value overflow and weak-invariant symptoms.

**Proposal.** (a) A **proof-stabilization catalog** in
`docs/*/FORMAL_VERIFICATION.md` §Troubleshooting, one row per technique
with the fixture that demonstrates it (the negative twins in
`tests/spec/fixtures/` are the corpus), beyond the seven rows already
there: missing frame lemma, trigger never matched, transparent recursion
without `decreases`, alias without `distinct`, … (b) B4's task shape: a
contract-as-spec corpus mined from `std/` and `tests/spec` (signature +
contracts → body), checked by `yo verify --strict`, retrieval by
signature. (c) `yo verify --watch` on the resident checker, so an agent's
edit re-runs only the evaluator and VC generation for the changed
definitions (K L1's stale/fresh marker); the per-obligation verdict cache
already skips unchanged queries at the solver.

**Verdict: adopt (a) now (docs, size S); (b) is B4's design input; (c)
when B4 measures the loop's latency.**

### F14 Low\* / KaRaMeL

Nothing to adopt. Yo is already "proofs erase, the C is the artifact";
F\* additionally *proves* that extraction preserves semantics, which is
the theorem SELF_VERIFICATION's "What no milestone claims" excludes, and
D6's bitvector model matching `-fwrapv` C is the stronger per-program
stance (proofs are about the program that runs, not about a source the
extractor then translates). One note for std: EverParse's generated
parsers, with a ghost consumed prefix beside a runtime position, are the
canonical consumer of F2.

### F15 In-body `assume(P)` for proof development

**F\*.** `assume P` in a body and `admit()` for a hole, with the rule
"a proof isn't done until it's free of them"; F\*'s own hint-failure
recipe is to binary-search the post-condition.

**Yo today.** `assumed()` is per-function (std's trusted contracts) and
`--strict` denies it; there is no in-body assumption (`grep assume(` over
`tests/spec`, `std/spec`, the docs: none). An agent bisecting a failing
`ensures` today edits `requires` or comments clauses out — both change
what the function means.

**Proposal.** `ghost(assume(P))` as a ghost statement: adds `P` to the
path condition, is reported as an `assumed` outcome on that function
(denied by `--strict`, counted in every summary), and is erased like any
ghost statement.

**Verdict: adopt, size XS.** Trigger: B4 shows agents faking it with
`requires`, or the first SELF_VERIFICATION annotation loop that wants it.

## 5. Rejected, with the reason

| Idea | Why not |
| --- | --- |
| Universes, `Type : Type u#1`, propositions as types, `squash` | the position's permanent non-goals; F\* needs them because its propositions are types — Yo's are `bool` in ghost context |
| Refinement subtyping inside unification (Z3 in `yo check`) | ATS audit §4 reasons 3–4; F1 keeps every obligation in the verifier pass and lets the checker only *record* where a refinement sits |
| Dependent pattern matching, inductive families beyond GADTs | position non-goals; `docs/en-US/GADTS.md` covers the comptime-indexed half |
| User-defined effects as Dijkstra monads / WP-indexed computation types | needs the dependent core; Yo types effects by rows and verifies by purity; F11(b) takes the contract-shaped remainder |
| A tactic language, Meta-F\*, interactive proof | binding non-goal; F12 takes the jobs as fixed passes |
| Turning MBQI off globally | F\* did it for a library written against patterns; Yo's V5 goals discharge through MBQI — measure under F3 before copying |
| A second solver | D2 |
| Separate interface files (`.fsti`) | `_` privacy + `export` cover the API half; F6 covers the SMT-visibility half |
| Committing `.hints` sidecars tree-wide | F4 starts in the user cache; in-tree only for `std/spec` / `tests/spec` on measured CI gain |
| Pulse as the heap model | input to FV Open Question 1 (F11c), not a model to import: Yo's ownership is static |
| Proving the Yo→C lowering (Low\*'s theorem) | SELF_VERIFICATION §"What no milestone claims" |

## 6. Order and cost

| Item | Depends on | Size | Trigger to start |
| --- | --- | --- | --- |
| F9 split conjunct obligations | — | S | none |
| F15 in-body `assume` | — | XS | B4 or the first annotation loop that wants it |
| F13(a) stabilization catalog (docs) | — | S | none |
| F8(a) inferred `decreases` | the fixture count | S | that count |
| F1(a)(b) binder and result refinements | — | S–M | M2 census finds a re-proved predicate |
| F3 auto-firing lemmas (= T1 + T4b) | T4a | M | T1 start |
| F5 seed sweeps (T4a) | — | XS | T1's first landing |
| F7(i)(ii) fold + diagnose | — | S | T4a counts; (iii) fuel encoding on measurement |
| F4 hint replay | K L1 ids; measurement | M | M2 verify time, or a pin bump that flips a verdict |
| F6 `opaque` / `reveal` | F4 (the measurement) | S | M2 context sizes |
| F2 ghost fields and parameters | F1(c) | M | an L6/M2 module wanting a ghost view |
| F1(c) field refinements (= D11 slice 1) | L6 | M | type invariants prioritized |
| F12 canonicalization pass | — | M | `unknown` class on M1's arithmetic laws |
| F11(b) effect-operation contracts | L2 | design question | the census count of functions blocked only by an effect parameter |
| F13(c) `yo verify --watch` | K L1 | M | B4's latency measurement |

Every item keeps the landed invariants: pinned Z3, deterministic rlimit
budgets, byte-identical verdicts per pin (F4's replay is a speed path with
unconditional fallback), ghost erasure, the verifiable-subset discipline,
and `--strict` as the honest gate (F15's `assume` counts against it).

## 7. Companion edits in this PR

- [`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md): status line
  and a "The F\* question (audited 2026-10-14)" section, the ATS
  precedent.
- [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md): T1 and T4 point at
  F3–F5 and F7; §11 lists this doc.
- [`README.md`](../README.md): the backlog paragraph lists this doc beside
  the Rust and Zig surveys.
- Three design questions from the assessment that followed the audit, each
  with a recommendation:
  `issues/questions/2026-10-14-overflow-trap-freedom-as-a-default-obligation.md`
  (the model wraps where safe code traps; make the overflow obligations
  default and measure the integer theory),
  `issues/questions/2026-10-14-effect-operation-contracts.md` (F11(b),
  pulled ahead of the heap model), and the counter-position appended to
  `issues/questions/modifies-clause-for-callee-side-effects.md` (an
  explicit frame, with ownership as the default).

## 8. Sources

In-tree: the companions listed in the status banner; `src/verifier/`
(`vc.yo`, `encode.yo`, `driver.yo`, `z3.yo`, `terms.yo`);
`src/evaluator/types/function.yo`; `std/spec/refine.yo`;
`tests/spec/refine_types.test.yo`; `docs/en-US/FORMAL_VERIFICATION.md`;
`issues/questions/modifies-clause-for-callee-side-effects.md`.

F\* primary sources (all read 2026-10-14):

- *Proof-Oriented Programming in F\** (the F\* book): [Propositions and assertions](https://fstar-lang.org/tutorial/book/part1/part1_prop_assertions.html), [Lemmas](https://fstar-lang.org/tutorial/book/part1/part1_lemmas.html), [Proofs of termination](https://fstar-lang.org/tutorial/book/part1/part1_termination.html), [Universes](https://fstar-lang.org/tutorial/book/part2/part2_universes.html), [Primitive effect refinements](https://fstar-lang.org/tutorial/book/part4/part4_pure.html), [Erasure and the Ghost effect](https://fstar-lang.org/tutorial/book/part4/part4_ghost.html), [An overview of tactics](https://fstar-lang.org/tutorial/book/part5/part5_meta.html), [Pulse](https://fstar-lang.org/tutorial/book/pulse/pulse.html).
- F\* wiki: [Robust, replayable proofs using unsat cores (hints)](https://github.com/FStarLang/FStar/wiki/Robust,-replayable-proofs-using-unsat-cores,-(aka,-hints,-or-how-to-replay-verification-in-milliseconds-instead-of-minutes)), [Using SMT fuel and the normalizer](https://github.com/FStarLang/FStar/wiki/Using-SMT-fuel-and-the-normalizer), [Quantifiers and patterns](https://github.com/FStarLang/FStar/wiki/Quantifiers-and-patterns), [Calculational proofs](https://github.com/FStarLang/FStar/wiki/Calculational-proofs), [Code pattern for hiding definitions from Z3](https://github-wiki-see.page/m/FStarLang/FStar/wiki/Code-pattern-for-hiding-definitions-from-Z3-and-selectively-revealing-them), [Profiling Z3 queries](https://github.com/FStarLang/FStar/wiki/Profiling-Z3-queries).
- Papers: Swamy et al., *Dependent Types and Multi-Monadic Effects in F\** (POPL 2016); Ahman et al., [*Dijkstra Monads for Free*](https://fstar-lang.org/papers/dm4free/) (POPL 2017); Rastogi, Martínez, Fromherz, Ramananandro, Swamy, [*Programming and Proving with Indexed Effects*](https://fstar-lang.org/papers/indexedeffects/); Martínez et al., [*Meta-F\*: Proof Automation with SMT, Tactics, and Metaprograms*](https://arxiv.org/abs/1803.06547) (ESOP 2019); Protzenko et al., [*Verified Low-Level Programming Embedded in F\**](https://arxiv.org/abs/1703.00053) (ICFP 2017); [*PulseCore: An Impredicative Concurrent Separation Logic for Dependently Typed Programs*](https://fstar-lang.org/papers/pulsecore.pdf) (PLDI 2025); Chakraborty et al., [*Towards Neural Synthesis for SMT-Assisted Proof-Oriented Programming*](https://arxiv.org/abs/2405.01787) (ICSE 2025).
- Repositories: [FStarLang/pulse](https://github.com/FStarLang/pulse) (Pulse folded into the F\* repository), [FStarLang/proof-copilot](https://github.com/FStarLang/proof-copilot) (the eight agent skills).
