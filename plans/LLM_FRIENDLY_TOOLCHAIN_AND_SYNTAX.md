# LLM-friendly toolchain and syntax: truthful results, mechanical fixes, one meaning per brace

**Status:** ACTIVE 2026-09-16 — written after a two-agent day on the tree
(member visibility #716/#717, FFI follow-ups #703, value substitution #714)
as the answer to "what would you change about Yo as an LLM-targeted
language". Nothing here is started. Two decisions are already made by the
maintainer and recorded below so nobody re-opens them: **`struct(generic(T),
…)` sugar is REJECTED**, and the brace question is to be settled by a design
in §4, not by an ad-hoc parser patch.

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
| "N passed" from `yo test` | one untranspilable expression turned the whole batch into a `Failed to transpile` comment and an `abort()` stub; every test in the file ran nothing (`yo-hollow-batch-voids-every-test-in-the-file`) |
| green `check ./std` + `check ./src` | `check` is evaluator-only and never specializes generic bodies; #717 found four private-member reaches that only the suite could see (`yo-check-src-std-are-a-filter-not-a-gate`) |
| a derive rule "worked" | derive swallows the rule's own error and reports a generic message, or nothing with rc=0 (`yo-derive-swallows-a-rules-own-error`) |
| `comptime_assert` passed | it can pass vacuously when the value is never forced (`yo-comptime-assert-vacuous-testing-trap`) |
| a repro "self-checked" and exited 0 | a Yo `main` returning `i32` always exits 0; the value is discarded (`yo-main-return-value-is-discarded-exit-code-is-always-0`) |
| green build, symbol missing | `--static-library` exported nothing because two spellings of a module path were compared with `==` (`issues/fixed/static-library-exports-no-symbols.md`) |

Every one of these was eventually caught by a person who happened to look at
the C, the log tail, or the exit code. The plan below makes the toolchain
say what happened.

## 1. P0 — the toolchain never reports success for work it did not do

### 1.1 A transpile failure is a compile error

Today `src/codegen` emits a `Failed to transpile` **comment** plus an
`abort()` stub into the C when an expression cannot be lowered
(`src/codegen/constants.yo:228` names the mechanism), and the build goes on
to succeed. `scripts/count-transpile-failures.sh` exists precisely because
the compiler's own exit code does not tell you. Make it an error:

- `yo compile` / `yo build` / the `yo test` batch compile exit non-zero when
  any transpile-failure marker would be emitted, with the marker's source span
  as the diagnostic (code in the E09xx family; the classifier already has the
  substring).
- Keep the stub emission behind an explicit `--allow-hollow` for the two
  places that measure it on purpose: the hollow sweep
  (`scripts/bootstrap/hollow_sweep69.sh`) and the fixpoint gates. Nothing
  else may pass it. Delete `count-transpile-failures.sh` once no gate needs
  it.
- Acceptance: a batch with one untranspilable expression reports **that
  expression**, rc=1, and zero tests; `tests/cli-cases/` gets a case pinning
  the diagnostic; the fast suite's file count is unchanged.

### 1.2 The test runner refuses a hollow batch

Independent of 1.1 as belt and braces: after compiling a batch, the runner
scans the emitted C for the stub signature and, if present, fails the FILE
with "N tests never ran" instead of printing their names as passed. The
runner already keeps the `.c` around under `YO_KEEP_BATCH`; the scan is a
substring search. Acceptance: the same cli-case as 1.1 with `--allow-hollow`
on the compile still fails the run.

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

### 1.4 The exit code of a Yo program is its `main`'s value

`main :: (fn() -> i32)` returning non-zero must exit non-zero. Today the
value is discarded. This is a one-line fix in the generated `main` wrapper
plus a cli-case, and it removes a whole class of repros that "self-checked
into a no-op".

## 2. P1 — `yo fix`: mechanical diagnostics repair themselves

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
| "`{ … }` without semicolons is parsed as a struct literal" | insert `;` after the last statement when the contents are statements, or a trailing `,` when they are fields (see §4) |
| E0401 name not found with a unique did-you-mean | replace the name |
| the missing-import case (name exists in exactly one std module) | add the `{ name } :: import("…")` line |

Rules: a fix is only offered when it is the unique repair; `yo fix` never
touches a line the compiler did not flag; `yo fmt` runs after. The formatter
stays a formatter (it is not a syntax gate, and must not become one).
Acceptance: each of the four has a cli-case with an `expected_tree` golden
showing the repaired file, and `yo fix` on a clean tree is a no-op.

## 3. P1 — a wrapped diagnostic keeps its innermost cause

During #716 a member-visibility rejection inside a `match` scrutinee
surfaced only as "Failed to evaluate the match scrutinee expression", with
the E0405 text and span gone. The wrapping sites (`match`, `cond`, import
chains, derive) should carry the inner diagnostic as the primary and their
own text as a `note:`, the way the import chain already collapses. The
classifier then sees the real code and `yo explain` names the real rule.
Acceptance: `tests/internal/error.test.yo` gains a wrapped-cause case per
wrapping site.

## 4. Design — one meaning per brace

### 4.1 What braces mean today

`src/parser.yo` decides by separator: a semicolon-separated group is a
`begin` block; a comma-separated or single-element group is an anonymous
struct literal desugared to `_( … )` (`BK_ANON_STRUCT`), with `{ x }`
punned to `_(x : x)`. The parser rejects a single element that cannot be a
field (`{ f(x) }` errors with the "use semicolons" message). The same `_(…)`
form is what destructuring consumes on the left of `::`, `:=`, `=`, and
what `match` consumes as a variant payload pattern (`.Variant({ pos })`).

Measured on develop `c5f137e7a` (std, src, tests, build.yo):

| form | count | role |
| --- | --- | --- |
| `{ a, b } :: import(…)`, `{ a : b } :: m`, `{ x } := s` | 2745 lines | destructuring pattern (left side) |
| `.Variant({ pos })` | ≈140 | match payload pattern |
| `{ name : v, … }` in value position | ≈800 | anonymous record literal (`build.executable({ name : … })`, `stack.push({ path : …, depth : … })`) |
| `{}` in value position | 53 | empty record |
| `{ x }` in value position (single identifier, no colon, no comma) | 3, all in `tests/rc.test.yo` | the footgun: a one-field record where a one-expression block was meant |

So the ambiguity is exactly one shape, `{ ident }`, and it is written on
purpose three times in the whole tree. `tests/sync/mutex.test.yo:76` already
carries a comment warning the next reader not to write `v => { v }`.

### 4.2 Options

**A. Reject `{ ident }` in value position, keep everything else.** After
`=>`, after `:=` / `=` / `::` on the right, and as a function or closure
body, a single-identifier brace group becomes a parse error: "`{ x }` is a
one-field record; write `x` for the value or `{ x, }` for the record." The
trailing-comma spelling for a one-element literal is the rule the language
already has for arrays (`[x,]`), so it adds no concept. Patterns (left side
and match payloads) are untouched because those positions can never hold a
block. Migration: three test lines. Not seed-gated: the seed keeps parsing
the form, std/src contain no such site, and the new compiler only rejects.
`yo fix` (§2) repairs it. Cost: the language keeps one grammar rule that
depends on position.

**B. Zig's `.{ … }` for record literals; plain braces are always blocks.**
Every value-side record becomes `.{ name : v }` and `{}` becomes `.{}`; the
leading dot already means "structural literal" in `.Variant(…)`, so the
family reads consistently. Migration: ≈850 sites, and it IS seed-gated —
std/src cannot write `.{` until a release ships the parser, so it is a
two-release change (accept both, migrate after the seed bump, then reject
the old form). Patterns are the open question, answered in 4.3.

**C. Leave it.** The parse error for `{ f(x) }` already catches the
non-identifier case; the identifier case stays a trap with a comment.
Rejected: the trap is precisely the one a model walks into, because
`v => { v }` looks like every other language.

### 4.3 The destructuring side

Destructuring `{ … } :: m` is sugar for `_( … ) :: m`, and #530 made
`{ ... } :: import("m")` the glob import, so the left-side brace is now the
most common line shape in the tree. The question is whether option B should
also change it to `.{ … } :: m` for symmetry.

Recommendation: **no, in either option.** The left of `::`, `:=`, `=` and a
variant payload in a `match` pattern are positions where a block is never
legal, so a plain brace there is unambiguous — the same position-based
duality JavaScript uses for object literals and destructuring, and the one
Yo already relies on. Changing 2745 + 140 pattern sites would buy no safety,
would land on the seed gate a second time, and would make the glob import
the one place users write a dot for no reason. If B is chosen, the rule to
document is one sentence: **braces build a record with a leading dot and
take one apart without it; bare braces run statements.**

### 4.4 Recommendation

Do **A now** as part of the `yo fix` work, since it is the whole footgun at
the cost of three lines, and record B as available if the maintainer wants
the value side to read like Zig. If B is wanted, it should ride the same
release as the next seed-gated syntax change rather than get its own, and
its migration should be a scripted rewrite with a golden diff, not a hand
edit of 850 sites.

The maintainer's question to answer: **A only, or A now and B later?**

## 5. Note — three underscore conventions

`_name` is now enforced private (members), `___` is the discard binding and
the compiler-reserved prefix for synthesized members, and `_0` / `_1` are
positional labels. They do not collide in the grammar, but they are three
things a reader has to know about one character. No action proposed beyond
saying so in the cheatsheet; if `___` as a discard ever changes, the
`syntax-cheatsheet.md` entry "`___` discard variable cannot appear twice"
is where the decision goes.

## 6. Rejected

- **`struct(generic(T), …)` sugar for generic type declarations.** Rejected
  by the maintainer 2026-09-16. The explicit
  `(fn(comptime(T) : Type) -> comptime(Type))(struct(…))` form stays the
  one spelling; the length is the honest cost of "types are values".

## 7. Sequencing and gates

1. §1.1 + §1.2 + §1.4 together (they share the cli-case fixture); land
   behind the fixpoint and hollow-sweep gates, which are the only consumers
   of the old behaviour.
2. §1.3 `check --bodies`, measured against the #716 pre-fix commit.
3. §2 `yo fix` with §4 option A as one of its four repairs; §3 in the same
   PR or the next.
4. §4 option B only on an explicit go, on the next seed-gated release.

None of 1–3 touches `std/` source forms, so none is seed-gated. The only
seed interaction is that a std module using a form the new compiler rejects
(there are none today) would have to be fixed in the same PR.
