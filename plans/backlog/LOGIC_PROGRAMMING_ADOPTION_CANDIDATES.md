# What to take from logic programming: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-11-21 at the maintainer's
request. Nothing here is adopted.** Five candidates (LP1–LP5), each with a
verdict and a trigger; the maintainer picks. The prompt was a post by Erik
Meijer sorting verification approaches by _who finds the witness_ and
arguing that logic programming, where execution is the proof search, is the
best of them. The maintainer's questions: can Yo benefit from logic
programming, is there a language feature to adopt, and can it live in the
comptime context and help verification?

**Amended 2026-11-22, at the maintainer's direction:**

- The document **assumes
  [`DEFAULT_ON_VERIFICATION.md`](DEFAULT_ON_VERIFICATION.md) is carried
  out** (steps S0 to S6b). "Under the default" below means after its S6a.
  The section "Read under verification by default" states what that changes.
- **LP5** (compile-time search) was added to answer the comptime question.
- **Every open question now carries a recommendation.**
- Four defects found while measuring are filed; section 8 lists them.

Audited against the Yo tree at `1e55e6c90`, with the `yo` 0.2.79 seed
running the tree's `std` and the pinned Z3 5.1.0. Every "Yo today" claim
was checked by read, grep or a run on that tree; a claim that was only read
says so. Companion catalogues with the same shape:
[`LEAN_ADOPTION_CANDIDATES.md`](LEAN_ADOPTION_CANDIDATES.md),
[`FSTAR_ADOPTION_CANDIDATES.md`](FSTAR_ADOPTION_CANDIDATES.md),
[`K_FRAMEWORK_ENGINEERING_LESSONS.md`](K_FRAMEWORK_ENGINEERING_LESSONS.md),
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md).

## 0. Answer

**No runtime feature.** Backtracking, logic variables and runtime
unification do not fit Yo (section 5). **Five ideas do fit.** Four are in
the verifier, its report or the trait solver; one is a pattern for the
comptime context. One of them (LP3) adds a contract clause; nothing else
changes the language surface.

| # | Candidate | Verdict |
| --- | --- | --- |
| LP1 | Witness queries: the verifier answers "give me a value", not only "is this valid?" | adopt, in three slices |
| LP2 | Search once, pin the witness: a solver-found `exists` witness is offered back as source | adopt with LP1 |
| LP3 | `owed()`: a contract whose body is not written is a stated, reported state, not `ok` | adopt, before the default flips (S6a) |
| LP4 | One goal table for trait obligations, with a declared cycle rule per trait | park, with a trigger |
| LP5 | Compile-time search: a comptime function finds the witness, its own contract checks it, the verifier uses it | adopt as a documented pattern; evaluation as a proof of runtime code is not taken |

### The four camps, and where Yo sits

| Camp | Who finds the witness | Yo |
| --- | --- | --- |
| 1. Program, then prove (Dafny, Lean) | the author writes the algorithm; the machine checks it | **here**, by decision ([`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md), "Compile-time verification", Z3 only) |
| 2. Program calculation (Bird–Meertens) | the author derives the fast program from a slow, obviously correct one | expressible: a recursive `ghost_fn` is the slow program, `ensures(r == spec(x))` the claim; the chain format is [`THEOREM_PROVING_NEXT.md`](THEOREM_PROVING_NEXT.md) T3 (`calc`) |
| 3. Proof extraction (Rocq) | the author writes a constructive proof; the program is extracted | not taken |
| 4. Proof search as execution (Prolog) | the machine, at run time | not taken as execution; taken as a _tool_ (LP1, LP2) and at compile time (LP5) |

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

The second point gives the rule the candidates share: **search before the
program runs, write the result where the build can see it, check it on
every build.** The search may be the author's, the solver's (LP1, LP2) or a
comptime function's (LP5); the check is never skipped.

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
4. **Not already here** (section 2).

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
| deciding a ground claim by running it | an obligation over literals and a comptime callee is folded by CTFE with no solver query (measured: `assert(popcount8(u32(255)) == u32(8))` reports `0 queries, 1 folded`) | `docs/en-US/FORMAL_VERIFICATION.md:455` |
| a search program whose answer is checked | a comptime function's own `ensures` is checked when CTFE runs it (LP5) | `tests/comptime.test.yo:3397` |

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

## 3. Read under verification by default

DEFAULT_ON_VERIFICATION makes proving the normal path: after S6a a module
with no pragma is proved by `yo build` (D10), a refuted written contract
fails the build, and every runtime check is kept; after S6b proved checks
are erased. Six consequences for this document:

1. **LP3 becomes a gate matter.** S6a's summary states the share of
   functions inside the subset, and G1 requires that the std modules a
   program reaches report no `assumed` outcome. A `panic` stub with an
   `ensures` is `ok` in both counts today. So LP3 lands before S6a, and G1
   counts `owed` with `assumed`.
2. **The negated-claim query cannot stay in a module.** A refuted written
   `assert` fails the build in both modes (DEFAULT_ON_VERIFICATION §2.1).
   The two idioms of section 2 are scratch-file tools for
   `yo verify <file>`; LP1b is the form that leaves nothing in the source.
3. **Nothing here adds a query to the default path**, which G3 bounds.
   LP1a adds one `(get-value …)` to a probe S2 already runs. LP1b and LP2
   run only on request (`--examples`, `--explain`). LP3 asks the solver
   nothing. LP5 costs CTFE time, bounded by the loop fuel.
4. **The default's own report is half of LP1b.** Under D6, a refuted
   automatic obligation in an uncontracted function is "guard kept, site
   reported", with its counter-example: an input that trips the guard.
   LP1b's examples are the other half (inputs the contract allows), and
   both need the same renderer from bit-vectors to Yo literals.
5. **The objection to a solver on the compile path is gone; the rejection
   of `comptime solve(...)` stands for a different reason.** After SD and
   G6 the solver is on every build. But the default's rule is that a
   missing or exhausted solver is never an error: the runtime check is
   kept (D2; DEFAULT_ON_VERIFICATION §5 item 8). A _value_ has no such
   fallback, so a build that needs the solver to produce a constant would
   fail exactly where the default promises it does not. And G5 pins
   verdicts across machines, not models.
6. **Quantified clauses do not work in the default's mode today.** A
   `requires(exists(...))` is E0401 outside `Pragma.Verify`, and a
   quantified `ensures` on a block body is `subset` under
   `Pragma.VerifyOrAssert`
   (`issues/2026-11-22-a-quantified-contract-clause-compiles-only-under-pragma-verify.md`).
   S0's both-modes sweep will meet it on `dml-sorted-insert.yo`. It also
   raises LP2's value: a quantified clause is proof-only
   (`ensures_is_runtime_checkable`, `src/evaluator/builtins/contracts.yo:2888`),
   so when the solver gives up on one under `verify+` there is no runtime
   check to keep (read from that rule; the unproven case under a `verify+`
   build was not run). A pinned witness turns the search into a ground
   check that does not give up.

## 4. The candidates, ranked

### LP1 — Witness queries: "give me a value"

**Logic programming:** a query returns bindings. The predicate is the
program; the answer is data.

**Yo today:** the solver is asked one question, "is this obligation
valid?", and a model is shown only when the answer is no.

**Candidate, in three slices:**

- **LP1a — keep the model the consistency probe already computes.** S2 of
  DEFAULT_ON_VERIFICATION builds the satisfiability probe per `assumed()`
  contract together with the vacuity probes of FORMAL_VERIFICATION
  §"Vacuity checking". The hypothesis probe asserts a function's entry
  premises and tries to prove `false`. When the premises are consistent,
  the solver's answer is `sat`, and its model is **one legal input of the
  function**. The plan keeps only the boolean. Keep the model too:
  `example_input` beside `vacuity` in the JSON report.
- **LP1b — examples from a contract.** `yo verify --examples <n> <fn>`
  returns `n` distinct models of the entry premises (each model is excluded
  before the next query), rendered as Yo literals (`i64(9)`, not
  `#x…09`). The use is the functions a proof does not cover: for an
  `assumed`, `outside-subset` or `unproven` body, the inputs drive the
  runtime checks the default keeps. Limits to state up front: solver
  models cluster at boundaries (useful for edge cases, not for coverage),
  and the first version covers scalar, `bool` and enum parameters only (an
  `ArrayList` is a ghost pair in the model, and rendering one back is
  separate work). Every query is cache-keyed, so output stays
  byte-identical per Z3 pin.
- **LP1c — document the two idioms** (the negated claim, and
  `assert(false)` for reachability) in the verification manual, both
  languages, as scratch-file tools: under the default they fail a build.

Rejected inside LP1: a dedicated `query(...)` form. The negated claim works
in a scratch file, a second spelling for a rare use fails "one canonical
spelling", and LP1b covers the common case (inputs of a function) without
new syntax.

**Verdict: adopt.** LP1a rides S2 (hours on top of it). LP1c is a docs PR,
anytime. LP1b is ~1 week of driver work and shares its literal renderer
with LEAN_ADOPTION_CANDIDATES LE3 (shrunk counter-examples) and with the
kept-guard report of D6; build the renderer once, in whichever lands first.
The fuzzing harness in RUST_ADOPTION_CANDIDATES T4 is the random-search
complement, not a substitute.

### LP2 — Search once, pin the witness, check forever

**Logic programming:** the witness is recomputed by search on every run.

**Yo today:** an `exists` obligation is either closed by the solver's own
quantifier search (`has_solution` in section 2) or by a witness the body
exhibits (`at` in `dml-sorted-insert.yo`, carried through the loop
invariants). The report does not distinguish the two. The first kind
depends on Z3's quantifier instantiation finding the value again after the
next pin bump; the second is a ground check.

**Candidate:** when an `exists` obligation is proved, `--explain <fn>` runs
one more query, the existential's body as a satisfiability question under
the same path facts, and prints the model as a line the author can paste:
`assert(P(w))` with `w` as a literal. This is LEAN_ADOPTION_CANDIDATES
LE7's "Try this" rule applied to witnesses: automation may find the
answer, and the author commits it. It is also the same stance as measure
inference ("the author writes the measure they mean").

**Rejected variant: a `comptime solve(...)` builtin** that asks Z3 for a
value during CTFE (a perfect-hash seed, a layout). The reason is item 5 of
section 3: a value has no fallback when the solver is missing or gives up,
and a model is not pinned the way a verdict is. LP5 is the form that works:
the search is a comptime function, so it needs no solver, and its result is
checked.

**Verdict: adopt with LP1** (it needs LP1b's literal renderer and nothing
else). Days.

### LP3 — `owed()`: spec-first as a stated, reported state

**Logic programming:** the specification is the starting artifact; a
relation is stated before anyone decides how to compute it.

**Yo today:** the top-down order already works. Callers are proved against
a callee's contract, so a module's contracts can be written and checked
against each other before any body exists (section 2). What is missing is
the accounting: the unwritten body is `ok` (vacuous) or `assumed`, and an
agent reading the report cannot tell a body it owes from a proof or from a
vouched std contract.

**Candidate:** a contract clause `owed()`, beside `assumed()`:

- It states that the body is not written. The body still has to type-check,
  and is normally a `panic(...)`.
- The verifier does not walk the body. Callers assume the contract, as with
  `assumed()`. The outcome is `owed`, with the contract's source text in the
  JSON entry, so the list of `owed` functions is an agent's work queue.
- `--strict` and the strict pragma fail on it. The default mode reports it
  in the build's summary and passes: an unwritten body is a legitimate
  state of a program under construction, and it panics honestly at run
  time.
- It never erases a guard, the rule `assumed()` already has
  (DEFAULT_ON_VERIFICATION §6). G1 and S6a's coverage line count it outside
  "proved".
- `owed()` needs at least one `ensures`, and `owed()` with `assumed()` is an
  error.
- A function that states an `ensures`, has zero obligations and has no
  `owed()` gets a hint in the report ("no path owes this `ensures`; if the
  body is not written, say `owed()`"). It is a hint, not a failure:
  `ensures(false)` on a function that always panics is a meaningful claim
  ("this does not return"), and detection cannot tell it from a stub. That
  is why the state needs a spelling.

**Verdict: adopt, before S6a** (about a week: the clause, the outcome, the
summary column, the `--strict` class, the hint, the manual in both
languages). It is a new builtin clause, so std may use it only after a seed
carries it; nothing in std needs it. The question doc carries the
recommendation for the maintainer's verdict.

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
`g_send_derivation_in_progress` (`:270`; "optimistically assume it
implements the marker", `:2645`). `Acyclic` has a sixth mechanism, a Tarjan
walk (`:500`), written after the field-by-field derivation answered a cycle
coinductively where the inductive answer was the sound one
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

### LP5 — Compile-time search: the comptime context as the search engine

**Logic programming:** execution finds the witness.

**Why comptime is the place where that fits.** The objections to search at
run time (one-shot continuations, hidden cost) and to the solver in CTFE
(no fallback, no pinned model) do not apply to a search written as an
ordinary comptime function. It is plain Yo with a loop; its cost is paid at
build time and bounded (10,000 iterations of fuel per loop,
`--compile-timeout-ms`); it needs no solver, so it runs wherever `yo` runs;
it is deterministic; and its result is a constant.

**Yo today, measured.** A comptime function searches, its own `ensures`
checks what it returns, and a verified function uses the result:

```yo
pragma(Pragma.Verify);
{ assert } :: import("std/assert");

// The search runs in the compiler. Its own contract checks the witness.
find_y :: (
  fn(comptime(n) : i64, ensures((r > i64(0)) && (((n - (r * i64(5))) % i64(3)) == i64(0)))) -> (comptime(r) : i64)
)({
  mut(y) :: i64(1);
  mut(found) :: i64(0);
  while(comptime((y < i64(100)) && (found == i64(0))), {
    cond(
      (((n - (y * i64(5))) % i64(3)) == i64(0)) => {
        found = y;
      },
      true => ()
    );
    y = (y + i64(1));
  });
  found
});

WY :: find_y(i64(47));
WX :: ((i64(47) - (WY * i64(5))) / i64(3));

// The verifier checks the witness; it does not search for one.
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
  assert(((WX * i64(3)) + (WY * i64(5))) == n);
});
```

`has_solution` is `ok` with 2 obligations proved (71 ms, 2 queries). The
search's contract is what makes a failed search visible: a variant that
returns `0` when it finds nothing, under `ensures(r > i64(0))`, stops the
build with `error: ensures failed: r > i64(0)`.

**What it can and cannot do for verification:**

- **It finds witnesses for claims about constants.** Tables, seeds,
  layouts, the `exists` of a law over fixed values. The verifier, or the
  search's own contract, checks them.
- **It decides closed, bounded claims about comptime code.** A comptime
  loop that tests `popcount8(v) <= 8` for every `v < 256` and feeds a
  module-level `comptime_assert` was measured to work; a ground obligation
  over a comptime callee is folded without a query.
- **It cannot discharge an obligation about a runtime value.** CTFE needs
  concrete inputs; the verifier's obligations range over all of them. So
  this complements the solver at the ground edge and replaces nothing.
- **It cannot prove a runtime function by running it over a small domain,
  today.** That would need the runtime function itself to run in CTFE.
  Measured: `comptime_fn` refuses a function whose body is a `while` ("The
  function body cannot be evaluated at compile time"), a function that
  recurses by its own name promotes and then yields an unknown value, and
  promotion is gated on the return type (COMPTIME_METAPROGRAMMING_AUDIT G4,
  to be widened by C4). A separately written comptime twin proves nothing
  about the runtime function. Where promotion does work, CTFE keeps the
  runtime width: `13!` in a promoted `i32` function is E1102 ("exceeds i32
  range"), so an evaluated result is never a different number from the
  compiled one.

**Candidate:**

- **LP5a — document the pattern** ("search in a comptime function, state
  the witness's property as that function's `ensures`, use the constant")
  in the CTFE and verification manuals, both languages. No code.
- **LP5b — evaluation as a proof of runtime code** ("for every `v < 256`,
  the runtime `f(v)` satisfies its `ensures`", decided by running `f`).
  This extends LEAN_ADOPTION_CANDIDATES LE8 from ground obligations to
  bounded quantifiers.

**Not taken inside LP5: a Prolog or Datalog interpreter as a comptime
library.** It is feasible in the sense that the Lisp interpreter of
COMPTIME_METAPROGRAMMING_AUDIT §4 is, but a search written directly as a
comptime function does the same job with its cost in view, and an
interpreter inside a tree-walking evaluator with 10,000 iterations of fuel
per loop is the slow way to run it. Nothing stops a package.

**Verdict: LP5a adopt, after the defect below is fixed; LP5b not taken
now.** LP5a must wait for
`issues/2026-11-22-a-comptime-assert-over-a-promoted-call-in-a-function-body-accepts-a-false-condition.md`:
a pattern whose check can pass without being decided is not one to teach.
LP5b fails on three counts today: promotion does not reach loops; the
domains where it would apply are few (the top reason a std function is
outside the subset is a parameter outside the integer/bool/array subset,
DEFAULT_ON_VERIFICATION §2.2, not a small domain); and it makes the
evaluator a proof engine (LEAN_ADOPTION_CANDIDATES P3). Trigger to
revisit: C4 lands and S5's subset growth meets table-driven std functions
(`std/encoding`'s alphabets and class tables) that the solver cannot walk.

## 5. Not taken

| Feature | Why not |
| --- | --- |
| backtracking execution (a `choose`/`fail` effect resumed more than once) | effect continuations are one-shot (`docs/en-US/ALGEBRAIC_EFFECTS.md:5`), and ownership forces that: a continuation holding owned values cannot run twice without copies nobody wrote. A search is spelled as an iterator or a loop |
| logic variables and runtime unification | control flow and cost that the source does not show; fails filter rule 2 |
| closed-world negation ("no clause proves it, so it is false") | a missing impl is an error to report, not a fact to compute with; negative impls are explicit (`impl(T, !(Send))`, TRAIT_COHERENCE) |
| `comptime solve(...)` | LP2: a value has no fallback when the solver is missing or gives up, and models are not pinned |
| a Datalog engine, in the compiler or in `std` | the origin and borrow rules are fixpoints the checker computes directly; Rust's Polonius was prototyped on a Datalog engine and its in-compiler rework does not use it (section 9). Datalog remains a fine _notation_ for stating such rules in a plan; no decision is needed for that |
| a Prolog or Datalog interpreter in the comptime context | LP5: a comptime function with a loop does the job with its cost in view |
| evaluation as a proof of runtime code | LP5b, with its trigger |
| constraint logic programming as a `std` module | nothing stops a package; no std consumer exists |
| proof extraction (camp 3) | needs constructive proof terms; the VC IR is first-order with theories by design (DEPENDENT_TYPES_POSITION; FORMAL_VERIFICATION §Non-goals) |
| a `query(...)` form | LP1: the negated claim and LP1b cover it |

## 6. Where the adoptees land

| Candidate | Lands as | Size | Depends on / trigger |
| --- | --- | --- | --- |
| LP3 `owed()` | a contract clause, a driver outcome, the summary, `--strict`, the hint, the manual | ~1 week | before S6a; G1 counts it |
| LP1a example input | inside DEFAULT_ON_VERIFICATION S2 (the probes) | hours on top | S2 |
| LP1c the two idioms | `docs/en-US` and `docs/zh-CN` FORMAL_VERIFICATION | a docs PR | anytime |
| LP5a the comptime search pattern | `docs/en-US` and `docs/zh-CN`, CTFE and FORMAL_VERIFICATION | a docs PR | the `comptime_assert` defect fixed |
| LP1b `--examples` | driver loop and a Yo-literal renderer | ~1 week | shares the renderer with LE3 and D6's report |
| LP2 witness "Try this" | `--explain` | days | LP1b's renderer |
| LP4 goal table | its own plan | weeks | a cycle-rule soundness bug, or TYPE_SYSTEM_SOUNDNESS reaching trait resolution |
| LP5b evaluation as proof | not scheduled | none | C4, and S5 meeting table-driven std code |

LP1 and LP2 touch only the verifier driver, its report and the manual. LP3
adds one clause to the contract surface. All keep the landed invariants:
pinned Z3, deterministic budgets, byte-identical verdicts per pin, and
`--strict` as the honest gate (LP3 strengthens it). In
[`POST_VBD_PLAN.md`](POST_VBD_PLAN.md)'s terms this file is a pull-only
candidate catalogue; LP1–LP3 belong to group E (verification), next to
DEFAULT_ON_VERIFICATION's steps.

## 7. Open questions, with recommendations

Each recommendation is the author's, for the maintainer's verdict.

1. **LP2: should the run summary count `exists` obligations proved without
   an author-exhibited witness?**
   **Recommendation: no.** Ship the "Try this" line and no count. A count
   needs a second query per `exists` obligation, on a path G3 bounds, and a
   definition of "exhibited" that depends on how the solver instantiates
   quantifiers. The hazard it would signal, a pin bump that stops finding a
   witness, is better caught where it happens: a pin bump is already a
   deliberate, release-noted event (FORMAL_VERIFICATION §"Solver harness"),
   so run the suite under the old and the new pin and diff the verdicts
   then. Revisit if a pin bump ever unproves an `exists` that a pinned
   witness would have kept.
2. **LP3: detection only, or an explicit clause?**
   **Recommendation: the explicit `owed()` clause, with detection as a
   hint.** Detection alone cannot separate a stub from a function that
   claims `ensures(false)` because it never returns, so it would either
   miss stubs or reject a legitimate claim. A clause states the author's
   intent, which is the "explicit over implicit" rule, and gives the report
   an exact count.
3. **LP3: does `owed` fail a default-mode build?**
   **Recommendation: no.** It is reported and counted; `--strict` and the
   strict pragma fail on it. This is D2's rule applied to an unwritten
   body: the default never stops a build for something that is not a
   refuted claim. A release build that must not ship stubs uses the strict
   gate, which is what it is for.
4. **LP1b: where do examples go?**
   **Recommendation: printed, never written into the source.** Text output
   is one call expression per example (`isqrt(u32(0))`), which pastes into
   a `test`; JSON carries `examples : [{ args, call }]`. Under the default
   the runtime checks are kept, so calling the function with the example is
   the whole test and there is no expected value to invent. Writing a
   `test(...)` skeleton into a file is a source edit with a naming rule and
   a placement rule, and belongs to `yo fix` if it is ever wanted.
5. **LP1c: do the query idioms deserve a form now that they fail a default
   build?**
   **Recommendation: no.** Document them as scratch-file tools run with
   `yo verify <file>`. A `query(...)` form would be a second way to ask
   what LP1b answers from the command line.
6. **LP4: which traits are coinductive?**
   **Recommendation: inductive unless declared, and declared coinductive
   for exactly the four structural markers: `Send`, `Sync`, `Comptime`,
   `Runtime`.** Their meaning is "every part has it", for which a
   self-reference adds no counter-example, and it is what the code does for
   `Send` and `Sync` today (`trait-checking.yo:2645`). `Acyclic` stays
   inductive, with its walk. `Copy` should be inductive: no value type
   reaches itself except through a `Box`, which is not `Copy`, or a raw
   pointer, which is `Copy` whatever it points to, so a real cycle of `Copy`
   obligations does not exist and the current "in-progress answers not
   lacking" needs an audit. Every user trait is inductive. LP4's plan
   should open with a table-driven test: one self-referential type per
   trait and per kind of cell, with the expected answer.
7. **LP5b: should evaluation ever count as a proof of runtime code?**
   **Recommendation: not now, and only as a visible tier if it is built.**
   The measured blockers are in LP5. If C4 and S5 fire the trigger, the
   result is reported as `proved (eval)` and never erases a guard, the rule
   LEAN_ADOPTION_CANDIDATES P3 already records for LE8.
8. **LP5a: where does the search's check belong, the search function's own
   `ensures` or a `comptime_assert` at the use?**
   **Recommendation: the function's `ensures`.** It was measured to be
   checked whenever CTFE runs the function, it travels with the function,
   and it does not depend on the `comptime_assert` path that the filed
   defect shows can pass undecided inside a body.

## 8. Defects found while measuring

| Doc | Kind | What |
| --- | --- | --- |
| `issues/questions/2026-11-21-a-contract-whose-body-is-a-panic-stub-passes-yo-verify-strict.md` | design question | LP3's recommendation |
| `issues/2026-11-22-a-quantified-contract-clause-compiles-only-under-pragma-verify.md` | S2 | blocks quantified contracts in the default's mode; S0's sweep will meet it |
| `issues/2026-11-22-a-comptime-assert-over-a-promoted-call-in-a-function-body-accepts-a-false-condition.md` | S2 | a false compile-time assertion passes in a `test` body; gates LP5a |
| `issues/fixed/2026-11-22-the-ctfe-manual-examples-assign-to-compile-time-bindings-declared-without-mut.md` | S3, fixed | four manual examples per language were rejected with E0917 |

## 9. References

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
