# Prefix operators bind one postfix expression — and the dot is whitespace-insensitive

**Proposed 2026-08-09.** Design decision, not yet implemented. Companion to
[`OPERATOR_ASSOCIATIVITY.md`](OPERATOR_ASSOCIATIVITY.md) (Yo's no-precedence
philosophy) and [`PRE_P1_HANDOVER.md`](PRE_P1_HANDOVER.md) §6 (the `fmt`
divergence, whose "space before `.`" class this rule resolves).

## TL;DR

Two rules, one principle — _the dot must stop being a special case_:

1. **Prefix operators bind exactly one postfix expression** (a primary plus its
   calls / dot-chains / brackets). They never extend over an infix chain.
2. **Whitespace around the member-access dot is insignificant** (Go/JS model):
   `a.b ≡ a . b ≡ a. b ≡ a .b`. The prefix dot already tolerates whitespace.

Together they make `.` behave like every other operator: a prefix form
(`.Circle` ≡ `. Circle`) and an infix form (`a.b` ≡ `a . b`), both with
whitespace-insensitive spelling — and they unify `.` with the ordinary unary
operators (`-`, `!`, `&`, `~`) so that `-1 + 2 = (-1) + 2` follows the same
rule, no precedence table required.

## Rule 1 — prefix operator operand width

A prefix operator's operand is exactly **one postfix expression**: one primary
(atom, literal, paren group, call, bracket access, or dot-chain). After the
operand, any binary operator applies to the result. This is the rule C, Rust,
Python, Java, and JS use — it is stated here as an operand-width rule, not as
operator ranking, so Yo's no-precedence philosophy is untouched.

```rust
-1 + 2        // ⇒ (-1) + 2          — the `-` binds the primary `1`, then `+` applies
-(1 + 2)      // ⇒ explicit wide operand
-f(x)         // ⇒ -(f(x))           — a call is one postfix expression
.Circle(1, 2) // ⇒ (.Circle)(1, 2)   — dot binds `Circle`, then `(1, 2)` is a call
.(Circle)(1, 2) // ≡ .Circle(1, 2)   — parens around a single primary are a no-op
```

### The ambiguity question

`-1 + 2` could in principle be `-(1 + 2)` or `-(1) + 2`. Rule 1 eliminates this
**by grammar, not by precedence**: the operand cannot contain an infix operator
unless parenthesized, so `-1` is complete before `+` is ever seen. No operator
ranking is introduced; `-1 + 2 - 3` still requires parens (two _binary_
operators, adjacent and different — the `OPERATOR_ASSOCIATIVITY.md` rule is
unchanged). An operator at expression start has no left operand, so it cannot
be binary; only its operand width was open, and this rule pins it.

### Current state (verified 2026-08-09)

| form              | parses today? | notes                                          |
| ----------------- | ------------- | ---------------------------------------------- |
| `-(1)`            | yes           | operator-call syntax                           |
| `-1`, `(-12)`     | **no**        | paren-less operator calls are banned wholesale |
| `.Circle(1, 2)`   | yes           | dot binds one primary (the existing precedent) |
| `.(Circle)(1, 2)` | yes           | identical AST to `.Circle(1, 2)`               |
| `. Circle(12)`    | yes           | prefix parsePrimary already skips whitespace   |

The `-(1)` paren requirement is **not** forced by ambiguity — it is a parser
gap: the dot got the "consume the next postfix expression" treatment
(parser.ts:995-996, "`.` is the special case here which has the highest
operator precedence") and the other operators did not. 222 `-(N)` spellings
in the corpus (incl. `-(2147483648)` for i32 min) show the demand; nobody wants
those parens.

## Rule 2 — the dot is whitespace-insensitive

Whitespace around the dot carries no meaning, exactly as in Go, JS, Rust, and
Python:

```rust
a.b          // member access
a .b         // same
a. b         // same — already works today via the infix branch, same AST
a . b        // same — today: parse error
.Circle      // prefix variant construction
. Circle     // same — already works today
(a . len)()  // ≡ a.len()
```

### Current state (verified 2026-08-09)

The dot is the **only whitespace-sensitive token in the language**, and the
rule is asymmetric and incoherent:

- `a.b` — member access (dot branch, parser.ts:1016-1023)
- `a. b` — parses via the _infix_ branch (parser.ts:1071-1073), producing the
  **identical** 2-arg `FnCall{func: ".", args: [a, b]}` AST
- `a .b`, `a . b` — **parse error** ("Paren-less function and operator calls")

Since a lone `.` can never be a user-defined operator (the lexer reserves it;
only `..`, `...`, `..=`, `...#` are lexed as operator tokens), there is no
infix-dot meaning to disambiguate against: the whitespace rejection buys
nothing and only makes `yo fmt` dangerous (reflowing `a . b` to `a.b` silently
changes a parse error into a program, and vice versa). Compare
`OPERATOR_ASSOCIATIVITY.md`: newline-based associativity was removed for
exactly this reason.

## Why now

- **Purely additive.** Every spaced form is a parse error today; no valid
  program changes meaning.
- **Kills a formatter divergence class.** The handover doc (§6) counts ~310
  "space before `.`" disagreements between the TS and self-hosted formatters
  (e.g. `match(l.get(i),.Some(__e) => __e,...)` vs
  `match(l.get(i), .Some(__e) => ...)`). With whitespace insignificant, the
  canonical form is unambiguous — **tight**: `a.b`, `.Circle`, `,.Some` after
  commas. Both formatters must emit tight dots; the `fmt --check` differential
  becomes a clean gate.
- **Pre-P2 window.** The TS compiler is still the referee. After P2 retires
  `src/`, a syntax change can no longer be adjudicated differentially, so any
  grammar change must land now or in P1 (which owns the fmt differential).
- **Consistency with the ecosystem.** Go, JS, Rust, Python all accept spaced
  dots; Yo's rejection is the outlier.

## What about the lexer? (TokenType.Dot vs a plain operator)

Three separable parts, only one of which changes:

1. **`TokenType.Dot` → drop it; lex `.` as a plain `TokenType.Operator` with
   value `"."`.** The evaluator already checks _values_ everywhere
   (`exprIsFunctionCallOf(expr, ".")`), never the type, so the special token
   type buys nothing today. ~15 sites flip from `token.type === TokenType.Dot`
   to `token.value === "."` (parser.ts:801/999/1006/1019/1045/1073/898/1087,
   formatter.ts:381/1000/1005/1046/1245, expr.ts:1369/1465, flowability.ts:358,
   lsp/signature-help.ts:146). This completes the "`.` is an operator like any
   other" story at the token level.

2. **The lexer dot-combining rule STAYS** (lexer.ts:27-35): `.` merges only
   with dots (`..`, `...`, `..=`, `...#`), never with `*`, `&`, `!`, etc.
   This is load-bearing: `p.*` (deref, tests/comptime.test.yo:3082,
   std/alg/hash.yo:17) and `x.*.*` depend on the split `.` `*` `.` `*`; a
   generic operator-merging lexer would emit a single `.*` token and break
   deref. The `..=`/`...#` special cases ride on the same branch — keep it.

3. **Reserve `.` as non-definable.** Once `.` is a plain operator token, a
   user could write `(.) : (fn(lhs, rhs) -> …)` and it would _parse_ — but the
   evaluator routes every 2-arg dot call to property access, so such a
   definition would silently never be callable. Today `TokenType.Dot`
   prevents the definition implicitly; with the type gone, add an explicit
   rejection of operator definitions named `.` (alongside whatever currently
   reserves `..`/`..=` — check how trait operator names are validated).

## Preserved invariants (must NOT change)

- **Dot binds tightest.** `a.b + c` = `(a.b) + c`; the member-access branch
  stays at the top of `parsePrimaryEnd`, above the infix branch. The
  "highest precedence" comment (parser.ts:995-996) stays true.
- **Lexer dot-combining.** `.` still combines only with dots: `..`, `...`,
  `..=`, `...#` remain single operator tokens; `x.*.*` still splits into
  `.` `*` `.` `*`.
- **Float literals.** `1.5` lexes as a Float (digit-dot-digit, no space).
  `1 . 5` becomes member access `(1).5` → a type error, which matches Go's
  parse error and is acceptable.
- **Tight deref forms.** `ptr.*(x)`, `ptr.&(x)` keep working; the spaced
  spellings become legal by the same rule.
- **Match arms.** `match(x, .Some(v) => v)` is unaffected (prefix dot after a
  comma); `. Some(v)` also becomes legal.

## Implementation sketch

### Parser (`src/parser.ts`, then `yo-self/parser.yo`)

1. **Member-access condition** (parser.ts:1016-1023): drop the four whitespace
   conjuncts — any `token.type === TokenType.Dot` after a complete primary is
   member access (still checked after the `primaryExprIsDotOperator` prefix
   case).
2. **`isDotAtLineStart`** (parser.ts:1005-1015): becomes redundant → remove.
3. **Infix-branch Dot case** (parser.ts:1071-1073): dead once (1) lands →
   remove; the infix branch then only handles `TokenType.Operator`.
4. **Prefix case** (parser.ts:801): no change — `parsePrimary` already skips
   whitespace before the operand.
5. **Prefix operators `-`/`!`/`&`/`~`** (Rule 1, separate step): when the
   parsed primary is an operator atom at expression-start position, consume
   the next postfix expression as its single operand (mirror the dot's
   branch), instead of raising the paren-less-call error (parser.ts:1220-1237).

### Formatter (both)

- Keep the tight-dot emission (TS already: `trimTrailingHorizontalWhitespace()`
  then `write(".")`, formatter.ts:381-385; `isTightlyBoundOperator`'s
  "after a dot, always tight" rule, formatter.ts:1244-1247).
- Make TS emit **tight** in the cases it currently preserves spaced
  (`, .Some` → `,.Some`), and port identically to yo-self — this is the
  concrete fix for the 315-file divergence.
- New: tight emission for prefix operators when they take a bare primary
  (`-1`, `!x`, `&x`), mirroring the existing `!(x)` tightness.

### Evaluator

No changes. Prefix dot (1-arg) is enum variant access; member dot (2-arg) is
property access. `a. b` already produces the identical 2-arg FnCall AST today
(verified), and `.(Circle)` ≡ `.Circle` (verified). The `-1` vs `-(1)` question
is pure syntax: both must produce `FnCall{func: -, args: [1], isInfix: false}`.

### LSP

`src/lsp/completion.ts` dot-completion triggers on `textUpToCursor.endsWith(".")`
— `a .` (spaced) should also trigger. Minor follow-up, not a blocker.

## Tests

Add to `tests/` (mirror in `tests/internal/` for the self-hosted compiler):

- `a.b`, `a .b`, `a. b`, `a . b` → identical member access; `(a . len)()`
  method call
- `.Circle`, `. Circle` → identical construction; `.(Circle)(1, 2)` ≡
  `.Circle(1, 2)`
- `-1 + 2` ⇒ `(-1) + 2`; `-(1 + 2)` explicit (after Rule 1 lands for `-`)
- `..`, `..=`, `1.5`, `x.*`, `match(x, .Some(v) => v)` unaffected
- Formatter: emits tight dot/dash from spaced input, both compilers

## Migration

None for the corpus: the change only _accepts_ previously-rejected input, and
`yo fmt` canonicalizes spacing. The fmt differential gate
(`scripts/bootstrap/gates_fast.sh`; see the handover §6 note) must be wired
when both formatters emit tight dots.

## Open questions

1. **`a. b` ambiguity with float-style numeric field access** — `1 . 5` now
   parses as member access and fails at type-check. Acceptable (matches Go),
   but worth an explicit test.
2. **`- -1` (spaced double prefix)** — under Rule 1 the operand is one primary,
   so the second `-` is a fresh prefix atom: `-(-1)` parses naturally, matching
   C. Lexer merges `--` into one operator token; `- -1` (with space) is the
   spellable form. Edge case only.
3. **Formatter canonical `,.Some` vs `, .Some`** — recommended: tight
   (`,.Some`), matching the existing corpus majority; the two formatters must
   simply agree, whichever is chosen.
4. **Is `TokenType.Dot` worth dropping?** — the flip side of the lexer section
   above: it touches ~15 sites for a conceptual win, and the evaluator already
   treats dot by value, so nothing breaks. Decide as part of this change (it
   belongs in the same PR); if skipped, the parser changes in the
   implementation sketch must keep using `TokenType.Dot` as their discriminator.
5. **Where do operator names get validated?** — for the `.` reservation, find
   where trait operator names (e.g. `(..)`) are accepted and reject `.` there
   (or confirm `TokenType.Dot`-based rejection already covers it pre-change).
