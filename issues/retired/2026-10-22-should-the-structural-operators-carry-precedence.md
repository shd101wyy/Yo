# Should the structural operators (= := :: : => ->) carry precedence?

**Kind:** design question (decided; the grammar is unchanged, and the
diagnostic mitigation landed in the same PR).

**Status:** DECIDED 2026-10-22: keep no precedence for any operator (the
maintainer's verdict below). Filed 2026-10-22, raised mid-VALUES_BY_DEFAULT
by the maintainer: with macros being deleted
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md`), should the non-arithmetic
operators get precedence levels while the arithmetic/comparison/logic/bitwise
set stays precedence-free — so `(x : i32) = ((a + b) - c);` could be written
`x : i32 = (a + b) - c;`?

## Verdict (maintainer, 2026-10-22)

**Keep no precedence, for any operator.** The current rule is the most
explicit form possible — grouping is verifiable by local inspection with no
prior knowledge — and the single sentence ("same-operator chains
left-associate; adjacent different operators need parentheses") is an asset an
LLM carries whole, unlike any table. The friction it costs is one compile
roundtrip with an obvious fix, and the 2026-09-19 authoring audit's own data
says syntax is not where models fail in Yo (parser: 7 of 218 open issues).
Mitigation shipped instead: E0003 now names the canonical grouping where the
mix has exactly one mainstream reading (the change that files this doc), so
the roundtrip is a copy-paste rather than a decision.

## What the audit found (2026-10-22)

- The grammar has **one enforcement point**: `parse_primary_end`'s infix
  branch (`src/parser.yo`). Files are expression lists; `::`, `:=`, `=`, `:`,
  `?=` and the arrows `->` and `=>` are ordinary infix `FnCall` nodes —
  there is no separate statement/arm/lambda grammar to hook a "declaration
  precedence" into. Any tier system is a change at that one branch (plus a
  rotation case: greedy full-expression RHS parsing means `a <= b => v`
  arrives with the arrow inside the comparison's right operand and must be
  regrouped).
- The forced-paren population is real and large: ~13.8k `name : (fn(...)->...)`
  annotation groups, ~5.3k `Name :: (fn...)` aliases, ~2.1k parenthesized
  annotated lambda params across `src/`, `std/`, `tests/` — but these count
  CONFORMANCE, not pain: the corpus is stable, and fmt canonicalizes the
  groups.
- The maintainer's sketch (`.` > `=> ->` > `= := :: :`) does not parse its own
  example: `x : i32 = e` needs `:` to close before `=`, so `:` cannot share
  the binding tier; and the two biggest populations force `->` ABOVE `:`
  (fn-type annotations) while `:` sits ABOVE `=>` (annotated lambda params) —
  the arrows land in different tiers. The corrected lattice, worked out in
  full, is: computational (no internal precedence) > `->` > `:` > `=>` >
  `= := :: ?=`, with same-tier different-token mixes staying errors.

## Recommendation

Adopted position: **no change to the grammar.** The corrected lattice above is
recorded so a future revisit does not re-derive it; if measured agentic
roundtrip data ever shows precedence-paren errors are a meaningful fraction of
compile roundtrips (the revisit trigger
`plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` Part 2 pre-registered), that
lattice — never a full C-style table — is the shape to adopt, landed outside
an active migration campaign (it re-canonicalizes every file, like the
decision-42 spelling flip).

What DID land (this PR): the E0003 diagnostic names the canonical grouping
for the pairs that have exactly one, and stays silent on every other pair —

```yo ignore
x := 1 + 2;
// Adjacent different operators need parentheses to clarify grouping (near :=).
// Wrap the right-hand side in parentheses: name := (1 + 2).
```

The hint is diagnostic text only: the grammar, and the explicitness it buys,
are untouched. The table below is the whole classification.

## What the hint says, pair by pair

How the parser meets a mix: the right operand of an infix operator is parsed
greedily as a full expression, and the operand is checked before the
operator that owns it, so the RIGHTMOST mismatched pair throws first. The
error is reported at the LEFT operator of that pair ("near" it), and the
other operator is the root of its right operand — the next infix operator to
the right. `x : fn() -> void = f` therefore fails at `->` against `=` before
`:` is ever looked at. "Computational" is every infix operator not named in
the lattice (arithmetic, comparison, `&&`, `||`, bitwise, `<:`, `..`, `..=`,
`==>`). The lattice's `=>>` twin is not a lexer token (`=>>` lexes as `=>`
`>`, so `a => b =>> c` is an E0008 before any grouping question), so the
table has no `=>>` rows.

`->` is read two ways, by its left operand: after a `fn(`, `unsafe_fn(`,
`ctl(`, `Fn(` or `FnOnce(` head it is the fn-type arrow, after anything else
it is a lambda arrow (`err -> {...}`, `(self : Self) -> {...}`). The table
splits the `->` rows on that.

A pair gets a hint only when its lattice grouping is a Yo form AND is the
only reading an author means; a pair where those disagree, or where neither
grouping is a form, gets none. `src/parser.yo`'s `e0003_grouping_hint`
implements exactly this table; `tests/internal/parser.test.yo` asserts one
case of every hint sentence and of the hint-free pairs a reviewer could
expect a hint for (the exact sentences).

| Left operator | Next operator | Rejected example | Canonical grouping | Hint |
| --- | --- | --- | --- | --- |
| `=` `:=` `::` `?=` | `=>`, `->`, computational | `x := 1 + 2`, `f := x => x`, `F :: fn() -> T`, `h := err -> {...}` | right | `Wrap the right-hand side in parentheses: name := (1 + 2).` |
| `=` `:=` `::` `?=` | `:` | `x := y : i32` | not unique: the lattice's `x := (y : i32)` compiles, but a parenthesized `y : i32` DECLARES `y` (the value is unit), it does not ascribe a type to `y` | none |
| `=` `:=` `::` `?=` | a different binding | `x := y = 5` | none: one tier | none |
| `=>` | `->`, computational | `c => a + b`, `c => fn() -> T` | right | `Wrap the right-hand side in parentheses: left => (a + b).` |
| `=>` | `:` | `c => y : i32` | not unique, as for a binding then `:` | none |
| `=>` | a binding | `c => x = 5` | not unique: the lattice says `(c => x) = 5`, never a program; an author means the arm body `c => (x = 5)` | none |
| `:` | computational | `Foo(x : a + b)` (a named argument) | right | `Wrap the right-hand side in parentheses: name : (a + b).` |
| `:` | fn-type `->` | `name : fn() -> T` | right | `Wrap the right-hand side in parentheses: name : (fn() -> T).` |
| `:` | lambda `->` | `self : Self -> {...}` | left: the annotated lambda parameter `(self : Self) -> {...}` (9 sites in the tree) | `Parenthesize the annotated parameter: (name : Type) -> body.` |
| `:` | `=` `?=` | `x : i32 = 5`, `x : T ?= d` | left | `Parenthesize the annotated binding: (name : Type) = value.` |
| `:` | `=>` | `x : i32 => x` | left (~2.1k annotated lambda/arm parameters in the tree; one exception below) | `Parenthesize the annotated parameter: (name : Type) => body.` |
| `:` | `:=` `::` | `x : i32 := 5` | none: `(x : i32) := 5` is rejected by the evaluator (an annotated binding takes `=`), `x : (i32 := 5)` is no annotation | none |
| fn-type `->` | computational | `fn() -> a + b` | right | `Wrap the right-hand side in parentheses: fn(...) -> (a + b).` |
| fn-type `->` | `:` | `fn() -> r : i32` | right: the labeled return `-> (r : T)` (228 sites in the tree, none of `(… -> T) : …`); the lattice's `->` over `:` holds only with `:` on the LEFT | `Wrap the right-hand side in parentheses: fn(...) -> (r : i32).` |
| fn-type `->` | `=` `?=` | `x : fn() -> void = f` | left: `(fn() -> void) = f`, the first step towards `(x : (fn() -> void)) = f` | `Parenthesize the function type: (fn(...) -> T) = value.` |
| fn-type `->` | `=>` | `f : fn() -> void => f()` | left: the fn type closes first, as in `(k : Impl(Fn() -> i32)) => k()` | `Parenthesize the function type: (fn(...) -> T) => value.` |
| fn-type `->` | `:=` `::` | `x : fn() -> T := f` | none: either grouping ends in an annotated `:=`/`::` target or a fn type as an alias name | none |
| lambda `->` | computational | `x -> x + 1` | right: the body | `Wrap the right-hand side in parentheses: params -> (x + 1).` |
| lambda `->` | a binding | `err -> flag = true` | not unique: the lattice says `(err -> flag) = true`, never a program; an author means the body `err -> (flag = true)` | none |
| lambda `->` | `:`, `=>` | `x -> y : T`, `x -> c => v` | none: a body `(y : T)` declares `y`, and `(x -> c) => v` is no form | none |
| computational | computational | `1 + 2 * 3` | not unique: both groupings are real programs (the E0003 repair was declined for this, `plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §3.1) | none |
| computational | `=>` | `n <= i32(1) => v`, `p == q && r => v` | left: the WHOLE arm condition. The parser reports the innermost operator (`&&` in the second example), so the hint names no operands: `(a && b) => v` would pick `p == (q && r)`, a different program that compiles | `Parenthesize the whole condition: (condition) => value.` |
| computational | `->` | `a + b -> c` | none: neither `(a + b) -> c` nor `a + (b -> c)` is a form | none |
| computational | `:` | `a + b : T` | none: the left of `:` is a name or pattern, never an expression, and `a + (b : T)` is not a form | none |
| computational | a binding | `a + b = c` | none: `(a + b) = c` binds no place, `a + (b = c)` is not a form | none |

One reading the table resolves by corpus weight rather than by grammar: `:`
then `=>` gets the annotated-parameter hint, but a named argument holding an
unparenthesized `=>` lambda, `P(cb : x => (x * 3))`, means the right side
`cb : (x => (x * 3))` (the form 3 sites in `tests/impl_fn_field_rejection.test.yo`
use). The two are the same tokens; the parameter reading outweighs it about
700 to 1.

The right-hand side in a wrap hint is the operand's own source: each token
verbatim (string and template literals keep their spacing), a whitespace run
between tokens as one space, ending at the operand's last token (a trailing
comment is not part of it). When the operand holds a comment, spans lines
inside a literal, ends an interpolation with a literal, or is longer than 72
bytes, the hint shows `(...)` instead of source that would not paste back.

Corrections made at takeover (2026-10-22), against the first version of the
classifier: `:` next to `=>` said "wrap the right-hand side"
(`name : (i32 => x)`), the wrong grouping for an annotated parameter; and
every arrow or binding on the left said "wrap the right-hand side"
whatever came next, which named a grouping for the one-tier pairs, for
`c => x = 5`, for `:`/`->` next to `:=`/`::`, and the wrong one for `->`
next to `=`/`?=`/`=>`.

Corrections from the adversarial review (2026-10-23), each a pair whose hint,
followed literally, compiled with a different meaning or did not parse:
computational then `=>` named the reported operator's operands
(`(a && b) => value`); a binding or `=>` then `:` said wrap the right-hand
side, which declares instead of ascribing; `->` was read only as the fn-type
arrow, so `self : Self -> {...}` was told `name : (Self -> {...})` and
`err -> flag = true` got a left-side hint; computational then `->` had a hint
although neither grouping is a form; the right operand's source ran to the
next token (a trailing comment landed inside the parentheses), to the end of
the file inside an interpolation, and collapsed the whitespace inside
literals; and the placeholder before the operator was always `name`.
