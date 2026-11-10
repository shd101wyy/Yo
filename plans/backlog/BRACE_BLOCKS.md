# Brace groups: `.{ … }` builds a record, `{ names }` on a binding side picks fields, every other `{ … }` is a block

**Status:** decided 2026-11-10 (maintainer proposals; Fable consultations #46 and #47, #47 adopted). Not started.
Placed **after the VBD campaign** by the maintainer (2026-11-10): post-VBD plan
([`POST_VBD_PLAN.md`](POST_VBD_PLAN.md)) phase 1, lane A, Generation A in v0.2.81 and Generation B in v0.2.82,
ahead of K7's docs sweep. Until Generation B lands the tree keeps today's rule ("a brace group is a record unless
it has a `;`"). Moves to `plans/reference/` when Generation B lands. Supersedes
`plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` §4 (the 2026-09-16 rule), which stays frozen as a record, and
the first version of this doc (#1869, consultation #46's comma rule, never shipped).

## The rule

The whole rule, for the cheatsheet: **`.{ … }` builds a record; `{ names }` on a binding side picks fields; every
other `{ … }` is a block.**

1. **A record value is `.{ … }`, always.** `.{ x : 1, y : 2 }`, `.{ x, y }` (puns), `.{ x }` (one field, no comma
   needed), `.{}` (empty record), `.{ &y }`, `.{ ...base, x : 1 }`. Fields are spelled exactly as today. With an
   expected struct type it is that type's value, as `.Some(x)` is the expected enum's; with none it is an
   anonymous record. A leading dot already means "the type comes from context" (`.None`, `.Some(x)`).
2. **A bare `{ … }` in expression position is always a block.** `{ e }` yields `e`, `{ s; e }` yields `e`,
   `{ s; }` yields unit, and **`{}` is the empty block (unit)**. A comma or a `label : value` pair directly inside
   a bare expression brace is an error whose repair is the dot.
3. **Binder positions keep bare braces: a field list, no dot, no comma for one element.** `{ a } := s`,
   `{ a : alias } = s`, `{ String } :: import("std/string")`, `{ ... } :: import("m")`,
   `match(p, { x, y } => …)`, the variant patterns `.V({ x })`, `.V({ a, b : c })`, `.V({})`, and the closure capture list
   `{ y }(p) => …`, `{ &y, k : v }() => …`, `{}() => …` (VERDICTS-44 stands). A dot there is an error whose repair
   removes it.
4. **`(a, b)` stays the only tuple spelling.** `.{ 1, 2 }` is an error naming `(1, 2)`; Zig's tuple reading is not
   adopted.
5. **`Point(x : 1, y : 2)` stays the constructor of a named struct** and the form the docs teach for one. `.{ … }`
   is for anonymous records and for slots whose type the context supplies (options records, effect records, a
   typed element slot).

## Every curly position

| Position | Today | After |
| --- | --- | --- |
| Value, record with 2+ fields | `{ a, b }`, `{ a : 1, b }` | `.{ a, b }`, `.{ a : 1, b }` |
| Value, one pair | `{ k : v }` | `.{ k : v }` |
| Value, one punned field | `{ x }` | `.{ x }` |
| Value, borrow pun as a record entry | `{ &y }` | `.{ &y }` |
| Value, empty record | `{}` | `.{}` |
| Value, `{}` | empty record | empty block, yields unit |
| Value, `{ e }` (non-field expression) | E0007 | block yielding `e` |
| Value, `{ s; e }` / `{ s; }` | block | unchanged |
| Value, bare brace with a comma or a pair | record | E0007, repair: insert `.` |
| Record argument (effect/implicit records) | `io.await(fut, { io, exn })` | `io.await(fut, .{ io, exn })` |
| Build options | `build.executable({ name : "n", root : "r" })` | `build.executable(.{ name : "n", root : "r" })` |
| Module-level record constant | `Platform :: { Linux : "linux", … }` | `Platform :: .{ Linux : "linux", … }` |
| Record nested in a record | `{ inner : { x : 1 } }` | `.{ inner : .{ x : 1 } }` |
| Named struct | `Point(x : 1, y : 2)` | unchanged |
| Tuple | `(a, b)`, `(x,)` | unchanged |
| `:=` / `=` destructuring | `{ a } := s`, `{ a : x, mut(b) } := s` | unchanged |
| `::` module destructuring, import, glob | `{ A } :: M`, `{ A } :: import("m")`, `{ ... } :: import("m")` | unchanged |
| `match` struct pattern and sub-patterns | `match(p, { x : 0, y } => …)` | unchanged |
| Variant curly shorthand in a pattern | `match(e, .V({ x }) => …)`, `.V({ a : 1, b })`, `.V({})` | unchanged |
| Variant value with a named-field payload `V(a : i32, b : i32)` | `.V(a : 1, b : 2)`; `.V({ a : 1, b : 2 })` is E0601 | unchanged (`.V({ a : 1, b : 2 })` becomes a parse error naming the dot) |
| Variant value with one struct payload `V(p : Point)` | `.V({ x : 1, y : 2 })` | `.V(.{ x : 1, y : 2 })` (the braces are a record value; migrated) |
| Closure capture list | `{ y }() => …`, `{ &y, k : v }(x) => …`, `{}() => …` | unchanged (a binder) |
| Bodies | `(fn(…) -> T)({ … })`, `=> { … }`, `test("n", { … })` | unchanged; `{}` is a valid empty body |
| `${x}` in a template string, `asm` `{name}` placeholders | not brace groups | unchanged |

## Why

Census on develop `f422cb0a7` (`.yo` files): 52,527 blocks, about 192 record values (std 9, src 14, tests 169, of
which 124 are build-option fixtures), about 11,900 binder groups (8,416 imports/module destructurings, 1,977
capture lists, 1,417 patterns, 28 `:=` destructurings).

1. Record values are about 0.4% of expression braces. Content-classifying every expression brace (the first version
   of this doc: a record when empty, with a comma, or a lone pair) adds three exceptions (`{ x, }`, `{}`, a lone
   `{ k : v }`) to keep those ~190 sites unmarked. One explicit marker on the rare case is simpler.
2. Every mistake becomes a deterministic parse error with a one-character `yo fix` repair. Under the comma rule
   `y := { x }` was silently a block.
3. `{}` gets its universal meaning (the empty block), and `.{}` gives the empty record a spelling.
4. It matches `.Some(x)`: the dot means the type comes from context. Brace literals already coerce to an expected
   named struct (probed on seed v0.2.76).
5. Binder positions were already separated from expressions by consultation #46, so the 2026-09-16 objection to a
   marked record value no longer applies.
6. "A literal is a valid pattern" already fails today (for `V(a : i32, b : i32)`, `.V({ a : 1, b : 2 })` as a value
   is E0601 while `.V({ a, b })` is the preferred pattern), so keeping binders bare loses nothing that holds now.

Rejected: the dot in binders too (`.{ a } := s`, `.V(.{ x })`, `.{ String } :: import(…)` on 8,400 import lines,
for no information); the comma rule (consultation #46; more exceptions, a silent `y := { x }`); `.{ 1, 2 }` as a
tuple.

## Grammar

```abnf
Record      ::= '.{' (Field (',' Field)* ','?)? '}'  ;; expression position only; '.' and '{' adjacent
Field       ::= Identifier ':' Expr | Identifier | '&' Identifier | '&mut' Identifier | '...' Expr
Block       ::= '{' '}'                              ;; unit
              | '{' Expr '}'                         ;; yields Expr
              | '{' (Expr ';')+ Expr? '}'            ;; yields the last Expr, or unit after a trailing ';'
FieldList   ::= '{' (Binder (',' Binder)* ','?)? '}' ;; binder position only
Binder      ::= Identifier | 'mut' '(' Identifier ')' | Identifier ':' Pattern | '&' Identifier | '&mut' Identifier | '...'
```

- **Binder positions:** the left operand of `:=`, `::` and a destructuring `=`; a `match` arm's pattern and every
  sub-pattern; a `for` element pattern; a closure's parameter list; the brace group heading a closure literal. A
  `cond` arm's left side is an expression.
- **Lexing.** No new token: the seed already parses `.{ … }` as the prefix dot applied to a brace group. `.{` can
  only start an operand (Yo has no juxtaposition application); `x.{ … }` after an operand stays an error and does
  not collide with `x.*`, `x.(e)` or `x.name`. `yo fmt` writes `.{ a, b }` and `.{}` with no space after the dot.
- **Mechanism (recommended, not binding).** The parser builds a bare brace group as one node recording its
  separator; `desugar_if_calls` rewrites it to `_(…)` in binder positions, so pattern, destructuring and
  capture-list evaluation is unchanged. In expression position a `,`-separated group or a lone pair is E0007;
  everything else is `begin`. `.{ … }` goes straight to `_(…)`. `_is_punned_single_field` and the `{}`-vs-unit
  check are deleted.

## Diagnostics

| A model writes | It is told | Repair |
| --- | --- | --- |
| `{ a, b }`, `{ k : v }`, `{ a : 1, b }` as a value | E0007: "`{ … }` is a block, and a block separates statements with `;`. A record literal is written `.{ a, b }`" | insert `.` (plain `yo fix`) |
| `{ x }` where a struct / anonymous record / `Type.Struct` is expected | E0601 plus "`{ x }` is a block that yields `x`; the one-field record is `.{ x }`" | insert `.` (plain `yo fix`) |
| `{ a; b, c }` | E0007: mixing `,` and `;` | none |
| `.{ a } := s`, `.{ A } :: import(…)`, `.V(.{ x })` in a pattern, `.{ y }() => …`, a `.{ … }` pattern | "a field list on the binding side is written without the dot: `{ a }`. `.{ … }` builds a record value" | delete `.` (plain `yo fix`) |
| `.{ .x = 1 }` (Zig) or `.{ x = 1 }` | "a record field is `x : 1`" | rewrite when every field has that shape |
| `.{ 1, 2 }`, `.{ f(x) }` | "a record's fields are named; a tuple is `(1, 2)`" | none |
| `.{ a; b }` | "`.{ … }` is a record; a block has no dot" | delete `.` |
| `{}` where a record is expected | E0601 plus "`{}` is the empty block (unit); the empty record is `.{}`" | insert `.` |

## The work (after VBD)

Two PRs separated by one seed bump, because std, src and the repository's `build.yo` are compiled by the seed.

1. **Generation A (compiler only).** The parser accepts `.{ … }` as a record value beside today's bare form;
   `yo fmt` lays it out; `yo fix <path> --migrate record-literal` rewrites every expression-position brace group
   that parses as a record today (including the punned `{ x }` and the value `{}`) to `.{ … }` and touches no
   binder. Tests: parser cases for each row of the position table; a cli-case for the migration with an
   `expected_tree`. Nothing else changes meaning.
2. **Generation B (after `SEED_VERSION` carries 1).** Run the migration over `std src tests docs build.yo`, the
   `yo init` template, the skills and instruction files and the programs embedded in test strings and workflow
   files; then flip (a bare expression brace is a block, `{}` is the unit block, the diagnostics above, the
   deletions). Re-record the goldens (`check-punned-one-field-record` and `check-struct-literal-vs-block`
   rewritten, `fix-inserts-block-semicolon` deleted, the skills and `init*` goldens). Tier 1 includes a census with
   the tree binary: zero expression-position record-shaped bare groups before the flip commit. The README projects
   run the migration in that release's README stage. The migration mode retires one release after its last
   in-tree use.
3. **Docs (in PR 2, en-US and zh-CN together).** This doc moves to `plans/reference/`; `yo-syntax.instructions.md`'s
   opening section becomes the one-line rule plus the table; the `yo-syntax` skill and cheatsheet; `GRAMMAR.md`,
   `DESIGN.md`, `ERROR_DIAGNOSTICS.md`; the build-system docs; `AGENTS.md` gets a "Design decisions" line and a
   "Reading historical documents" line ("a bare `{ a, b }` value is the pre-flip spelling of `.{ a, b }`; `{}` was
   the empty record").

Scale: about 190 `.yo` record sites and about 60 doc sites; no import, pattern, destructuring or capture list
changes.
