# What Yo can take from Bend 2 (laws, lemmas, and the agent loop)

**PROPOSED 2026-09-18 — backlog.** The keep/reject audit after studying
[bendlang/bend](https://github.com/bendlang/bend) ("Bend 2",
[bend-lang.com](https://bend-lang.com/)) against the live verifier
(`src/verifier/`, [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) V1–V6).
It is the sibling of
[`ZEROLANG_AGENT_FIRST_LESSONS.md`](ZEROLANG_AGENT_FIRST_LESSONS.md): a
comparison first, and then — because the user asked for it — an
implementation breakdown another agent can pick up phase by phase
(§Implementation phases). Nothing here is started.

The one-paragraph verdict: **Bend 2's verification foundation is the road
Yo deliberately did not take** (dependent types, hand-written inductive
proofs, mandatory termination —
[`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md)), and the
measured comparison below says that was right for per-function specs. What
Bend gets right is the **product wall**: specifications stated *outside*
the code, owned by the human, with a gate that cannot go quietly green — plus
a shipped agent loop (`bend guide`, `bend base`, a four-line `AGENTS.md`
recipe, a graded evals corpus). Yo has the machinery for all of it and the
surface for none of it, and today a `yo verify` run passes when every
contract has been `assumed()` away.

## What Bend 2 is

Not the 2024 Bend. HigherOrderCO rewrote it from scratch (Bend 1 programs and
HVM "do not carry over") and repositioned it: *"In the post-AGI economy,
humans will eventually stop writing and reading code, but we still need an
ambiguity-free language to communicate our intents to the AIs building the
world around us. Bend is that language."* Concretely (README, `guide/GUIDE.md`,
`AGENTS.md`, checked out at `0b7e2b11`, 2026-09-18):

- **Python syntax, Lean-like semantics.** An affine dependent type theory
  (BendTT — one universe, `Type : Type`, a "live/dead" wall instead of a
  positivity check) with quantities (`-x` erased, `x` affine, `+x`
  reusable), kinds (`Type` = use once, `Data` = copyable), compile-time
  templates (`~f`) instead of closures for higher-order std functions.
- **The type checker is the prover.** No tactics, no proof search, no
  automation: a proposition is a type, a proof is a `def` of that type,
  `{==}` closes a goal when both sides normalize to the same term, `%e : P`
  rewrites with an equation, a recursive call is the induction hypothesis.
  The pitch is checker *speed* ("under a second"), so an agent can re-check
  after every edit.
- **`LAWS.bend` / `PROOF.bend`.** A `law` is a claim with parameters and no
  body; a `def` of the same name (`Laws.name`) is its proof. `LAWS.bend` is
  the human's file ("asserts only; it proves nothing"); `PROOF.bend` is the
  AI's; `bend PROOF.bend` **fails while any law is open or false**. The
  README's line: *"`LAWS.bend` is `AGENTS.md` backed by proof."*
- **Mandatory structural termination**, no mutual recursion, no computed
  `match` (`match f(x)` is rejected), no `if` (match on `True{}`/`False{}`),
  `Nat`/`U32`/`F32` only, F32 axiomatic.
- **Parallelism = a "parallel let"** `a b = f(x) g(y)` (two independent,
  balanced calls; a binary fork-join scheduler that never migrates tasks),
  and `f!(x)` runs the call and everything under it on the GPU from the
  *same* emitted C file (Metal/CUDA). Purity + affinity make independence
  automatic; balance is the user's promise.
- **Agent loop as product.** `bend guide` prints the whole guide (~600
  lines, capped at 12k tokens by a repo gate), `bend base [Name]` prints the
  std or one name of it, the README tells you to paste four lines into
  `AGENTS.md`, `evals/` holds twenty tasks graded `easy`/`firm`/`hard`/`hell`
  where the model must implement code *and* proofs from given laws, and
  `gates/repo.ts` fails CI when any tracked file is off the allow-list or
  over its token cap.

## The honest caveats (Bend's own)

Its README lists ~40 limitations; the ones that matter for this audit:
*"Everything is annotated and nothing is inferred, so code is verbose"*, *"No
type classes, no traits"*, *"Values are affine: closures and arrays cannot be
shared"*, *"Recursion must be terminating"*, *"Computed matches aren't
supported"*, *"Strings are linked lists of characters"*, *"The compiler (not
kernel) is 99% AI-written and has not been fully audited yet"*, *"The Lean
formalization and bend.ts mismatch"*, *"Parallelism requires balanced calls"*,
*"One C file per program: no separate compilation"*, *"Error messages are
terse; no debugger, profiler, formatter, REPL or LSP"*. The trust claim
("merging a bug is mathematically impossible") rests on an unaudited checker
whose mechanization lags it — the same class of risk Yo's plan names as
"encoding/semantics mismatch" and mitigates with bugged twins.

## The measured comparison: proofs-as-programs vs. SMT contracts

Same property class, both repos, 2026-09-18:

| | Bend `demos/pure_par_sort` | Yo `tests/spec/fixtures/valid/spec_insertion_sort.yo` |
| --- | --- | --- |
| Property proved | the leaves' **sum** is preserved by `mix` and `sort` (not sortedness, not permutation) | **sortedness of the result AND multiset permutation** vs `old(s)` |
| Spec text | 2 laws, ~20 lines (`LAWS.bend`) | 2 `ensures` predicates, 4 lines |
| Proof text | `PROOF.bend`: 102 lines — 7 hand-written lemmas (`add_zero`, `add_succ`, `add_comm`, `add_swap`, `add_regroup`, `mix_leaf`, `sum_flow`) chained with explicit rewrites | ~40 lines of loop invariants; Z3 does the per-iteration induction |
| Who does the induction | the author (each recursive call is an IH the author must place) | the solver, over the loop's havoc/invariant rule (V4) |

Two readings, both true. Per-function functional specs over arrays and
integers: Yo's automation wins outright, and Bend's own demo picked the
weaker property because the stronger one is expensive by hand. **Whole-program
laws over recursive data** — Bend's flagship *"for any sequence of moves,
replaying them from the start can never lead to victory"* — need induction
over a datatype (the move list) plus lemmas, and Yo has **no lemma construct
at all** (the plan does not contain the word): a `ghost_fn` is inlined at its
call site (`_ghost_fn_inline_term`, `src/verifier/vc.yo`), never verified as
its own theorem, and a self-reaching `ghost_fn` is a subset error. That is
the technical gap §A2 fills.

## What Yo already has (the audit's baseline)

- The contract surface and the verifier through V6: `requires`/`ensures`
  with labeled returns, `invariant`/`decreases`, `ghost`/`ghost_fn`,
  `forall`/`exists`/`==>`, `old(...)` two-state, ghost `Seq`/`Multiset`/
  `Set`, `refine(T, p)`, trait-contract variance, generic callees,
  mutual-recursion cliques, AoRTE on unannotated code, counter-examples,
  `verify+` strip, the rlimit-deterministic Z3 harness with a cache, `yo
  verify --format json --explain`. Bend has none of the automation and none
  of the gradual mode.
- **Synthetic verify tasks already exist**: the trait-variance obligation
  registers a task whose body is a *synthesized* `begin(assert(...), ...)`
  (`register_verify_task(VerifyTask(fn_id : "impl-variance@..."))`,
  `src/evaluator/builtins/contracts.yo` ~L2143). A `law` is exactly this
  shape with user-written predicates — the mechanism is built.
- The call rule already **assumes a contracted callee's `ensures`** and, on
  a self-call with `decreases`, proves the measure and assumes the
  `ensures` of the recursive call (`src/verifier/vc.yo` ~L3782 — "the
  well-foundedness step that makes the ensures-assume below sound"). That
  *is* an induction hypothesis; it is just never offered to a `ghost_fn`.
- `assumed()` (V6 task 5) marks a contracted fn whose body is outside the
  subset; the report outcome is `assumed`, and **`assumed` and
  `outside-subset` pass like `ok`** in both `yo verify` exit paths
  (`src/main.yo` ~L728 and ~L1502). Deliberate for dogfooding
  `std/collections` — and exactly the hole §A1 closes for a laws gate.
- Agent-facing pieces: `yo skills install` (bundled `.github/skills/`,
  ~2.6k lines of cheatsheets), `yo init` writing an `AGENTS.md`, `yo explain
  E0xxx`, `--error-format json`, `yo fix` with structured repairs, `yo doc
  -f markdown`, the bilingual CLI. Missing: anything that *prints* the guide
  or the std from the binary (ROADMAP Phase 4.1 `yo context` — unbuilt).
- Parallelism: `Thread(T)` / `ThreadPool` / `Channel` with `Send`/`Acyclic`
  bounds (`std/thread.yo`, `docs/en-US/PARALLELISM.md`). No structured
  fork-join form; no GPU.

## Adopt (ranked by value/effort)

### A1 — A gate that cannot go quietly green (`yo verify --strict`)

Bend's `bend PROOF.bend` fails while any law is open. Yo's `yo verify`
passes when a fn is `assumed`, `outside-subset` or (in `verify+`) `unproven`.
That is right for dogfooding std, wrong for a laws gate: an agent editing
an implementation can add `assumed()`, drop an `ensures`, or push the body
outside the subset and CI stays green with **no** signal. `--strict`
(equivalently `--deny assumed,outside-subset,unproven`) fails the run on
those outcomes and lists them; the text and JSON summaries always print the
count of assumed/outside-subset fns so a non-strict run is still honest.

### A2 — Laws and lemmas: specs outside the code, proved by induction

Two builtins, one mechanism:

- **`law(fn-type)`** — a module-level claim with no body:

  ```rust
  pragma(Pragma.Verify);
  { sort, sorted } :: import("./sort");

  // LAW: sort's output is sorted, for every input.
  sort_is_sorted :: law(fn(xs : Array(i64, 8), ensures(sorted(sort(xs)))) -> unit);
  ```

  The argument is a **function type** carrying `requires`/`ensures` (the
  same clause zones as any signature) — no body, because the proof is the
  solver's job. It registers a synthetic verify task (`law@module:row`) whose
  body is `assert(E)` per `ensures` predicate under the assumed `requires`;
  every call inside the predicates goes through the existing call rule
  (contracted callee ⇒ prove its `requires`, assume its `ensures`; ghost_fn
  ⇒ inline or, after A2's second half, contracted spec call). A law about an
  *uncontracted* fn is a subset error naming the callee with the hint "add
  `ensures(...)` to `<callee>` or a `law` about it" — Bend's "open claim". A
  law is erased at codegen; in `runtime` mode it is a no-op marker. Laws
  live wherever the user wants; the convention this plan recommends is a
  `spec/` directory the human owns (CODEOWNERS), verified with `yo verify
  --strict ./spec` — the `LAWS.bend`/`PROOF.bend` wall with Yo's split:
  claims in `spec/`, proofs are the contracts and invariants the agent
  writes in the code.

- **Lemmas = contracted `ghost_fn`s.** A `ghost_fn` whose signature carries
  `ensures` (and optionally `requires`/`decreases`) is no longer inlined at
  its call sites: it is a **contracted spec callee** (prove `requires`,
  assume `ensures`), verified as its own task, and its recursive self-call
  under `decreases` assumes its own `ensures` — the induction hypothesis,
  through the rule that already exists for runtime fns. A `ghost_fn`
  without contracts keeps today's inlining. Invocation for its `ensures`
  from a verified body or a law is the existing `ghost(<call>)` statement
  shape (`evaluate_ghost` already runs the argument in ghost context).
  Dafny's `lemma` with no new syntax.

  The piece that makes lemmas *useful* — and that the verifier lacks today —
  is **definitional unfolding of recursive spec functions**. A recursive
  `ghost_fn` cannot be inlined (the inlining stack rejects a spec function
  that reaches itself), and the verifier never opens a callee's body, so a
  claim like `sum_from(a, i) >= 0` has nothing to reason from. Dafny's
  answer, adopted here: a contracted `ghost_fn` gets an SMT **function
  symbol** (`declare-fun`, the shape `__yo_msof_<elem>` already uses in
  `src/verifier/encode.yo` ~L117) and, at every call, the walk asserts the
  **definitional axiom instance** `f(args) == body[args]` with **fuel 1**:
  the body's own inner `f(...)` calls stay opaque applications of the
  symbol. One level of unfolding plus the induction hypothesis is exactly
  what a structural proof step needs; the fuel bound keeps the encoding
  finite and the budget deterministic.

  ```rust
  // A recursive SPEC function over a fixed array (comptime N).
  sum_from :: ghost_fn((fn(a : Array(i64, 8), i : i64, decreases(i64(8) - i)) -> (s : i64))(
    cond((i >= i64(8)) => i64(0), true => (a(i) + sum_from(a, i + i64(1))))
  ));

  // LEMMA: a non-negative array has non-negative suffix sums — by induction on i.
  sum_from_nonneg :: ghost_fn((fn(
    a : Array(i64, 8), i : i64,
    requires(forall(p : i64, ((p >= i64(0)) && (p < i64(8))) ==> (a(p) >= i64(0)))),
    ensures(sum_from(a, i) >= i64(0)),
    decreases(i64(8) - i),
  ) -> unit)(cond((i >= i64(8)) => (), true => ghost(sum_from_nonneg(a, i + i64(1))))));
  ```

  Bend's flagship *"you can't win"* law needs **no lemma** in Yo — that is
  the point of the SMT bet: `step` is a runtime fn with `requires(safe(g))`
  / `ensures(safe(r))` proved inside its own body, `replay` is a loop with
  `invariant(safe(g))` proved from `step`'s contract, `safe`/`won` are
  plain (inlined) ghost fns, and the law

  ```rust
  never_wins :: law(fn(moves : Array(Move, 64), ensures(!(won(replay(start(), moves))))) -> unit);
  ```

  closes from `replay`'s `ensures` plus the inlined definitions. It is a B1
  fixture. Lemmas are for the properties Bend's `pure_par_sort` proof is
  made of — facts about *recursive spec functions* (`sum`, `count`,
  `sorted_from`) that no runtime contract states.

### A3 — The agent loop as a shipped surface

Bend: `bend guide`, `bend base [Name]`, four `AGENTS.md` lines. Yo: `yo
guide` printing the bundled cheatsheets (the `yo skills install` lookup
already finds them: `YO_SKILLS`, then the checkout's `.github/skills`), `yo
std <module-or-name>` printing signatures + doc comments via the existing
markdown renderer (`src/doc_command.yo` `format == "markdown"`), and the `yo
init` `AGENTS.md` template gaining the verification recipe ("keep laws in
`spec/`, run `yo verify --strict ./spec` before committing"). This is ROADMAP
Phase 4.1 (`yo context`) with a concrete shape and a competitor validating
it.

### A4 — An evals corpus

Bend's `evals/` (twenty `*.bend` files, `easy.*` … `hell.*`, each a
narrative + types + laws the model must satisfy) is the artifact the plan's
"Design for LLM authorship" section asserts about without measurement. Yo's
first corpus is nearly free: every `tests/spec/fixtures/valid/*.yo` with its
implementation blanked and its contracts/laws kept is a task whose oracle is
`yo verify --strict` + the runtime test. Score = laws closed without
`assumed()`. Not a CI gate ("the models' arena, not the repo's shape"), but
the ROADMAP Phase 4 corpus and the only way to know whether the verifier's
diagnostics are actually actionable for an LLM.

### A5 — A repo-shape gate with token caps

`gates/repo.ts`: every tracked file must match an allow-list line and stay
under a token cap (guide 12k, README 3k, tests 16k). The discipline this buys
is that the agent-facing text stays loadable into a context window. Yo's
equivalents: `syntax-cheatsheet.md` is ~2.1k lines, `FORMAL_VERIFICATION.md`
is ~1.9k, `src/main.yo` ~7.5k. Start with caps on the agent-facing files
only (`.github/skills/**`, `AGENTS.md`, `docs/en-US/*.md`), byte-based (no
tokenizer dependency; 4 bytes ≈ 1 token), as a fmt-gate-style CI job.

### A6 — A structured fork-join form (`par`)

Bend's `a b = f(x) g(y)` is safe because the language is pure. Yo can get
the ergonomic with existing machinery: a std function first
(`par2(a : Impl(Fn(io : Io) -> A, Send), b : Impl(Fn(io : Io) -> B, Send)) ->
(A, B)` over `ThreadPool`, running one arm on the calling thread), a `par(...)`
macro over it later. Independence is checked, not promised: the closures'
`Send` bound plus the effect row (no `inout` capture, no shared mutable
state) — the "effect system as the frame rule" idea applied to parallelism.
GPU is out of reach (a whole runtime); recorded as Bend's real technical
lead, not adopted.

## Reject

- **Dependent types as the verification foundation** — decided in
  [`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md); the
  comparison above is fresh evidence for the decision.
- **Hand-written proofs / no automation** — the plan's non-goal "no
  interactive theorem proving" stands; A2 keeps the solver as the prover
  and adds only the ability to *state* lemmas.
- **Mandatory termination** — D12 (partial correctness default) stands.
- **Affine-by-default values, quantities, kinds** — Yo's RC + `own`/`inout`
  modes are the memory model; nothing to import.
- **`Nat`/`U32`/`F32` only, no `if`, no computed `match`** — expressiveness
  cuts Bend made for its checker; Yo's subset table grows the other way.
- **Python-shaped syntax** — no.
- **Content-hash-only package hub** — Yo's store is content-addressed *and*
  named (`yo.toml`/`yo.lock`); Bend lists "no names, versions, accounts or
  search yet" as a limitation.
- **One C file, no separate compilation** — Yo has chunked emission and a
  build DAG.

## Implementation phases

Each phase is independently shippable and has its own PR. B0 → B1 → B2 is
the dependency chain; B3–B6 are independent of it and of each other. Every
phase: `yo fmt` on touched `.yo` files, `yo check ./src`, the named test
files, docs in both `docs/en-US/` and `docs/zh-CN/`, cheatsheet update,
`plans/README.md` untouched (this doc's banner is the status). **Seed
gate:** B1 and B2 add builtin *words* (`law`) or change how a word is
dispatched; fixtures under `tests/spec/fixtures/` and internal tests are
compiled by the tree's own binary and are fine, but **no use in `std/` or
`src/` until `SEED_VERSION` carries the change**
([`SEED_VERSION_AUTOMATION.md`](SEED_VERSION_AUTOMATION.md); the `refine`
generation split in `FORMAL_VERIFICATION.md` V6 task 3 is the precedent).

### B0 — `yo verify --strict` (the honest gate)

> **Status: LANDED 2026-09-18.** `--strict` / `--deny <outcomes>` in
> `src/main.yo`; the pass/fail rule moved into the driver
> (`verify_report_is_failure` / `verify_report_is_degraded`,
> `src/verifier/driver.yo`) so `check`, `compile`, `yo verify` and the
> self-verification sweep cannot disagree — with an empty deny set the
> behavior is byte-identical to before. The outcome vocabulary is the
> driver's own list (`verify_outcome_names`), so the `--deny` usage error
> can never drift from the outcomes the verifier emits. Summary line +
> JSON `summary` carry all seven counts, the vacuous count, queries,
> cache hits and wall time (D4). Tests: four hermetic unit tests in
> `tests/internal/verifier.test.yo`, the solver-free
> `tests/cli-cases/verify-deny-unknown-outcome` case, and a CI step
> running `--strict` over the straight-line battery (which proves
> everything it declares, so it must pass strict). Docs en+zh,
> cheatsheet, and a `yo-design.instructions.md` section.
>
> **Deviation from the plan (recorded):** the planned
> `tests/cli-cases/verify-strict-assumed` case is NOT what landed. A
> `yo verify` case runs in a sandbox with its own `HOME`, so asserting
> the strict exit code there would make the case download Z3 or depend on
> a machine-specific solver path. The landed case asserts the `--deny`
> usage error instead, which is validated during option parsing and is
> therefore genuinely solver-free; the strict exit code is gated by the
> unit tests and the CI step, both of which have a real solver.

**Scope.** A flag that makes `assumed`, `outside-subset` and `unproven`
outcomes fail the run, and summaries that always count them.

Tasks:

1. `src/main.yo`, the `verify` option loop (~L1290): add `--strict`
   (boolean) and `--deny <list>` (comma-separated outcome names; `--strict`
   = `--deny assumed,outside-subset,unproven`). Unknown outcome names are a
   usage error listing the vocabulary (`ok`, `assumed`, `outside-subset`,
   `unproven`, `refuted`, `solver-error`, `subset-error`).
2. The two pass/fail sites (~L728 and ~L1502) consult the deny set instead
   of the hard-coded `ok || assumed || outside-subset`. Keep the default
   behavior byte-identical.
3. Text summary: after the per-fn report, one line
   `verify: N ok, A assumed, O outside-subset, U unproven, R refuted — Q queries, T ms`
   (zero counts included — stable for greps; D4). JSON (`--format json`): a
   top-level `summary` object with the same counts, `queries`, `elapsed_ms`
   and a `strict : bool` field. Update
   the `--help` text (`src/main.yo` ~L6768) and `cli_lang.yo` strings.
4. `.github/workflows/test.yml` `verify` job (~L455): keep the
   `std/collections` step non-strict (dogfooding uses `assumed()`), add a
   strict step over `tests/spec/verify_straight_line.test.yo` so the flag is
   exercised in CI.

Tests: a `tests/cli-cases/verify-strict-assumed/` case (fixture with an
`assumed()` fn: default rc 0, `--strict` rc 1 and the summary line — record
the golden with `--record`; `cmd` needs a trailing newline);
`tests/internal/verifier.test.yo` gains a summary-counting unit test over a
mocked report list.

**Exit:** `yo verify --strict tests/spec/fixtures/valid/assumed_body.yo`
fails naming the assumed fn; without the flag it passes with `1 assumed` in
the summary; CI verify job green.

**Estimate:** 2–3 days. No seed gate.

### B1 — `law(fn-type)`: standalone claims

**Scope.** The builtin, its verify task, its diagnostics, its erasure.

Tasks:

1. `src/expr.yo`: `BF_LAW` next to the contract builtins (`BF_REQUIRES` …
   `BF_ASSUMED`). Reserve the word in the reserved-list + `GRAMMAR` docs
   (en + zh) the way `forall`/`exists` were (V5 §6 banner).
2. `src/evaluator/builtins/contracts.yo`: `evaluate_law`. Validation: exactly
   one argument, which must evaluate to a **function type** (`TypeValue.Func`)
   whose clause list has at least one `ensures` (a law with no `ensures`
   is a signature error: "a law must claim something"); `-> unit` required
   (a law has no value; the labeled-return rule for `ensures` makes any
   other return type meaningless here — reject with the unit-return
   message). Read the contract side tables under the fn-type-expr id
   (`get_func_requires_exprs` / `get_func_ensures_exprs`, keyed exactly as
   signature extraction leaves them before `copy_func_contract_exprs`
   re-keys to a FuncVal — a law has no FuncVal, so read the fn-type key).
   The result value is `unit`; module-level `name :: law(...)` therefore
   binds `unit`, and codegen emits nothing (confirm with `--emit-c`).
3. Registration, mirroring the impl-variance synthetic task (~L2143):
   `fn_id : "law@<module>:<row>"`, `func_id` a fresh synthetic id (no
   FuncVal), params from the fn type, `body` = `begin(assert(E_1), …,
   assert(E_n), tuple())` with the `ensures` predicates as the asserts and
   the `requires` predicates as `requires_exprs` (the walk assumes them on
   entry), `ensures_exprs` empty, `mode` from the file's pragma / `--verify-mode`,
   `body_assumed : false`. Run `evaluated_for_verify` on the synthesized
   body under a frame binding the params (as the variance task does).
   Only `verify`/`verify+` register; `runtime` mode evaluates the argument
   for diagnostics and returns `unit`.
4. `src/verifier/driver.yo`: a law task is reported with `kind : "law"`
   (text prefix `law` instead of `fn`; JSON field). A law is never
   `outside-subset` (it always has contracts) — a body outside the subset
   is `subset-error`. Its subset error for an uncontracted callee gets the
   hint text from §A2 (`_fail_subset` message in `vc.yo` ~L3772: extend
   the "call to an uncontracted" branch with the callee's display name and
   the hint when `ctx.fn_id` starts with `law@`).
5. `verify+`: a law has no runtime body to strip; `unproven` in `verify+`
   is a **warning** for fns (fallback to asserts) but there is nothing to
   fall back to for a law — report `unproven` and let `--strict` decide
   (document this asymmetry in the modes table).
6. Docs: `docs/{en-US,zh-CN}/FORMAL_VERIFICATION.md` new section "Laws:
   claims outside the code" with the `spec/` + CODEOWNERS convention and
   the `--strict` recipe; `syntax-cheatsheet.md` "Design-by-contract
   clauses" gains `law`; `yo-design.instructions.md` one paragraph.

Tests: fixtures `tests/spec/fixtures/valid/law_sorted.yo` (a law over the
existing contracted `insertion_sort` shape — prove sortedness from its
`ensures` alone, no body opened), `valid/law_requires.yo` (a law with
`requires` assumed), `negative/law_false.yo` (refutes with a
counter-example), `negative/law_uncontracted_callee.yo` (subset error + the
hint), `negative/law_no_ensures.yo`, `negative/law_nonunit.yo`; a runtime-mode
twin proving erasure (`--emit-c` contains no trace of the law);
`valid/law_game_never_wins.yo` (Bend's flagship demo in Yo's idiom — see
§A2: contracted `step`, `replay` with `invariant(safe(g))`, inlined ghost
`safe`/`won`, no lemma) with `negative/law_game_wraps.yo` (the torus wrap
that let the player reach the flag — refutes with a move sequence as the
counter-example);
`tests/internal/verifier_law.test.yo` driving them (the
`verifier_refine.test.yo` shape: subprocess `yo verify`, assert outcome
strings and counter-example text).

**Exit:** the six fixtures behave as named; `yo verify --strict` over a
`spec/` directory containing only laws is a meaningful gate (green iff every
law proves); cheatsheet + docs updated.

**Estimate:** 1–1.5 weeks. Seed gate applies to `std/`/`src/` use only.

### B2 — Lemmas: contracted `ghost_fn`s verified by induction

**Scope.** Dispatch change in the call rule, SMT function symbols +
definitional unfolding (fuel 1) for contracted spec functions, task
registration for ghost fns, the `ghost(call)` statement in the walk.

Tasks:

1. **Probe first** (30 min, `tmp/fixme.yo`): does a `ghost_fn` whose
   signature carries `ensures` already register a `VerifyTask` under
   `Pragma.Verify`? (The fn-type evaluator registers tasks at ~L1548 of
   `contracts.yo` for contracted fns; `evaluate_ghost_fn` wraps a normal fn
   value, so it plausibly does.) Record the answer in this section's
   banner; it decides whether task 4 is "confirm" or "add".
2. `src/verifier/vc.yo` call rule (~L3778): **before** the
   `is_ghost_fn ⇒ inline` branch, check whether the callee carries any
   contract (`get_func_requires_exprs` / `get_func_ensures_exprs` /
   `get_func_decreases_expr` non-empty) → fall through to the
   contracted-callee path (prove `requires`, assume `ensures`; self/clique
   recursion needs `decreases` exactly as for runtime fns). Uncontracted
   ghost fns keep inlining. The inlining-stack error keeps its message for
   the uncontracted recursive case, plus the hint "give the spec function
   `ensures(...)` + `decreases(...)` to prove it by induction".
3. **Function symbols + unfolding.** A contracted `ghost_fn` with a
   non-`unit` return gets one `declare-fun __yo_gf_<func_id>` over its
   parameter sorts (register in the query's declaration set the way
   `__yo_msof_<elem>` is, `encode.yo` ~L117–L124; `VcTerm` needs an
   application node — reuse the msof application shape or add
   `VcTerm.App(name, args)`). At each call: the call's value term is the
   application; the walk asserts (a) the callee's `ensures` with the label
   bound to the application, and (b) **the definitional instance**
   `app == body[params := args]` walked with **fuel 1**: inside that one
   body walk, a further call to the same symbol is the bare application
   (no second unfolding), and `requires` of the callee is proved at the
   outer call only. Record the fuel constant next to the rlimit default;
   it is part of the cache key.
4. Ghost-fn verify tasks: a contracted `ghost_fn` is a task (`fn_id`
   prefix `ghost@` for the report) whose body is walked with its own
   `ensures` as obligations; the return label binds as for any fn. The
   `-> unit` lemma shape (pure facts, body made of `ghost(...)` calls and
   `cond` splits) needs no function symbol.
5. `ghost(<call>)` as a statement in a verified body: `evaluate_ghost`
   already runs the argument in ghost context; the walk's `ghost` branch
   (~L2550 handles only `ghost(x := e)`) gains the call shape: prove the
   callee's `requires`, assume its `ensures` (and its definitional
   instance, task 3) under the current path, produce `unit`. Codegen
   already erases `ghost(...)` (V5 ledger entry 2) — confirm with
   `--emit-c` on the fixture.
6. Laws stay body-less. A law that needs a lemma's fact states it through
   the lemma's `ensures` (call the lemma where a `bool` is needed, or give
   the lemma a universally quantified `ensures` the law's predicate can
   use). If a real fixture cannot be written this way, record it under
   Open Questions rather than adding a body to `law`.
7. Docs: "Lemmas" subsection after "Laws" in both languages; cheatsheet;
   the subset table row "recursive spec functions" moves from *out* to
   *fuel-1 unfolding*.

Tests: `valid/lemma_sum_from_nonneg.yo` (the §A2 pair: recursive spec
`sum_from` + the inductive lemma; proves with the IH and one unfolding),
`valid/lemma_used_by_law.yo` (a law whose proof needs the lemma's
`ensures`), `negative/lemma_false.yo` (drop the `requires` → the lemma
refutes with a concrete array, and the law that used it is *not* reported
proved — pins that a lemma is an obligation, not an axiom),
`negative/lemma_no_decreases.yo` (recursive contracted ghost fn without
`decreases` is a subset error with the hint), `negative/lemma_fuel.yo` (a
fact that needs two unfoldings is `unproven`, not `refuted` — pins the fuel
bound and its message "needs a lemma for the inner step");
`tests/internal/verifier_lemma.test.yo`.

**Exit:** the five fixtures behave as named under `yo verify --strict`;
Bend's `sum_flow`-style fact (`sum` of a spec `mix`/`flow` over a fixed tree
is preserved) is expressible as a lemma over recursive ghost fns and proves
through one unfolding + the IH, without opening any runtime body.

**Estimate:** 2–3 weeks (task 3 is the substance). Seed gate applies to
`std/`/`src/` use only.

### B3 — `yo guide`, `yo std`, and the `AGENTS.md` recipe

**Scope.** Three small CLI additions; no compiler change.

Tasks:

1. `yo guide [skill]`: print the bundled `.github/skills/<skill>/*.md`
   (default: `yo-syntax`'s cheatsheet then `yo-core-patterns`'), resolved by
   the same lookup `yo skills install` uses (`src/skills_command.yo`
   ~L186–L195: `YO_SKILLS`, then the checkout). `yo guide --list` names the
   skills with their `description:` frontmatter (already parsed there).
2. `yo std <path-or-name>`: run the doc extractor over the bundled std
   (`--std-path` respected) and render **markdown** for one module
   (`yo std collections/array_list`) or one name within it
   (`yo std collections/array_list ArrayList.push`) — signatures and doc
   comments only, no bodies. Reuse `src/doc_command.yo`'s `format ==
   "markdown"` path; add a name filter.
3. `src/init.yo` `AGENTS.md` template (~L186): add the four-line recipe
   under the build commands, and scaffold `spec/README.md` (D3: the
   claims/proofs wall in two paragraphs plus the CODEOWNERS line to add)
   — `yo guide` to learn the language, keep laws in
   `spec/`, `yo verify --strict ./spec` before committing, `yo check` after
   every edit. Re-record the `init-*` and `skills-install*` cli-case goldens
   (the `AGENTS.md` hash is in `expected_tree`; skills edits re-record
   `skills-install`/`-zh`).
4. Bilingual strings via `tr(...)` (`src/cli_lang.yo`); `--help` entries.

Tests: cli-cases `guide-default`, `guide-list`, `std-module`, `std-name`;
re-recorded `init-*`.

**Exit:** a fresh agent with only the binary can run `yo guide` and `yo std
collections/array_list` and get the same text `.github/skills` and `yo doc`
would give; `yo init` projects tell agents to verify.

**Estimate:** 1 week. No seed gate.

### B4 — The evals corpus

**Scope.** An `evals/` directory and a runner; not a CI gate.

Tasks:

1. `evals/README.md`: format (one `.yo` per task: a narrative comment,
   types, the laws/contracts — implementation bodies replaced by
   `__yo_eval_todo()` or left as `panic("TODO")` so the file still parses),
   grading (`easy`/`firm`/`hard`/`hell`, Bend's ladder), the oracle
   (`yo verify --strict <task>` green **and** the task's runtime
   `test(...)`s pass **and** `grep -c "assumed()"` is zero), and what is
   measured (tasks closed per model per budget; the diagnostics an agent
   hit — this is the feedback loop for `FORMAL_VERIFICATION.md` §Design for
   LLM authorship).
2. Seed the corpus from `tests/spec/fixtures/valid/`: `spec_insertion_sort`
   (hard), `loop_invariant`/`recursion_decreases` (easy), `spec_multiset`
   (firm), the B2 game law (hell), plus 6–8 new tasks written from Bend's
   `evals/` themes re-expressed in Yo's subset (stack split/merge,
   inventory pruning, tic-tac-toe undo, AVL leaderboard is out of subset
   until `object` lands — say so).
3. `scripts/evals/run.sh <agent-command>`: for each task, copy to a sandbox,
   run the agent command with the task path, then the oracle; write a
   `results.tsv` (task, grade, closed, seconds, assumed-count). Resumable
   (the sweep-script pattern in `scripts/bootstrap/`).
4. Exclude `evals/` from `yo test ./tests` and from the fmt gate the way
   `tests/cli-cases` fixtures are handled; include it in `yo fmt --check`
   only for the checked-in (unsolved) files.

**Exit:** ten tasks, the runner producing a table for one model, the table
linked from `FORMAL_VERIFICATION.md` §Design for LLM authorship as its first
measurement.

**Estimate:** 1 week (mostly authoring). No seed gate.

### B5 — Repo-shape gate with token caps

**Scope.** A CI job over agent-facing files.

Tasks:

1. `scripts/repo-shape.sh`: an allow-list of `<glob> <byte-cap>` lines in
   `scripts/repo-shape.allow`; every tracked file under the covered
   directories must match one line and stay under its cap
   (`wc -c`; 4 bytes ≈ 1 token, caps written in bytes with the token
   equivalent in a comment). Start with `.github/skills/**`, `AGENTS.md`,
   `docs/en-US/*.md`, `docs/zh-CN/*.md` (caps set to today's sizes + 20% so
   nothing fails on day one; tightening is a separate decision).
2. `test.yml`: a `repo-shape` job next to the fmt gate; **not** a required
   check until it has run green for a week (branch protection is a manual
   list — `branch-protection-enabled` memory).
3. Document in `.github/instructions/documentation.instructions.md`: the
   caps exist so the agent-facing text stays loadable; raising a cap is a
   deliberate PR line.

**Exit:** the job is green on `develop`; a deliberate over-cap file fails it
locally.

**Estimate:** 1–2 days. No seed gate.

### B6 — `par2` / `par(...)` structured fork-join

**Scope.** std first, macro later, no compiler change in slice 1.

Tasks:

1. `std/thread.yo`: `par2 :: (fn(generic(A, B), a : Impl(Fn(io : Io) -> A,
   Send), b : Impl(Fn(io : Io) -> B, Send), where(A <: (Send, Acyclic)), where(B <:
   (Send, Acyclic))) -> (A, B))` — submit `a` to a pool (or a fresh
   `Thread(A)`), run `b` on the calling thread, join. Document the balance
   promise (Bend's second rule) and that independence is *checked* by
   `Send` + the effect row. `par_n` over an `Array` of closures if the
   generic shape allows it.
2. Slice 2 (separate PR, after slice 1 is in the seed): a `par((a, b) :=
   (f(x), g(y)))` macro desugaring to `par2` — only if the macro policy
   (`MACRO_POLICY.md`: definitions gated behind `Pragma.AllowMacroDef`)
   permits a std-defined macro; otherwise stop at `par2`.
3. `docs/{en-US,zh-CN}/PARALLELISM.md`: a "Structured fork-join" section;
   tests in `tests/` (a divide-and-conquer sum over an array, asserting the
   result and that both arms ran on distinct thread ids via
   `get_thread_id`).

**Exit:** `par2` in std with tests green on all six CI platforms (WASM
excluded per the parallelism docs).

**Estimate:** 1 week (slice 1). Seed gate applies to any use inside `src/`.

### Sequencing

```
B0 strict gate ──> B1 law ──> B2 lemmas ──> (FORMAL_VERIFICATION.md gains a
                                              "Laws & lemmas" phase banner)
B3 yo guide / yo std / AGENTS recipe        (independent; B3 + B1 make the
B4 evals corpus                              recipe real)
B5 repo-shape gate                          (independent, optional)
B6 par2                                     (independent)
```

When B0–B2 land, fold them into `FORMAL_VERIFICATION.md` as a phase (V8
"Laws and lemmas") and move this document to `plans/reference/` with a
banner; B3–B6 report their outcome in this file's header.

## Decisions (2026-09-18 — the maintainer asked for the recommended call on each open question)

| # | Question | Decision | Consequence in the plan |
| --- | --- | --- | --- |
| D1 | Laws over recursive datatypes (`ArrayList(Move)` instead of a fixed `Array(Move, N)`) | **No separate `seq_of` builtin.** `SELF_VERIFICATION.md` lever L4 models an `ArrayList(T)` value as `(Seq T)` through the std contracts, so a law quantifying over an `ArrayList` gets its `Seq` view for free once L4 lands | B1 ships the fixed-length game fixture; a second fixture over `ArrayList(Move)` is added by L4's PR, not by B1 |
| D2 | Lemma instantiation in laws (body-less vs a `using(...)` zone) | **Laws stay body-less.** A law states a claim; facts it needs enter through the lemma's `ensures` (call the lemma where a `bool` is needed, or quantify the lemma's `ensures` universally). A fixture that cannot be written this way is filed as an issue with the shape, not solved by growing the surface | B2 task 6 stands as written |
| D3 | Human ownership of `spec/` — compiler-enforced or convention | **Convention, documented; no compiler rule.** `yo init` scaffolds `spec/README.md` stating the wall (claims here, written by the human; proofs are the contracts and invariants in the code) and the CODEOWNERS line to add; `yo verify --strict ./spec` is the gate. The compiler does not know what a "law file" is | B3 task 3 gains the `spec/README.md` scaffold; B1 docs describe the convention |
| D4 | Checker speed as a product number | **Yes: B0's summary line prints wall time and the number of solver queries**, in text and JSON (`elapsed_ms`, `queries`), so `yo verify` has a number to improve and the self-verification sweep can chart it | B0 task 3 amended |

## References

- [bendlang/bend](https://github.com/bendlang/bend) — `README.md`
  (limitations list), `guide/GUIDE.md` ("Laws and Proofs", "Parallelism",
  "Templates"), `AGENTS.md`, `demos/app_win_is_bug_2d/{LAWS,PROOF}.bend`
  and its `README.md`, `demos/pure_par_sort/{LAWS,PROOF,main}.bend`,
  `evals/*.bend`, `gates/repo.ts`, `tests/proof/*.bend`; papers
  `paper/BendTT.pdf`, `paper/BendRT.pdf`. Checked out at `0b7e2b11`
  (2026-09-18).
- [bend-lang.com](https://bend-lang.com/); the old
  [HigherOrderCO/Bend](https://github.com/HigherOrderCO/Bend) and
  [HVM3](https://github.com/HigherOrderCO/HVM3) repos (Bend 1 era; not the
  subject of this audit).
- [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md) — the verifier this
  plan extends; its §Design for LLM authorship is what B4 measures.
- [`DEPENDENT_TYPES_POSITION.md`](DEPENDENT_TYPES_POSITION.md) — the
  decision the comparison section re-confirms.
- [`ZEROLANG_AGENT_FIRST_LESSONS.md`](ZEROLANG_AGENT_FIRST_LESSONS.md) — the
  sibling audit; its "Adopt" items 1 and 6 landed.
- [`../ROADMAP.md`](../ROADMAP.md) Phase 1 (verification flagship) and
  Phase 4.1 (`yo context`, which B3 realizes).
- Dafny `lemma` / `calc` (the model for B2); SPARK's ghost code; Bend's
  `law`/`def` pairing (the model for B1's split).
