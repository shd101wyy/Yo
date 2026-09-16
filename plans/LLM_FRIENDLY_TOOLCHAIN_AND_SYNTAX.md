# LLM-friendly toolchain and syntax: truthful results, mechanical fixes, one meaning per brace

**Status:** ACTIVE 2026-09-16 — written after a two-agent day on the tree
(member visibility #716/#717, FFI follow-ups #703, value substitution #714)
as the answer to "what would you change about Yo as an LLM-targeted
language". Nothing here is started. Two decisions are already made by the
maintainer and recorded below so nobody re-opens them: **`struct(generic(T),
…)` sugar is REJECTED**, and the brace question is decided on principle in §4 with compatibility
explicitly NOT an input ("we don't need to worry about breaking changes; make the
right decision for the future and make the syntax stable").

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
| a repro "self-checked" and exited 0 | `main` is meant to return `unit`, but the compiler accepts `-> i32` and discards the value, so the exit code is always 0 (`yo-main-return-value-is-discarded-exit-code-is-always-0`) |
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

## 4. Design — one meaning per brace, independent of position

**Maintainer's framing (2026-09-16):** migration cost and backward
compatibility are NOT inputs to this decision. The goal is the syntax Yo
should have for good, chosen once, so that it can then be held stable. The
measurements below are kept only so the execution can be scripted and
checked; they do not weigh on the choice.

### 4.1 What braces mean today

`src/parser.yo` decides by separator: a semicolon-separated group is a
`begin` block; a comma-separated or single-element group is an anonymous
record literal desugared to `_( … )` (`BK_ANON_STRUCT`), with `{ x }` punned
to `_(x : x)`. The same `_( … )` form is what destructuring consumes on the
left of `::`, `:=`, `=` (2745 lines, most of them `{ Name } :: import(…)`),
what `match` consumes as a variant payload pattern (`.Variant({ pos })`,
≈140 sites), and what a renaming import spells out by hand
(`_(env : dbg_env) :: import("std/env")`, 42 sites). On the value side there
are ≈800 record literals (`build.executable({ name : … })`), 53 empty `{}`,
and 3 sites that write `{ x }` for a one-field record.

So one token shape, `{ … }`, means three things — run statements, build a
record, take a record apart — and which one is decided by the separator
inside and by the position outside. The single-identifier case `{ x }` is
where the separator rule has nothing to go on, and it is exactly the shape a
model writes when it means a block (`v => { v }`). The fix should remove the
*rule*, not patch the case.

### 4.2 The principle to decide by

**A brace group must mean the same thing wherever it appears, and the reader
must be able to tell which thing from its first token.** Two designs satisfy
that; a third (a positional lint) does not and is dropped.

**B. Leading dot builds or unbuilds a record; bare braces run statements.**

```rust
{ a; b; c }                       // block — the only meaning of a bare brace
{ v }                             // block of one expression (legal, redundant)
.{ name : "app", root : "./src" } // record literal, type from context
.{ x, y }                         // punned record: x : x, y : y
.{}                               // empty record;  {} is an empty block
.{ String } :: import("std/string")     // destructuring — same shape as building
.{ env : dbg } :: import("std/env")     // renaming import (today's `_(env : dbg)`)
.{ ... } :: import("std/prelude")       // glob
.Variant(.{ pos }) => pos               // match payload pattern
```

Why the dot is the right marker and not an arbitrary one: Yo already uses a
leading dot for exactly this meaning. `.Some(x)` is "a variant whose enum
type comes from context", and today's `_( … )` record is "a struct value
whose nominal type comes from the expected type" (`src/evaluator/exprs/
_expr.yo` coerces `BK_ANON_STRUCT` against `ctx.expected_type`). Zig chose
`.{}` for the same reason. So after B the leading dot has ONE reading
everywhere: *structural literal, type inferred from context* — variants and
records alike — and a bare brace has ONE reading: a block. Patterns take the
dotted shape too, because a pattern is the literal it matches, written on
the other side of the binding; JavaScript and Rust both keep build and
unbuild the same shape, and that symmetry is what lets a reader (or a model)
learn one form instead of two.

Consequences, all of them simplifications:

- The internal `_( … )` call becomes what `.{ … }` desugars to and stops
  being a user-facing spelling. That frees the identifier `_`.
- The discard binding becomes `_` (today `___`, 77 sites), the spelling
  every language a model has seen uses. `___` stays only as the
  compiler-reserved prefix for synthesized members. Two of the three
  underscore conventions in §5 collapse into the universal ones.
- The parser has no separator heuristic: `.{` opens a record, `{` opens a
  block, full stop. `{ a, b }` and `{ name : v }` become hard parse errors
  with the one fix hint "a record needs a leading dot: `.{ … }`", which
  `yo fix` (§2) applies. A forgotten dot is therefore always loud and always
  repairable — that is what neutralises the JS/Rust `{ k: v }` prior a model
  will keep reaching for.
- `{}` is the empty block; the `{;}` spelling goes away.

**A′. Bare braces for everything, but a lone bare expression is never a
record.** Records need a comma or a colon (`{ x, }` for one field, like the
`[x,]` array rule), blocks need a semicolon, and `{ x }` is a parse error in
every position with a fix hint. Position-free and fully consistent with the
array rule, and it keeps the `{ k : v }` prior. Its costs are permanent
rather than one-off: `{ String, } :: import("std/string")` on the most common
line in the tree, `.Variant({ pos, })` in every payload pattern, records that
look like blocks until the reader finds the separator, and `_` still taken
by the anonymous-record call so the discard stays `___`.

**A (positional lint).** Reject `{ ident }` only after `=>`, `:=`, `=`, and
as a function body. Cheapest, but it *adds* a position-dependent rule to fix
a position-dependent rule, and it leaves `{ k : v }`, `{ x, y }` and
`{ x } := s` all sharing a shape with blocks. Dropped under the maintainer's
framing.

### 4.3 Recommendation

**B.** It is the only option under which every brace group is classified by
its first token, the leading dot ends up meaning one thing across variants,
records and patterns, blocks read the way every other language's blocks
read, and the underscore is returned to the discard role models expect. A′
is the fallback if the dotted glob import `.{ ... } :: import(…)` is judged
too strange to live with; that is the one line of B I would look at twice.

### 4.4 Execution (mechanical, not a reason to choose)

Bootstrap sequencing is a physical constraint, not a compatibility one: std
and src cannot be written in `.{` until a released compiler parses it. So:

1. Release N: parser accepts BOTH `{ … }`-record and `.{ … }`; `{ x }` bare
   single identifier already rejected in value position (so the footgun is
   closed on day one); `_` accepted as discard alongside `___`. Docs and
   cheatsheets teach only the new forms.
2. After the seed bump: a scripted rewrite of std/src/tests/docs — the three
   brace roles are syntactically classifiable, so the rewrite is a parser
   pass, not a regex — with a golden diff and the byte-identity gate on the
   emitted C (the change is spelling only).
3. Release N+1: the old forms are parse errors with the fix hint; `_( … )`
   is no longer user-writable; `___` as a discard is an error.

The rewrite and the reject step land in the same PR as their cli-cases and
the `yo fix` repair, so no green run ever depends on a form the compiler is
about to remove.

## 5. Underscore conventions after §4

With B, `_` is the discard binding, `_name` on a member means private
(`reference/MEMBER_VISIBILITY.md`), `___name` is compiler-reserved, and
`_0`/`_1` stay positional labels. That is the same set of meanings as Rust
and Python for the first two, which is the point.

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
