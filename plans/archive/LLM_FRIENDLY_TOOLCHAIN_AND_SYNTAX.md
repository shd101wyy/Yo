# LLM-friendly toolchain and syntax: truthful results, mechanical fixes, one meaning per brace

> **CLOSED 2026-09-17 — every item implemented and gated.** Shipped as #718
> (this document), #720 (slice 1), #724 (slice 2) and #733 (the last item).
> Archived per `plans/README.md`: root holds active plans only. The decisions
> recorded here stay authoritative — `struct(generic(T), …)` is REJECTED and
> braces mean "record unless `;`" in every position — and the OUTCOME notes on
> §1.3 and §2 record where this document's own proposals were measured WRONG,
> which is the part to read before reviving anything from it.

**Status:** COMPLETE 2026-09-17 — written 2026-09-16 after
a two-agent day on the tree (member visibility #716/#717, FFI follow-ups #703,
value substitution #714) as the answer to "what would you change about Yo as an
LLM-targeted language", then implemented in two slices. Two decisions are made
by the maintainer and recorded below so nobody re-opens them: **`struct(generic(T),
…)` sugar is REJECTED**, and the brace question is DECIDED in §4 (keep "record
unless `;`" in every position; handle `{ x }` with a diagnostic), weighed with
compatibility explicitly NOT an input.

| item | state | where |
| --- | --- | --- |
| §1.1 residual silent degradation | LANDED — every marker-bearing body is rewritten to a loud stub, unit-returning ones included. Census first: 287 emitted batch `.c`, **0** surviving markers, 34 already-rewritten stubs, so this is a defensive invariant with no behaviour delta | #724 |
| §1.2 hollow batch | was ALREADY CLOSED when the plan was written (the `__yo_user_main` marker gate); a failed batch now leads with `0 of N tests in this batch ran` | #720 |
| §1.3 `check` forces specialized bodies | LANDED, **re-scoped by measurement**: generic fn and generic impl-method bodies were already checked. The real hole was the test-body trial swallowing every error, so `yo check --test-bodies` is the opt-in flag. Documented as a fast filter, not a gate | #724 |
| §1.4 `main` returns `unit` | LANDED — rejected in `mm_eval_entry_exprs`, so `check` and `compile` cannot disagree | #720 |
| §2 `yo fix` | LANDED in two parts. Diagnostics carry a structured `Repair` and `--error-format json` emits it (#724, parse-level apply only, which it SAID rather than printing "nothing to fix"). Evaluator repairs now apply too: `yo fix` renames `countr` to `counter` end to end and the file then evaluates (#733) | #724 + #733 |
| §3 generic "failed to evaluate" | LANDED — audited (**59 of 105** sites fire after an exn-less `evaluate_expression`) and fixed **once at the swallow** with an attempt-counter staleness guard, not at 59 sites | #720 + #724 |
| §4.3 the `{ x }` footgun | LANDED — reported at the literal, narrow by construction (punned single field, expected type that can never be a record) | #724 |
| §5 underscore surface | LANDED — `_( … )` is internal-only, 33 renaming imports converted. The discard rename was **already done** (a `_` binding is a fresh temp; `___` is an ordinary name) | #724 |
| §6 | rejected sugar, no work | — |

**The last item closed in #733**, and how it closed is worth more than that it
did. `yo fix` could not apply the rename `--error-format json` already showed,
because an error raised inside a definition body reached the typed stash as
plain text. The issue filed with #724 blamed the lazy-binding /
pending-definition path and prescribed carrying `failure_diagnostics` on
`PendingDef`. **That diagnosis was wrong.** The measured cause is the DEF-TIME
TRIAL (`evaluator/calls/function_type.yo`): its swallow handler renders the
error with `_err.to_string()` and the re-raise throws that string. Implementing
the prescription would have written plumbing for a path the reproducer never
takes — `YO_DEBUG_LAZY` shows the definition is never forced at all.

Found by instrumenting the channel (`YO_DEBUG_DIAGSTASH`, shipped) rather than
by reading: one DROP and a TAKE of nothing proved the diagnostics were never
STORED, then all eleven candidate flatten sites were instrumented at once and
none fired. **The method note: probe before building, and when a probe is
ambiguous, widen the probe instead of resuming reading.** Three further
eliminations by inference were each sound and together cost two builds.

Applying a repair also made `fix` take a second pass for the first time, which
exposed a latent generation bug — `clear_module_cache()` does not clear the
cached prelude env, so pass 2 re-minted std types and the id-comparing unify
guard reported `"ArrayList(u8)"` against `"ArrayList(u8)"`. Fixed by pairing
the prelude clear with the cache clear as the warm-compile path does; that is
knowingly a half measure, with the owner-tagged registry purge in
`INCREMENTAL_COMPILATION_ZIG_LESSONS.md` §7 step 1 as the real one.

Full record: `issues/fixed/evaluator-diagnostics-are-flattened-to-strings-before-the-typed-stash.md`,
which keeps the wrong diagnosis in an appendix on purpose. The LSP's typed
channel reads the same stash and is unblocked by the same change.

Companion plans that this one does not duplicate:
`INCREMENTAL_COMPILATION_ZIG_LESSONS.md` (edit-compile latency, resident
evaluator), the formal-verification track (`FORMAL_VERIFICATION*.md`), and
`reference/MEMBER_VISIBILITY.md` (the `_` rule).

## 0. The thesis

Yo's design already plays to what a model does well: one call syntax for
everything, no operator precedence, no implicit conversions, no overloading,
named imports, compile-time evaluation as the core mechanism. In a full day
of writing Yo under pressure the syntax errors were few and all of one kind.
The failures that cost real time were never syntax. They were **results that
read as success while meaning nothing**, and a build loop slow enough that
two agents spent a visible share of the day negotiating one build slot.

A human learns to distrust a green light. A model reads green and moves on.
So for an LLM-targeted language, *a toolchain that can lie* is the most
expensive property it can have, and it is where the next investment should
go, ahead of any syntax work. The catalogue of lies this repo has already
paid for, each one a memory or an `issues/` entry:

| the lie | what actually happened |
| --- | --- |
| "N passed" from `yo test` | one untranspilable expression made the batch's single `__yo_user_main` a comment, so every test in the file ran nothing (`yo-hollow-batch-voids-every-test-in-the-file`). **CLOSED** by the entry-point gate — kept here because §1.1 shows what is still open next to it |
| green `check ./std` + `check ./src` | `check` is evaluator-only and never specializes generic bodies; #717 found four private-member reaches that only the suite could see (`yo-check-src-std-are-a-filter-not-a-gate`) |
| a derive rule "worked" | derive swallows the rule's own error and reports a generic message, or nothing with rc=0 (`yo-derive-swallows-a-rules-own-error`) |
| `comptime_assert` passed | it can pass vacuously when the value is never forced (`yo-comptime-assert-vacuous-testing-trap`) |
| a repro "self-checked" and exited 0 | `main` is meant to return `unit`, but the compiler accepts `-> i32` and discards the value, so the exit code is always 0 (`yo-main-return-value-is-discarded-exit-code-is-always-0`) |
| green build, symbol missing | `--static-library` exported nothing because two spellings of a module path were compared with `==` (`issues/fixed/static-library-exports-no-symbols.md`) |

Every one of these was eventually caught by a person who happened to look at
the C, the log tail, or the exit code. The plan below makes the toolchain
say what happened.

## 1. P0 — the toolchain never reports success for work it did not do

### 1.1 The residual silent-degradation hole (READ THIS BEFORE TOUCHING IT)

**Corrected 2026-09-16 by reading the code: most of what §0 lists as a live
lie is already fixed, and two of the obvious fixes were BUILT AND REVERTED.
Do not re-attempt either.** The mechanism, in `src/codegen/functions/
generation.yo` around the per-function FTT scan (`stub_found_ftt`):

| case | today | verdict |
| --- | --- | --- |
| marker in the program's own `main` (`__yo_user_main`) | `codegen_fatal` — hard error | already loud; **this is what makes a hollow test batch fail**, because the runner inlines every test body into `__yo_user_main` |
| marker in a NON-void function, or in a superseded generic original | body rewritten to a stub that `fprintf`s its own name plus the `YO_DEBUG_SWALLOW=1` hint, then `abort()`s (PR #477) | already loud at runtime, at every `-O` |
| marker in a **unit-returning, non-superseded** function | comment stays in the body; the C compiler skips it; the statement is silently gone | **THE RESIDUAL HOLE** |

Two approaches are closed:

- **"any marker anywhere is fatal" was tried and reverted** — it fails
  `tests/fn.test.yo` and `tests/algebraic_effects.test.yo`, whose markers are
  dead superseded-generic code that never runs. The code comment at the gate
  records this.
- **the linker-as-oracle stub (body calls an undefined extern) was built and
  reverted** — a stub whose ADDRESS is taken survives DCE with no call, so a
  never-run stub fails the link; `tests/http` batch 102 installs one as an
  exception handler and the full suite failed under it
  (`yo-ftt-stub-error-attribute-dead-at-O2`). The `__attribute__((error))`
  variant is diagnosed post-optimization and never fires at `-O2`, which is
  every real build; it is kept only for the `-O0` upgrade.

So the work is narrow: **extend the existing loud-stub rewrite to the
unit-returning non-superseded case**, so that no emitted function can
silently drop a statement, while dead stubs stay harmless and live ones
`fprintf` + `abort()` exactly as the non-void ones already do. `main` stays
fatal.

**MEASURED 2026-09-16 — the residual set is EMPTY in the test corpus, so
this is a cheap defensive invariant, not a bug fix.** No instrumentation was
needed: a rewritten function has its prefix truncated, so its marker is GONE
from the emitted C, which makes any marker LEFT in the C exactly a residual
case. Emitted the whole fast-suite corpus with `YO_KEEP_BATCH=1` on a
tree-built compiler and counted:

| | count |
| --- | --- |
| batch `.c` files emitted | 287 |
| files containing a surviving `// Failed to transpile` | **0** |
| markers surviving anywhere in the corpus | **0** |
| functions rewritten to a loud `abort()` stub | 34 |

So the machinery fires often (34 stubs) and the silent-drop class does not
occur today anywhere in `tests/`. Consequences:

1. The change — extend the loud-stub rewrite to the unit-returning
   non-superseded case — has **no behaviour delta on this corpus**, which is
   acceptance case 2: land it with a synthetic cli-case as the only proof,
   and with fixpoint + byte-identity (the emitted C changes only for
   functions that contain a marker, so a clean corpus stays byte-identical).
2. Its VALUE is lower than estimated: it closes a hole nothing currently
   falls into. §1.3 (`check --bodies`) and §2 (`yo fix`) are the higher-value
   remaining items and should go first.
3. Re-run the count before landing it; a non-zero result means the tree has
   started silently losing statements, and each one is a bug to triage
   BEFORE the stub change, so the suite never goes red for a reason the PR
   did not cause.

### 1.2 Was the runner's hollow-batch hole (ALREADY CLOSED — kept as a note)

The 2026-08-12 case — `tests/internal/expr_info.test.yo` reporting 23 tests
passed while running nothing — is closed by the `__yo_user_main` gate above,
because the runner compiles every test body of a file into that one function.
Nothing to build here. Two things to preserve rather than implement:

- **Do not weaken the `__yo_user_main` gate to get a job green.** It caught
  the 23-test case on its first run (`yo-hollow-batch-voids-every-test-in-the-file`).
- The batch's per-file failure is currently reported as
  `test: batch compile failed (exit N)`. Worth one wording change so the
  count is unmissable: name the file and say **"0 of N tests ran"**, since
  "batch compile failed" reads like an infrastructure hiccup rather than
  "your tests did not run".

### 1.3 `check` can force the bodies the suite would specialize

`yo check` is fast because it never evaluates generic bodies. That is the
right default for an editor loop and the wrong bar for "did my change
break std". Add `yo check --bodies`: after the evaluator-only pass, force
every pending impl and specialize every generic function reachable from the
checked files with the argument types the tree itself uses (the demand
loader already records which modules import what). It is slower than plain
`check` and much faster than the suite, and it would have found all four
#717 sites. Acceptance: `check --bodies ./std ./src` reports the
member-visibility violations that `check` missed on the #716 branch when run
against that branch's pre-fix commit.

**OUTCOME (#724) — do not implement `--bodies` as written above.** Probing
first showed generic function bodies *and* generic impl-method bodies are
already checked, so the proposal's premise was wrong. The real hole is that
`yo check` on a `.test.yo` whose body references an undefined name reports
"evaluator OK", because the test-body trial swallows every error by design.
The flag that shipped is therefore **`yo check --test-bodies`**, and it is
documented as a fast filter rather than a gate (the trial takes a different
generic-inference path than the real `main` wrapper and has known false
positives).

### 1.4 `main` returns `unit`, and the compiler says so

The contract is that `main` returns `unit` (every example in `docs/` and the
scaffold from `yo init` write `main :: (fn() -> unit)`); a program that
needs an exit status calls the process exit API. But the compiler does not
enforce the contract: `main :: (fn() -> i32)({ … i32(3) })` compiles today,
runs, and exits 0 — the value is silently discarded (measured 2026-09-16;
`yo-main-return-value-is-discarded-exit-code-is-always-0`). Fourteen
`issues/repros/*.yo` are written against the accepted-but-ignored form and
"self-check" into a no-op. Make the contract a diagnostic: a `main` whose
result type is not `unit` is a compile error naming the rule and pointing
at the exit API. Then fix the fourteen repros to assert or exit explicitly.
Acceptance: a cli-case for the rejection; the repros compile under the new
rule; `issues/repros` re-run through the repro gate.

## 2. P1 — `yo fix`: mechanical diagnostics repair themselves

**OUTCOME: shipped in two parts.** #724 built the repair channel and the
command, applying parse-level repairs only and saying so. #733 made evaluator
repairs apply by fixing where they were flattened — **not** where this plan and
its issue predicted; see the status table's closing section. The shortcut of
reading the §3 swallowed-cause stash was tried and REJECTED and should not be
retried: a normal evaluation swallows many internal trial failures, so its
latest entry is routinely unrelated (it offered a `std/prelude.yo`
argument-matching failure for a file whose real error was an undefined name).
The shipped fix keeps the diagnostics in LOCKSTEP with the text they replace,
written and cleared by the same two functions, for exactly that reason.

A model recovers from a compile error by re-reading the message and
editing. For diagnostics whose fix is fully determined, that round trip is
waste, and the fix is where a model most often introduces a second mistake.
`yo fix <path>` applies the repairs the compiler can already name, and
`--error-format json` carries the same repair as a structured field so an
agent can apply it without parsing prose.

Start with the four that bit this week, each already a precise parse or
check diagnostic:

| diagnostic | repair |
| --- | --- |
| E0003 adjacent different operators (the `=> a && b` case) | wrap the right-hand side in parentheses |
| "`{ … }` without semicolons is parsed as a struct literal", and the §4 one-field-record note | insert `;` after the last statement when the contents are statements; rewrite `{ x }` to `x` when the expected type is not a struct |
| E0401 name not found with a unique did-you-mean | replace the name |
| the missing-import case (name exists in exactly one std module) | add the `{ name } :: import("…")` line |

Rules: a fix is only offered when it is the unique repair; `yo fix` never
touches a line the compiler did not flag; `yo fmt` runs after. The formatter
stays a formatter (it is not a syntax gate, and must not become one).
Acceptance: each of the four has a cli-case with an `expected_tree` golden
showing the repaired file, and `yo fix` on a clean tree is a no-op.

## 3. P1 — a generic "failed to evaluate X" must not replace a real cause

**Re-scoped 2026-09-16 after reading the site: this is probably NOT a
wrapping problem, so do not implement it as one.** The case that prompted it
was, during #716, a private-member rejection inside a `match` scrutinee
surfacing only as:

```
error: Failed to evaluate the match scrutinee expression: (al._ptr)
```

Reading `src/evaluator/exprs/match.yo` (the scrutinee block): the message is
not a wrapper around an inner diagnostic at all. The scrutinee is evaluated
through `evaluate_expression(scrutinee_expr, env, ctx)` — **no `exn`
argument** — and the generic message is then raised because the result
carries no `variable_name` in its `ExprInfo`. So by the time this site runs,
the specific error has already been lost somewhere upstream: either it was
never raised on a channel this frame can see, or a def-time trial swallowed
it. A wrapper that "keeps the inner cause" has no inner cause to keep.

Therefore the first step is a DIAGNOSIS, not an edit:

1. Reproduce minimally: a `match` whose scrutinee is an expression the
   evaluator rejects (a private member access from another directory is the
   known one, now that #716 is in).
2. Find where the specific diagnostic dies — run with `YO_DEBUG_SWALLOW=1`,
   which prints swallowed evaluator errors, and compare against the raising
   site.
3. Only then decide the fix. If the error is swallowed by a trial, the fix is
   in the swallow (re-raise on the real path, as
   `function_type.yo:1541` already does for one case). If it is raised on a
   channel this frame cannot see, the fix is to give the scrutinee evaluation
   the `exn` it lacks. If it genuinely is a wrap, then and only then does the
   original plan (inner diagnostic as primary, own text as `note:`) apply.

Audit the same shape elsewhere while there: any message of the form
"Failed to evaluate the X expression" that fires on a MISSING `ExprInfo`
rather than on a caught error is the same pattern, and each one can hide a
real diagnostic. `grep -n "Failed to evaluate" src/evaluator` is the list.

## 4. Design — braces: DECIDED, keep "record unless `;`", everywhere

**Decision (maintainer, 2026-09-16, after weighing the four options below
with compatibility explicitly NOT an input):** the grammar does not change.
A brace group without a semicolon is a record — `{ x, y }`, `{ name : v }`,
`{}` and the punned one-field `{ x }` alike — and that meaning holds in every
position: value, left of `::` / `:=` / `=`, and `match` payload. The
footgun (`v => { v }` meaning a one-field record) is handled by a diagnostic
and `yo fix`, not by a grammar rule. This section records why, so the
question is not reopened.

### 4.1 What braces mean today (and will keep meaning)

`src/parser.yo` decides by separator: a semicolon-separated group is a
`begin` block; a comma-separated, colon-pair or single-element group is an
anonymous record literal desugared to `_( … )` (`BK_ANON_STRUCT`), with
`{ x }` punned to `_(x : x)`. A lone element that cannot be a field
(`{ f(x) }`) is already a parse error with the message "use semicolons".
The same `_( … )` form is what destructuring consumes on the left of a
binding (2745 lines on develop `c5f137e7a`, most of them
`{ Name } :: import(…)`), what `match` consumes as a variant payload
(`.Variant({ pos })`, ≈140 sites), and what a renaming import spells out
by hand (`_(env : dbg) :: import("std/env")`, 42 sites). On the value side:
≈800 record literals, 53 empty `{}`, and 3 sites (all `tests/rc.test.yo`)
that deliberately write `{ x }` for a one-field record.

The one ambiguous shape is therefore `{ ident }`: a one-field record by the
rule, a one-expression block by every other language's prior. Everything
else is classified by its punctuation.

### 4.2 The options weighed

| option | rule | why declined |
| --- | --- | --- |
| **B. Zig `.{ … }`** for records, bare braces always blocks, patterns dotted too (`.{ String } :: import(…)`, `.Variant(.{ pos })`) | first token classifies every group; leading dot means "structural literal, type from context" for variants and records alike | the dot is verbose exactly where Yo code is densest — imports and match payloads — and it fights the `{ k : v }` prior a model always reaches for |
| **B′. dot on the value side only**, plain braces in patterns | records read distinctly; patterns unchanged | reintroduces a position rule (the same shape means different things by position), which is the property being removed |
| **A. positional lint**: `{ ident }` is an error after `=>`, `:=`, `=`, as a body | closes the footgun with no migration | fixes a position-dependent rule by adding one |
| **C. comma decides**: `{ x }` is a block, `{ x, }` a record, `;` never needed | `{ x }` gets its universal meaning | consistency forces `{ String, } :: import(…)` on the most common line in the tree; exempting patterns is option A again |
| **S. status quo semantics** + a targeted diagnostic | one rule, one meaning per shape, in every position | — chosen |

S wins because it is the only option under which a brace group means the
same thing wherever it appears without a comma tax on patterns, and
because the remaining trap is narrower than it looks: `{ f(x) }` is already
loud, and `{ ident }` almost always meets a non-struct expected type and
fails to type-check. What is bad today is only that the resulting message
talks about records and never mentions the brace rule. The genuinely silent
case, `y := { x }` with nothing constraining `y`, is rare (three deliberate
sites) and is the language's rule working as stated.

### 4.3 What lands

1. **Diagnostic.** The parser marks a punned single-identifier record
   literal. When such a value is the cause of an E0601/E0605 mismatch, the
   diagnostic carries one extra line: *"`{ x }` is a one-field record; write
   `x` for the value or `{ x; }` for a block"*. `yo fix` (§2) applies the
   `x` rewrite when the expected type is not a struct.
2. **Cheatsheet and DESIGN wording.** State the rule as *record unless `;`,
   uniformly, so patterns and literals never disagree*, with the reason.
   `tests/sync/mutex.test.yo:76`'s warning comment becomes redundant.
3. **`_` follow-on (independent of the brace rule).** The internal
   `_( … )` call stops being user-facing syntax: the 42
   `_(env : x) :: import(…)` sites become `{ env : x } :: import(…)`, which
   already works, and `_` becomes the discard binding (today `___`, 77
   sites; `___` stays only as the compiler-reserved prefix for synthesized
   members). This is a spelling change with a byte-identical C gate, and it
   is seed-gated only in the trivial sense that std/src adopt `_` after the
   release that accepts it.

## 5. Underscore conventions after §4

`_` is the discard binding, `_name` on a member means private
(`reference/MEMBER_VISIBILITY.md`), `___name` is compiler-reserved, and
`_0`/`_1` stay positional labels — the same set of meanings as Rust and
Python for the first two.

## 6. Rejected

- **`struct(generic(T), …)` sugar for generic type declarations.** Rejected
  by the maintainer 2026-09-16. The explicit
  `(fn(comptime(T) : Type) -> comptime(Type))(struct(…))` form stays the
  one spelling; the length is the honest cost of "types are values".

## 7. Sequencing and gates

1. §1.4 first (self-contained, no measurement needed), then §1.1 — whose
   first step is a MEASUREMENT, not an edit — plus §1.2's wording change.
   The fixpoint and hollow-sweep gates are the only consumers of the old
   behaviour.
2. §1.3 `check --bodies`, measured against the #716 pre-fix commit.
3. §2 `yo fix` with the §4 diagnostic as one of its four repairs; §3's
   DIAGNOSIS (not its fix) can run any time and is independent.
4. §4.3 item 3 (`_` as the discard) on the next seed-gated release.

None of 1–3 touches `std/` source forms, so none is seed-gated. The only
seed interaction is that a std module using a form the new compiler rejects
(there are none today) would have to be fixed in the same PR.
