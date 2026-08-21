# Prefix operators bind one postfix expression — and the dot is whitespace-insensitive

**Rule 1 IMPLEMENTED 2026-08-21** (`parse_prefix_operand` /
`parse_expression` in `src/parser.yo`, on the closed-operator-set branch —
see `plans/OPERATOR_SET_AND_PRECEDENCE.md`): a bare prefix-capable
operator (`-` `!` `~` `&` `*` `?` `^`) binds one postfix expression;
parenthesized operator atoms (`(!)`) stay values; the no-whitespace `(`
form stays the operator-call path (`-(a)`, multi-arg `-(a, b)`); nested
bare prefixes chain (`**i32` = `*(*(i32))`, `- -1`). Verified by a
whole-corpus AST diff (20,757 statements — only parser.yo's own edit
differs) plus `tests/prefix_operators.test.yo`. NOTE the doc's `--`
paragraph is superseded: under the closed operator set `--` is not a
token, so even tight `3--3` splits and parses. **Rule 2 (whitespace-
insensitive dot) and the formatter spacing canonicalization remain
UNIMPLEMENTED** — their "TS is still the referee" premise predates the
P2.5 retirement, so that half needs re-planning before it lands.
**Seed constraint:** `src/` and `std/` must keep PARENTHESIZED prefix
calls until a release with this rule becomes the seed — the seed binary
rejects paren-less forms.

**Formatter prefix-CHAIN tightening (added 2026-08-21, same branch):**
the internal formatter fixture corpus caught that
`prefix_operator_needs_leading_space` still forced a space after ANY
operator — a maximal-munch-era rule ("any operator pair could merge") —
so `?*(u8)` emitted as `? *(u8)`. With the closed set, adjacency only
re-lexes differently when the concatenation is in `_is_two_char_operator`
(now exported from `src/lexer.yo` as the single source of truth), so the
rule was refined: a prefix chain drops the space (`?*i32`, `**i32`,
`?*(u8)`, `!!x`) when the PREVIOUS operator is itself in prefix position
(judged via prev_prev, because the no-space path TRIMS the buffer —
tightening after an INFIX operator would corrupt `x & *p` into `x &*p`),
EXCEPT `& &x` (`&&` is a token) and `- -1` (kept spaced: `--1` reads as a
C decrement). Fixture fallout, same commit: 15/16 migrated off the
retired `&+` (grouped-infix intent preserved with `ptr + 1`); 41/42
(`?*(u8)` tight) pass byte-identically once the chain rule fires.

Originally proposed 2026-08-09. Companion to
[`OPERATOR_ASSOCIATIVITY.md`](OPERATOR_ASSOCIATIVITY.md) (Yo's no-precedence
philosophy) and [`P1_CLI_PARITY.md`](P1_CLI_PARITY.md) §6 (the `fmt`
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
  "space before `.`" disagreements between the TS and self-hosted formatters.
  **Correction (verified 2026-08-09 by probing the TS formatter):** the
  handover doc's minimal example is wrong — TS does **not** emit `, .Some`
  with a space; it emits `,.Some` (tight). The corpus is tight `,.Some`
  (2934 vs 10 spaced) **because the TS formatter made it tight** — the
  corpus is formatter output, so "corpus majority" is circular evidence.
  Root cause: the Comma case writes `,` then `ensureSpace()` (formatter.ts:326,
  343/347), but the Dot case immediately calls
  `trimTrailingHorizontalWhitespace()` (formatter.ts:382), **eating the
  comma's space**. Same for `=` (probe: `(v : Option(i32)) =.Some(i32(5));`
  vs `= Some(i32(5))` — the identifier form keeps the space, the dot form
  loses it). The tight form is an **implementation accident**, not a design
  choice, and it fights the language's own convention: everywhere else,
  comma/operator handlers establish a space and nothing eats it.
  **Canonical form: `, .Some` (space after comma)** — the universal
  convention (`f(a, b)` in every language) and consistent with `.Some` being
  a prefix operator under Rule 1 (`f(x, -1)` has a space). Fix: make the
  Dot-case trim **conditional** in both formatters — trim before the dot
  only for member access (`str. len()` → `str.len()`, verified), but skip
  the trim when the previous meaningful token is a comma or operator, so
  their `ensureSpace()` survives (`match(x, .Some(v) => v)` stays spaced,
  `= .Some(...)` stays spaced).
- **Pre-P2 window.** The TS compiler is still the referee. After P2 retires
  `src/`, a syntax change can no longer be adjudicated differentially, so any
  grammar change must land now or in P1 (which owns the fmt differential).
- **Consistency with the ecosystem.** Go, JS, Rust, Python all accept spaced
  dots; Yo's rejection is the outlier.

## What about the lexer? (TokenType.Dot vs a plain operator)

**DECIDED 2026-08-09: keep the lexer exactly as it is — both the
dot-combining rule and the distinct `TokenType.Dot`.** Early drafts of this
plan proposed dropping `TokenType.Dot` and lexing `.` as a plain
`TokenType.Operator` with value `"."`. Rejected — for two reasons, one
mechanical and one structural:

1. **The dot-combining rule is load-bearing** (lexer.ts:27-35): `.` merges
   only with dots (`..`, `...`, `..=`, `...#`), never with `*`, `&`, `!`,
   etc. This is what keeps `x.*.*` splitting into `.` `*` `.` `*`. Counted:
   deref `a.*` appears **408× in std and 1283× in tests**; `x.*.*`
   double-deref chains 46× more. A generic operator-merging lexer (where
   `.` is just an operator char) would emit a single `.*` token and break
   every one of them. The `..=`/`...#` special cases ride on the same
   branch.

2. **`TokenType.Dot` is the reservation mechanism.** The parser's infix
   branch and the evaluator treat a lone `.` as structurally distinct from
   every user-definable operator: a 2-arg dot call is always property
   access, a 1-arg dot call is always variant construction. If `.` were a
   plain `TokenType.Operator`, a user could write
   `(.) : (fn(lhs, rhs) -> …)` and it would _parse_ — but the evaluator
   routes every 2-arg dot call to property access, so the definition would
   silently never be callable. The distinct type makes `.` non-definable by
   construction; no explicit validation needed, and no collision possible.

So the "`.` is an operator like any other" story is scoped to the **parser**
(whitespace insensitivity, Rule 2; the prefix-operand rule, Rule 1) and the
**formatter** (spacing canonicalization). The lexer keeps its special case;
the inconsistency this plan fixes was never lexical.

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
  comma). The spaced spelling `. Some(v)` is **already legal today** (verified
  2026-08-09: the prefix branch parses the operand via `parsePrimary`, which
  skips whitespace) — no change needed, it just joins the canonical
  `, .Some` spacing.

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

- **Make the Dot-case trim conditional** (formatter.ts:381-385, mirrored at
  yo-self/formatter.yo:2172): `trimTrailingHorizontalWhitespace()` before the
  dot is correct for member access (`str. len()` → `str.len()`, verified)
  but must be skipped when the previous meaningful token is a comma (or an
  operator like `=`/`:=`/`=>`) — those handlers add a space via
  `ensureSpace()` (formatter.ts:326, 343/347) that the trim currently eats,
  producing the accidental `,.Some` and `=.Some` (verified: TS emits
  `=.Some(i32(5))` but `= Some(i32(5))` for the non-dot form).
  Rule: **the dot is tight to its left operand (member access) but keeps the
  spacing the left context established (comma/operator → space)**.
- Canonical forms: `a.b` (tight — member access), `, .Some` (spaced after
  comma — prefix dot), `= .Some` (spaced after `=` — prefix dot),
  `(.Some` (tight after `(` — no space after open paren anywhere).
  Both formatters must agree; the `fmt --check` differential becomes a clean
  gate. Port identically to yo-self (it currently mirrors the TS trim, so it
  produces the same accidental tightness — verify against a built binary).
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
- Formatter: `a . b` → `a.b`; `match(x, .Some(v) => v, .None => 0)` keeps
  `, .Some` (space after comma, tight dot-to-operand); `= .Some` spaced;
  `(.Some` tight; both compilers agree

## Migration

None for the corpus: the change only _accepts_ previously-rejected input, and
`yo fmt` canonicalizes spacing. The fmt differential gate
(`scripts/bootstrap/gates_fast.sh`; see the handover §6 note) must be wired
when both formatters agree on the canonical forms (`a.b` tight,
`, .Some` / `= .Some` spaced).

## Open questions

1. **`a. b` ambiguity with float-style numeric field access** — `1 . 5` now
   parses as member access and fails at type-check. Acceptable (matches Go),
   but worth an explicit test.
2. **`- -1` (spaced double prefix)** — under Rule 1 the operand is one primary,
   so the second `-` is a fresh prefix atom: `-(-1)` parses naturally, matching
   C. Lexer merges `--` into one operator token; `- -1` (with space) is the
   spellable form. Edge case only.
3. **Formatter canonical `,.Some` vs `, .Some`** — **decided: spaced
   `, .Some`** (verified 2026-08-09). The corpus's tight form is an artifact
   of the TS formatter's Dot-case trim eating the Comma-case space; the
   universal convention is space-after-comma (`f(a, b)`), and `.Some` as a
   prefix operator (Rule 1) should get the same space as `f(x, -1)`. This
   also flips the handover doc's divergence direction: TS must stop
   trimming after commas/operators, and the self-hosted formatter (which
   mirrors the trim) must be checked against a built binary — the handover
   doc's table claims self already emits `, .Some`, so verify which side is
   actually wrong.
4. **`TokenType.Dot`** — **decided: keep it** (2026-08-09). Dropping it was
   rejected: the distinct type is the reservation mechanism that keeps `.`
   non-definable and unambiguously member-access/variant in the parser's
   infix branch. The lexer section above has the full argument; the
   implementation sketch keeps using `TokenType.Dot` as the discriminator.
5. **Where do operator names get validated?** — closed by decision 4: no
   explicit `.` reservation is needed because `TokenType.Dot` cannot be a
   user operator. (Still worth noting `..`/`..=` are user-definable trait
   operators; `.` is the only dot form that is structurally reserved.)
