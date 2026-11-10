# Brace blocks: `{ e }` is a block, `{ x, }` is the one-field record

**Status:** decided 2026-11-10 (maintainer proposal, Fable consultation #46, adopted as amended). Scheduled in
[`../handover/VBD_RELEASE_SCHEDULE.md`](../handover/VBD_RELEASE_SCHEDULE.md) §5f decision 38: a tests-only
respell rides v0.2.77, the flip is one Generation A compiler PR in v0.2.78. Moves to `plans/reference/` when the
flip lands. Supersedes `plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` §4 (the 2026-09-16 "record unless
`;`" rule), which stays frozen as a record.

## The rule

1. **Expression position.** A brace group is a **record** when it is empty, contains a comma, or its single
   element is a `label : value` pair. Otherwise it is a **block**: `{ e }` yields `e`, `{ s; e }` yields `e`, and
   `{ s; }` yields unit. The punned one-field record value is `{ x, }`, joining `(x,)` and `[a,]`.
2. **Binder position.** A brace group is always a field list, and a one-element one does **not** take the comma:
   `{ a } := s`, `{ a : alias } := s`, `{ String } :: import("std/string")`, `{ a } :: SomeModule`,
   `{ ... } :: import("m")`, `.Variant({ x })`, `.Variant({ a, b : c })`, `match(p, { x } => …)` and the capture
   list `{ y }() => …` stay exactly as written. A block cannot occur where a name is being bound, so there is
   nothing to disambiguate. A trailing comma there stays legal and is never required; the docs teach the form
   without it.
3. **`{}` is the empty record in every position; unit is `()`.** Unchanged.

"The comma makes a collection" is a rule about values: `(x)` groups and `(x,)` is a tuple; `{ x }` is a block and
`{ x, }` is a record. In a binder, `{ … }` was never a value; it is a list of field names to bind. Rust
(`let S { a } = s;`, `use m::{x};`) and JavaScript (`const { a } = s`, with `x => { a }` a block) draw the same
line.

## Every curly position

| Position | Today | After |
| --- | --- | --- |
| Value, one bare name | `{ x }` = record `_(x : x)` | `{ x }` = block yielding `x`; the record is **`{ x, }`** |
| Value, one non-field expression | `{ f(x) }` = E0007 | block yielding `f(x)` |
| Value, one borrow pun outside a capture list | `{ &y }` = record entry | block yielding `&y`; the record entry is `{ &y, }` |
| Value, one pair | `{ k : v }` = record | unchanged |
| Value, two or more | `{ a, b }`, `{ a : 1, b }` = record | unchanged |
| Value, with `;` | `{ s; e }` yields `e`; `{ e; }` yields unit | unchanged |
| Value, empty | `{}` = empty record | unchanged |
| Value, 2+ comma items with a non-field | E0007 | E0007, reworded |
| `:=` / `=` destructuring | `{ a } := s`, `{ a : x } := s` | unchanged, no comma |
| `::` module destructuring and import | `{ A } :: M`, `{ A } :: import("m")` | unchanged, no comma |
| Glob import | `{ ... } :: import("m")` | unchanged |
| `match` struct pattern | `match(p, { x } => …)` | unchanged, no comma |
| Variant curly shorthand | `.V({ x })`, `.V({ a, b : c })`, `.V({})` | unchanged, no comma |
| Closure capture list | `{ y }() => …`, `{ &y }(x) => …` | unchanged, no comma |
| Record passed as an argument | `f(a, { yield })`, `io.await(fut, { io })` | **`f(a, { yield, })`** (it is a value) |
| Bodies: `(fn(…) -> T)({ … })`, `=> { … }`, `test("n", { … })` | need a `;` to be a block | a single expression is a block too |

Effect handler sets, `impl(…)`, `struct(…)`, `enum(…)`, `where(…)` and `export(…)` use parentheses and are not
affected.

## Why

- Today no brace spelling gives a one-expression block that keeps its value: `(x : i32) = { a; };` is E0601
  ("Expected i32, Given unit"), so the current help ("write `{ a; }` for a block") and E0007's "insert `;`" repair
  both turn a value into unit.
- `v => { f(v) }` is the shape models write; the syntax instructions, the cheatsheet and `yo explain E0007` all
  carry warnings about it. After the flip those warnings are deleted, not reworded.
- The value-side cost is about ten test sites (census on develop `9e4e9956e`: zero in std and src). One-name
  imports (5,586), one-field variant shorthands (116), one-field `:=` destructurings (12) and one-entry capture
  lists (1,140) are untouched.

Rejected: the comma everywhere including binders (a token that distinguishes nothing, on the most common line in
the tree); a type-directed `{ x }` (a coercion rule); `{}` as the empty block; a deprecation window or a
`--migrate` mode (the new spelling is already seed-valid and std/src have no sites).

## Grammar

```abnf
BraceExpr   ::= Record | Block                      ;; expression position
Record      ::= '{' '}'
              | '{' Pair '}'                        ;; one `label : value`
              | '{' Field ',' '}'                   ;; one field, comma required when it is a pun
              | '{' Field (',' Field)+ ','? '}'
Block       ::= '{' Expr '}'                        ;; yields Expr
              | '{' (Expr ';')+ Expr? '}'           ;; yields the last Expr, or unit after a trailing ';'
Field       ::= Pair | Identifier | '&' Identifier | '&mut' Identifier | '...' Expr
FieldList   ::= '{' (Binder (',' Binder)* ','?)? '}' ;; binder position; a ';' here is an error
Binder      ::= Identifier | 'mut' '(' Identifier ')' | Identifier ':' Pattern | '&' Identifier | '&mut' Identifier | '...'
```

Binder positions: the left operand of `:=`, `::` and a destructuring `=`; a `match` arm's pattern and every
sub-pattern (variant payloads, tuple elements, a field's sub-pattern, the right side of `(x := p)`, the `p` of
`(p && (g))`, or-alternatives); a `for` element pattern; a closure's parameter list; the brace group heading a
closure literal. A `cond` arm's left side is an expression. Mixing `,` and `;` stays an error.

Recommended mechanism (not binding): the parser emits a one-element, separator-free group as a `begin` that
remembers it came from braces, and `desugar_if_calls` (which already walks every binder for `mut(…)`) rewrites it
to `_(x : x)` in binder positions, so evaluator pattern, destructuring and capture-list code is unchanged. An
element that cannot be a binder there (`{ f(x) } := s`) is an error naming the field-list rule.

## Diagnostics

- **E0007** remains only for a comma-separated group holding a non-field. Its "insert `;`" repair and the
  cli-case `fix-inserts-block-semicolon` are deleted; `yo explain E0007` (en + zh-CN) is rewritten.
- **The punned-record check inverts.** The "is a one-field record, but i32 is expected" error is deleted. Its
  mirror: a braces-written one-element block whose element is a bare name (or `&x` / `&mut x`) meeting a struct,
  anonymous-record or `Type.Struct` expectation reports "`{ x }` is a block that yields `x`; a one-field record is
  `{ x, }`", with a machine-applicable repair that plain `yo fix` applies. Permanent.
- **`{}` where unit is expected** keeps its error; the help says "`{}` is the empty record; the unit value is
  `()`".
- **`yo fmt`** needs no rule change; tests pin that `{ x, }` keeps its comma, `{ x }` never gains one, and
  `{x,}` normalises to `{ x, }`.

## Plan

1. **v0.2.77 rider (tests only, never a cut gate):** respell the value-side one-field records `{ x }` → `{ x, }`
   (`tests/algebraic_effects.test.yo` ×5 `{ yield }`, `tests/async/effect_bundle.test.yo` `{ io }`,
   `tests/basic.test.yo` `return({ balance })`, `tests/parameter_modes.test.yo` `{ &mut c }`,
   `tests/closure_capture_list.test.yo` `{ &y }` where it is a value). Valid under the seed and the tree today.
2. **v0.2.78 flip (one Generation A compiler PR):** parser, the binder rewrite, the two diagnostics, tests
   (`tests/internal/parser.test.yo`'s `{ x }` test becomes two), cli goldens (`check-punned-one-field-record`
   inverted and renamed, `check-struct-literal-vs-block` re-recorded, `fix-inserts-block-semicolon` deleted, the
   seven skills goldens), docs. Placed after `deref` Generation B and the `--migrate unsized` sweep, never open
   across a sweep, before the kebab rename. Tier 1 includes a census with a local never-merged binary that rejects
   every expression-position one-element group over std, src, tests, docs and the embedded programs: zero hits
   before the flip commit. The README projects are checked in v0.2.78's README stage.
3. **v0.2.79 on:** std and src may write `{ e }`. No sweep; K7's docs sweep writes the rule once.

Not forced: if the flip misses v0.2.78 it rides v0.2.79 before the `Token` retype; the release count is unchanged.

## Docs to change in the flip PR (en-US and zh-CN together)

- `.github/instructions/yo-syntax.instructions.md`: the opening "Curly braces" section becomes the three-line rule;
  the curly-shorthand and capture-list sections gain "no trailing comma for one field".
- `.github/skills/yo-syntax/SKILL.md` and its `syntax-cheatsheet.md`; `yo-core-patterns` if it shows a one-field
  record value.
- `docs/{en-US,zh-CN}/GRAMMAR.md` (`CurlyBracketExpression`), `DESIGN.md` (the brace paragraph),
  `ERROR_DIAGNOSTICS.md` (E0007).
- `AGENTS.md`: a "Design decisions" line ("Braces: `{ e }` is a block, `{ x, }` the one-field record, binders never
  take the comma") pointing at this doc once it moves to `plans/reference/`, and a "Reading historical documents"
  line ("record unless `;`" is the pre-v0.2.78 rule).
