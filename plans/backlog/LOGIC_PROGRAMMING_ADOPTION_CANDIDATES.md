# What to take from logic programming: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-11-21 at the maintainer's
request. Nothing here is adopted.** Four candidates (LP1–LP4), each with a
verdict and a trigger; the maintainer picks. The prompt was a post by Erik
Meijer sorting verification approaches by _who finds the witness_ and
arguing that logic programming, where execution is the proof search, is the
best of them. The maintainer's question: can Yo benefit from logic
programming, and is there a language feature to adopt?

Audited against the Yo tree at `1e55e6c90`, with the `yo` 0.2.79 seed
running the tree's `std` and the pinned Z3 5.1.0. Every "Yo today" claim
was checked by read, grep or a run on that tree; the two runs are
reproduced in §2. Companion catalogues with the same shape:
[`LEAN_ADOPTION_CANDIDATES.md`](LEAN_ADOPTION_CANDIDATES.md),
[`FSTAR_ADOPTION_CANDIDATES.md`](FSTAR_ADOPTION_CANDIDATES.md),
[`K_FRAMEWORK_ENGINEERING_LESSONS.md`](K_FRAMEWORK_ENGINEERING_LESSONS.md),
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md).

## 0. Answer

**No runtime feature.** Backtracking, logic variables and runtime
unification do not fit Yo (§4). **Four ideas do fit**, all in the verifier,
its report or the trait solver, and none changes the language surface:

| # | Candidate | Verdict |
| --- | --- | --- |
| LP1 | Witness queries: the verifier answers "give me a value", not only "is this valid?" | adopt, in three slices |
| LP2 | Search once, pin the witness: a solver-found `exists` witness is offered back as source | adopt with LP1 |
| LP3 | Owed bodies: a contract whose body is not written is its own outcome, not `ok` | adopt, small |
| LP4 | One goal table for trait obligations, with a declared cycle rule per trait | park, with a trigger |

### The four camps, and where Yo sits

| Camp | Who finds the witness | Yo |
| --- | --- | --- |
| 1. Program, then prove (Dafny, Lean) | the author writes the algorithm; the machine checks it | **here**, by decision ([`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md), "Compile-time verification", Z3 only) |
| 2. Program calculation (Bird–Meertens) | the author derives the fast program from a slow, obviously correct one | expressible: a recursive `ghost_fn` is the slow program, `ensures(r == spec(x))` the claim; the chain format is [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) T3 (`calc`) |
| 3. Proof extraction (Rocq) | the author writes a constructive proof; the program is extracted | not taken (§4) |
| 4. Proof search as execution (Prolog) | the machine, at run time | not taken as execution (§4); taken as a _tool_ (LP1, LP2) |

### Why camp 4 is not the destination

The post's claim is that only camp 4 lets you state what makes a witness
valid and get the witness for free. Two things are missing from it:

1. **The search is not free; it moves to run time.** "A sorted permutation
   of the input" is a correct logic program for sorting and runs in
   factorial time. Real logic programs are therefore written as algorithms
   again, with clause order and cuts carrying the control (Kowalski's
   "algorithm = logic + control"). At that point the author has invented the
   algorithm after all, and nothing checks the fast program against the
   naive one.
2. **Yo's author is a model.** Inventing an algorithm is cheap for an LLM;
   being trusted is not. Camp 1 spends the machine on the expensive half,
   the check. The loop "model writes, `yo verify` refutes with a
   counter-example, model edits" already _is_ a proof search over programs,
   with the result written down and checked on every build instead of
   re-derived on every run.

The second point gives the rule the candidates share: **search at authoring
time, write the result into the source, check it forever.**

## 1. The filter

A candidate survives only if it passes all four
(LEAN_ADOPTION_CANDIDATES §0, with
[`LANGUAGE_FEATURE_CANDIDATES.md`](LANGUAGE_FEATURE_CANDIDATES.md) §0 for
the language side):

1. **Not already rejected.** No tactic language or proof state, no second
   solver, no runtime dependent types
   ([`DEPENDENT_TYPES_POSITION.md`](../reference/DEPENDENT_TYPES_POSITION.md)),
   no overloading, no specialization
   ([`TRAIT_COHERENCE.md`](../reference/TRAIT_COHERENCE.md)).
2. **Fits the house philosophy:** explicit over inferred, locally checkable
   over whole-program, visible costs, one canonical spelling.
3. **Pays for an LLM author.** The gain has to show up in the agent loop: a
   diagnostic that names the next edit, or a report an agent can act on.
4. **Not already here** (§2).

## 2. Already here (do not re-propose)

| Logic programming | Yo today | Where |
| --- | --- | --- |
| Horn-clause resolution | trait resolution: an `impl` is a clause, its `where` bounds are subgoals | `src/evaluator/trait-checking.yo` |
| determinism by construction (no backtracking over clauses) | coherence: one impl of a trait per type, blanket overlap is an error (E0612), no specialization, so at most one clause answers a goal | [`TRAIT_COHERENCE.md`](../reference/TRAIT_COHERENCE.md) |
| functional dependencies (an output argument of a relation) | associated types | [`ASSOCIATED_TYPES.md`](../reference/ASSOCIATED_TYPES.md) |
| one-way unification | `match`; exhaustiveness is a search for an uncovered value | [`MATCH_PATTERN_MATCHING.md`](../reference/MATCH_PATTERN_MATCHING.md) |
| Mercury's determinism categories (`det`, `semidet`, `nondet`) | the return type says it: `T`, `Option(T)`, an iterator | the type system; no annotation to add |
| Mercury's modes (`in`, `out`) | `x : T`, `x : &T`, `x : &mut T`, and the labeled return `-> (r : T)` | decision 42 |
| a search that returns a witness | a `Refuted` verdict carries the Z3 model | `src/verifier/driver.yo:92`; `encode.yo:586` |
| an existential query | `exists(k : T, P)` in ghost positions; Z3 finds the witness, or the body exhibits one | `docs/en-US/FORMAL_VERIFICATION.md:765`; `tests/spec/fixtures/valid/dml-sorted-insert.yo` (the local `at`) |
| a relation checked in more than one direction | a `law(...)` over two contracted functions | `docs/en-US/FORMAL_VERIFICATION.md:505` |

### Measured: the verifier already answers a query, spelled backwards

A logic-programming query asks for values that satisfy a predicate. Today
the same question is asked by claiming that no such values exist; the
counter-example is the answer.

```yo
pragma(Pragma.Verify);
{ assert } :: import("std/assert");

// The query "find x > y in 1..99 with 3x + 5y == 47", as a negated claim.
no_solution :: (
  fn(
    x : i64,
    y : i64,
    requires((x > i64(0)) && (x < i64(100)), (y > i64(0)) && (y < i64(100)), x > y)
  ) -> unit
)({
  assert(((x * i64(3)) + (y * i64(5))) != i64(47));
});

// The same question as an existential: the solver finds the witness itself.
has_solution :: (
  fn(
    n : i64,
    requires(n == i64(47)),
    ensures(
      exists(
        x : i64,
        exists(
          y : i64,
          (x > i64(0)) && (x < i64(100)) && ((y > i64(0)) && (y < i64(100)) && (((x * i64(3)) + (y * i64(5))) == n))
        )
      )
    )
  ) -> unit
)({
  ()
});
```

`yo verify query.yo --std-path ./std` (160 ms, 2 queries, uncached; exit
code 1):

```text
  refuted  fn@query.yo:9 [verify]
    fn@query.yo:9/assert: REFUTED  counter-example: x = #x0000000000000009, y = #x0000000000000004
  ok       fn@query.yo:28 [verify] — 1 obligation(s) proved
```

Three observations feed LP1 and LP2:

- The answer `x = 9, y = 4` arrives as a **failure**: a `refuted` function,
  a non-zero exit, and bit-vector hex instead of Yo literals.
- `has_solution` is `ok`, but the report **does not say which witness** the
  solver used. The proof rests on a search nobody can see.
- Placing `assert(false)` at a program point asks "which input reaches
  here?" the same way. Neither idiom is in the manual.

### Measured: an unwritten body is reported `ok`

```yo
pragma(Pragma.Verify);
{ panic } :: import("std/assert");

// The contract is written; the body is not.
isqrt :: (
  fn(
    n : u32,
    requires(n < u32(1000000)),
    ensures((r * r) <= n, ((r + u32(1)) * (r + u32(1))) > n)
  ) -> (r : u32)
)({
  panic("isqrt: not written yet")
});

// Proved against isqrt's contract alone.
caller :: (fn(n : u32, requires(n < u32(1000000)), ensures((r * r) <= n)) -> (r : u32))({
  isqrt(n)
});
```

`yo verify stub.yo --std-path ./std --strict` exits 0:

```text
  ok       fn@stub.yo:9 [verify] — no obligations
  ok       fn@stub.yo:15 [verify] — 2 obligation(s) proved
```

A path that reaches `panic` owes no `ensures`
(`docs/en-US/FORMAL_VERIFICATION.md:709`), so the stub has zero obligations
and is `ok`. The JSON report marks it `"vacuous": true` and the summary
counts it ("1 of the ok vacuous"), but `--strict` fails only `assumed`,
`outside-subset` and `unproven` (`src/main.yo:3377`). Adding `assumed()`
turns the stub into `assumed`, the same outcome as std's vouched contracts.
Neither spelling says "this body is owed". This feeds LP3, and it is filed
as
`issues/questions/2026-11-21-a-contract-whose-body-is-a-panic-stub-passes-yo-verify-strict.md`.

## 3. The candidates, ranked

### LP1 — Witness queries: "give me a value"

**Logic programming:** a query returns bindings. The predicate is the
program; the answer is data.

**Yo today:** the solver is asked one question, "is this obligation
valid?", and a model is shown only when the answer is no (§2).

**Candidate, in three slices:**

- **LP1a — keep the model the vacuity probe already computes.** The planned
  hypothesis-consistency probe (FORMAL_VERIFICATION §"Vacuity checking")
  asserts a function's entry premises and tries to prove `false`. When the
  premises are consistent, the solver's answer is `sat`, and its model is
  **one legal input of the function**. The plan keeps only the boolean.
  Keep the model too: `example_input` beside `vacuity` in the JSON report.
  One extra `(get-value …)` on a query the probe runs anyway.
- **LP1b — examples from a contract.** `yo verify --examples <n> <fn>`
  returns `n` distinct models of the entry premises (each model is excluded
  before the next query), rendered as Yo literals (`i64(9)`, not
  `#x…09`). The use is the functions a proof does not cover: for an
  `assumed`, `outside-subset` or `unproven` body, the inputs drive the
  runtime `ensures` checks that those modes keep. Limits to state up front:
  solver models cluster at boundaries (useful for edge cases, not for
  coverage), and the first version covers scalar, `bool` and enum
  parameters only (an `ArrayList` is a ghost pair in the model, and
  rendering one back is separate work). Every query is cache-keyed, so
  output stays byte-identical per Z3 pin.
- **LP1c — document the two idioms** of §2 (the negated claim, and
  `assert(false)` for reachability) in the verification manual, both
  languages, under "asking the verifier for an example".

Rejected inside LP1: a dedicated `query(...)` form. The negated claim works,
a second spelling for a rare use fails "one canonical spelling", and LP1b
covers the common case (inputs of a function) without new syntax.

**Verdict: adopt.** LP1a rides the vacuity-probe PR (hours on top of it).
LP1c is a docs PR, anytime. LP1b is ~1 week of driver work and shares its
literal renderer with LEAN_ADOPTION_CANDIDATES LE3 (shrunk
counter-examples); build the renderer once, in whichever lands first. The
fuzzing harness in RUST_ADOPTION_CANDIDATES T4 is the random-search
complement, not a substitute.

### LP2 — Search once, pin the witness, check forever

**Logic programming:** the witness is recomputed by search on every run.

**Yo today:** an `exists` obligation is either closed by the solver's own
quantifier search (`has_solution` in §2) or by a witness the body exhibits
(`at` in `dml-sorted-insert.yo`, carried through the loop invariants). The
report does not distinguish the two. The first kind depends on Z3's
quantifier instantiation finding the value again after the next pin bump;
the second is a ground check.

**Candidate:** when an `exists` obligation is proved, `--explain <fn>` runs
one more query, the existential's body as a satisfiability question under
the same path facts, and prints the model as a line the author can paste:
`assert(P(w))` with `w` as a literal. This is LEAN_ADOPTION_CANDIDATES
LE7's "Try this" rule applied to witnesses: automation may find the
answer, and the author commits it. It is also the same stance as measure
inference ("the author writes the measure they mean").

**Rejected variant: a `comptime solve(...)` builtin** that asks Z3 for a
value during CTFE (a perfect-hash seed, a layout). It would put the solver
on the compile path (`yo check` treats a missing Z3 as a skip), make build
output depend on the pin, and hide a search behind an expression. The
pinned form gets the same result: a tool finds the constant once, the
source holds the literal, a contract checks it.

**Verdict: adopt with LP1** (it needs LP1b's literal renderer and nothing
else). Days. Open question 1 asks whether the summary should also count
`exists` obligations closed without an exhibited witness.

### LP3 — Owed bodies: spec-first as a reported state

**Logic programming:** the specification is the starting artifact; a
relation is stated before anyone decides how to compute it.

**Yo today:** the top-down order already works. Callers are proved against
a callee's contract, so a module's contracts can be written and checked
against each other before any body exists (§2). What is missing is the
accounting: the unwritten body is `ok` (vacuous) or `assumed`, and an agent
reading the report cannot tell a body it owes from a proof or from a
vouched std contract.

**Candidate:** a new outcome, `owed`, for a function that states an
`ensures` and whose body owes it on no path. Like `assumed`, it lets
callers verify; unlike `ok`, it fails `--strict`. The JSON entry carries
the contract's source text, so the list of `owed` functions is the agent's
work queue: each entry is the specification and the place to write the
body. This is detection from data the verifier already has (the clause
list and the obligation count), so it needs no new keyword.

**Verdict: adopt, small** (days: one outcome, the summary column, the
`--strict` class, the manual in both languages). It closes a hole in the
honest-gate story independent of logic programming: today a module of
`panic` stubs passes `yo verify --strict` (§2; the question doc carries the
recommendation for the maintainer's verdict). Open question 2 is whether the
state also deserves an explicit spelling (an `owed()` clause beside
`assumed()`), which the "explicit over implicit" principle would favor.

### LP4 — One goal table for trait obligations

**Logic programming:** a recursive goal is handled by **tabling** (SLG
resolution): one table keyed by goal, an in-progress entry, and a stated
rule for what a goal that meets itself means. Rust's trait solver names the
two rules: a cycle through an inductive goal is not a proof (the solver
reports overflow); a cycle through a coinductive goal (auto traits, `Sized`,
well-formedness) holds.

**Yo today:** `trait-checking.yo` has five separate global in-progress
lists, each with its own answer for a goal that meets itself:
`g_copy_pending_keys` (`:164`), `g_lacks_copy_in_progress` (`:168`, "an
in-progress type answers 'not lacking'"), `g_trait_check_recursion_guard`
(`:264`), `g_ondemand_marker_guard` (`:268`) and
`g_send_derivation_in_progress` (`:270`). `Acyclic` has a sixth mechanism, a
Tarjan walk (`:500`), written after the field-by-field derivation answered
a cycle coinductively where the inductive answer was the sound one
(`issues/fixed/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.md`).
The rule is chosen per call site and recorded in comments.

**Candidate:** one obligation table keyed by the canonical
`(type, trait)` goal, and one declared fact per trait: inductive or
coinductive. The five lists become views of it. The `Acyclic` bug is the
class this prevents: the cycle rule becomes a property of the trait that a
reviewer can read in one place.

**Verdict: park, with a trigger.** It is an evaluator refactor with no
user-visible change, and VBD is still changing the marker derivations it
would touch. Trigger: the next soundness bug whose root cause is a cycle
answered with the wrong rule, or the start of
[`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md) work on trait
resolution, whichever comes first. It then gets its own plan.

## 4. Not taken

| Feature | Why not |
| --- | --- |
| backtracking execution (a `choose`/`fail` effect resumed more than once) | effect continuations are one-shot (`docs/en-US/ALGEBRAIC_EFFECTS.md:5`), and ownership forces that: a continuation holding owned values cannot run twice without copies nobody wrote. A search is spelled as an iterator or a loop |
| logic variables and runtime unification | control flow and cost that the source does not show; fails filter rule 2 |
| closed-world negation ("no clause proves it, so it is false") | a missing impl is an error to report, not a fact to compute with; negative impls are explicit (`impl(T, !(Send))`, TRAIT_COHERENCE) |
| `comptime solve(...)` | LP2: solver on the compile path, output tied to the pin |
| a Datalog engine, in the compiler or in `std` | the origin and borrow rules are fixpoints the checker computes directly; Rust's Polonius was prototyped on a Datalog engine and its in-compiler rework does not use it (§6). Datalog remains a fine _notation_ for stating such rules in a plan; no decision is needed for that |
| constraint logic programming as a `std` module | nothing stops a package; no std consumer exists |
| proof extraction (camp 3) | needs constructive proof terms; the VC IR is first-order with theories by design (DEPENDENT_TYPES_POSITION; FORMAL_VERIFICATION §Non-goals) |
| a `query(...)` form | LP1: the negated claim and LP1b cover it |

## 5. Where the adoptees land

| Candidate | Lands as | Size | Depends on / trigger |
| --- | --- | --- | --- |
| LP1a example input | the vacuity-probe PR (FORMAL_VERIFICATION open tail) | hours on top | the probe |
| LP1c the two idioms | `docs/en-US` and `docs/zh-CN` FORMAL_VERIFICATION | a docs PR | anytime |
| LP3 `owed` outcome | driver outcome, summary, `--strict`, manual | days | anytime; before SELF_VERIFICATION's strict sweep counts functions |
| LP1b `--examples` | driver loop and a Yo-literal renderer | ~1 week | shares the renderer with LE3 |
| LP2 witness "Try this" | `--explain` | days | LP1b's renderer |
| LP4 goal table | its own plan | weeks | a cycle-rule soundness bug, or TYPE_SYSTEM_SOUNDNESS reaching trait resolution |

LP1–LP3 touch only the verifier driver, its report and the manual; none
changes the evaluator, codegen or the language surface. All keep the landed
invariants: pinned Z3, deterministic budgets, byte-identical verdicts per
pin, and `--strict` as the honest gate (LP3 strengthens it). In
[`POST_VBD_PLAN.md`](POST_VBD_PLAN.md)'s terms this file is a pull-only
candidate catalogue; LP1–LP3 belong to group E (verification) when pulled.

## 6. Open questions

1. **LP2:** should the run summary count `exists` obligations proved
   without an author-exhibited witness, as a stability signal? It needs a
   definition of "exhibited" that does not depend on solver internals; one
   option is a re-query with quantifier instantiation limited to ground
   terms of the function.
2. **LP3:** detection only, or also an explicit `owed()` clause? Detection
   needs no surface; a clause states intent and makes "an `ensures` no path
   owes" an error everywhere else.
3. **LP1b:** where do examples go: printed, or written as a `test(...)`
   skeleton next to the function? The second is a `yo fix`-style edit and
   needs a naming rule.
4. **LP4:** which traits are coinductive in Yo? The markers (`Send`,
   `Sync`, `Comptime`, `Runtime`) are the candidates; `Acyclic` is the
   proven counter-example and `Copy`'s current answer needs an audit.

## 7. References

- Erik Meijer's post on the four ways specifications, proofs and code are
  connected (2026-11), quoted by the maintainer in the session that
  produced this file.
- R. Kowalski, "Algorithm = Logic + Control", CACM 22(7), 1979: the
  separation the camp-4 argument relies on, and the reason control comes
  back.
- R. Bird and O. de Moor, _Algebra of Programming_, 1997: program
  calculation (camp 2).
- The Mercury Language Reference Manual, "Determinism categories":
  <https://mercurylang.org/information/doc-release/mercury_ref/Determinism-categories.html>
  (`det`, `semidet`, `multi`, `nondet`, `failure`, `erroneous`).
- W. Chen and D. S. Warren, "Tabled Evaluation with Delaying for General
  Logic Programs", JACM 43(1), 1996: SLG resolution (LP4).
- Rust Compiler Development Guide, "Coinduction":
  <https://rustc-dev-guide.rust-lang.org/solve/coinduction.html> ("We
  currently only consider auto-traits, `Sized`, and `WF`-goals to be
  coinductive").
- Inside Rust, "Polonius update", 2023-10-06:
  <https://blog.rust-lang.org/inside-rust/2023/10/06/polonius-update/>
  ("Our current plan does not make use of that datalog-based
  implementation").
- Vacuity detection: the references in FORMAL_VERIFICATION §"Vacuity
  checking" (Beer et al. 2001; Kupferman and Vardi 2003).
