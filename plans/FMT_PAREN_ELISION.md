# `yo fmt` redundant-paren elision — extend the existing machinery to the provably-safe remainder

**Status:** IMPLEMENTED 2026-09-02 — D1/D2/D3 + the re-parse gate landed in
`src/formatter.yo`; 16 decision-table tests in
`tests/internal/formatter.test.yo`; 16 fixture `.expected` files refreshed;
the whole `src/` + `std/` + `tests/` tree swept to the new canonical form
(565 files) with the second pass a no-op. Two implementation-time
discoveries folded into the rules: the `op((G))` inner-defer (a
`single_inner_group_not_atom_like` guard, so `-( (1 + 2) )` elides the
INNER group and the tight `-(` call spelling survives rendering — removing
the outer instead renders as the misleading spaced `- (1 + 2)`), and the
gate's conservatism on `quote(...)` arguments containing `#(...)` macro
splices (`exprs_are_equal` cannot prove those trees equal, so such groups
stay — safe, slightly less canonical). The formatter tests run under
`YO_TEST_LEAK_VERDICT=0` like the rest of tests/internal
(`issues/self-hosted-emit-leaks-remaining-classes.md` tracked debt — the
gate's in-process parses add to that debt class, ~46 bytes/call).

Originally PROPOSED 2026-09-02 (rewritten twice the same day: first to fix a
wrong "prefix elision is grammar-blocked" claim based on the stale
[`archive/FMT_PAREN_CANONICALIZATION.md`](archive/FMT_PAREN_CANONICALIZATION.md)
rationale, then after discovering the formatter ALREADY elides a subset — the
docs' "fmt preserves every parenthesis" was never literally true).

Companions: [`OPERATOR_ASSOCIATIVITY.md`](OPERATOR_ASSOCIATIVITY.md) and
[`PREFIX_OPERATOR_OPERAND_RULE.md`](PREFIX_OPERATOR_OPERAND_RULE.md) (Rule 1
landed 2026-08-21 in PR #201, shipped in the v0.2.21 seed released 2026-09-01;
its old "seed rejects paren-less forms" constraint is lifted — noted there).

## Position

`yo fmt` is NOT purely paren-preserving: it already removes a class of
redundant grouping parens via `is_redundant_grouping_paren` /
`paren_removal_would_expose_operator_rhs_infix` /
`find_redundant_grouping_paren_indices` (`src/formatter.yo`, ported from the
TS-era formatter). What it deliberately keeps is **load-bearing grouping**:
mixed-operator groups, right operands, operator-RHS chains. This plan extends
the same machinery to the remaining provably-redundant classes, with the same
guarantee — removal is re-parse-identical under the grammar rules below,
enforced structurally by a re-parse AST-equality gate.

## The grammar model (verified 2026-09-02 against the v0.2.21 seed)

ALL of `:=`, `=`, `::`, `:`, `->`, `=>`, `+`, `-`, `*`, `/`, `==`, … are
plain infix operators — none has special RHS handling; `.` alone is special
(postfix, binds tightest). No precedence. The rules:

1. **Greedy same-operator chains.** An infix chain's operators must all be
   identical; a same-op chain left-associates: `1 + 2 + 3` ≡ `(1 + 2) + 3`.
2. **Adjacent different operators need parens.** If a greedy RHS comes back
   as a non-parenthesized chain headed by a DIFFERENT operator, the parser
   errors — uniformly: `y := 1 + 2` and `1 + 2 - 3` are illegal for the same
   reason (`:=`/`+`, `+`/`-`), while `y := (1 + 2)`, `(1 + 2) - 3`,
   `x == (-(1) + 2)` are legal. `->` and `=>` obey this like any other
   operator (`cond(!flag => i32(1), true => i32(2))` is a legal `=>` chain
   in argument position; `main :: (fn() -> unit)(…)` needs its group because
   the content is a `->` chain serving as a call callee).
3. **Atom-like operands never need parens.** Atoms, calls, dot-chains,
   prefix calls, and paren groups are single operands. Parens around an
   operand that is already atom-like are redundant — including after
   NON-allow-list operators: `(x) - (y)` ≡ `x - y`. The existing
   `operator_allows_ungrouped_rhs` allow-list (`:=`, `::`, `=`, `:`, `=>`,
   `->`) is TS-era conservatism, not a grammar fact — under the uniform
   grammar the elision is equally valid after `+` or `-`.
4. **Prefix operators bind one postfix expression** (`-x`, `-x.v`, `-f(x)`),
   nested bare prefixes chain (`?*x` ≡ `?(*(x))`, `**i32` ≡ `*(*(i32))`,
   `- -1`), and the paren-call spelling `-(x)` is exactly equivalent.
5. **Statement / call-argument position parses a full expression** — bare
   infix chains and prefix+infix mixes are fine there: `sink(1 + 2)`,
   `sink(-x + 2)`, `sink(3 - -3)` are legal.

Verified parse matrix (v0.2.21 seed, `yo check`):

| Spelling | Verdict |
| --- | --- |
| `y := 1 + 2` / `x = x + 1` / `y := -x + 2` / `sink(x == -(1) + 2)` | ✗ (rule 2) |
| `y := (1 + 2)` / `y := (-x + 2)` / `x == (-(1) + 2)` | ✓ |
| `y := (1 + 2 + 3)` / `y := ((1 + 2) - 3)` / `y := (1 + (2 - 3))` | ✓ |
| `sink(1 + 2)` / `sink(3 - -3)` / `sink(-x + 2)` / `sink(-(x) + 2)` | ✓ |
| `y := -x` / `y := -(x)` / `y := (x)` / `sink(((1 + 2)))` / `sink((1) + (2))` | ✓ |

## Current behavior (verified 2026-09-02, `yo fmt` v0.2.21)

Already elided today:

| Input | Output | Rule |
| --- | --- | --- |
| `y := ((x))` / `w := (((3)))` | `y := x` / `w := 3` | E1 |
| `sink(((1 + 2)))` / `sink((1 + 2))` | `sink(1 + 2)` | E1+E3 |
| `y := (x)` / `p := &((x))` | `y := x` / `p := &(x)` | E2 (allow-list ops only) |
| `sink2((x), (y))` | `sink2(x, y)` | E3 |
| `y := ((1 + 2))` | `y := (1 + 2)` — one level, inner kept | R1 respected |

Kept today (guards in `is_redundant_grouping_paren`: comment inside, call
delimiter, top-level comma/semicolon, `fn`-type content, operator
predecessor outside the allow-list, following operator/dot/`(`).

## The delta — elisions to ADD (DO)

### D1 — E2 extension: atom-like groups in infix-operand position

`(a) ⊕ b`, `a ⊕ (b)` → drop the parens when the group's content is a single
atom-like expression (atom, call, dot-chain, prefix call — never an infix
chain). `(expr1) + (expr2)` → `expr1 + expr2`; `(x) - (y)` → `x - y`;
`(x) - (-y)` → `x - -y` (legal; spacing per the existing prefix rules).
This relaxes the prev-operator/allow-list and next-operator blocks in
`is_redundant_grouping_paren` for atom-like content. Since ALL operators are
plain (only `.` is special), the allow-list distinction is pure TS-era
legacy: after D1 the content check fully subsumes it, `operator_allows_ungrouped_rhs`
has no remaining caller, and the helper is deleted.

### D2 — E4: flatten left-nested same-operator groups

`(a ⊕ b) ⊕ c` → `a ⊕ b ⊕ c` when the group is the LEFT operand of the same
operator and the group's depth-0 operators all equal it. Includes inside a
retained R1 group: `y := ((1 + 2) + 3)` → `y := (1 + 2 + 3)`.
Right operands NEVER flatten (R2); mixed operators NEVER (R3).

### D3 — E5: prefix-call paren elision

`-(x)` → `-x`; chains normalize fully: `&((x))` → `&x`, `?(*(x))` → `?*x`
(bare prefix chains are canonical; go all the way). Multi-arg operator
calls (`-(a, b)`) are calls, not grouping — untouched. In operand position
too: `f(-(x) + 2)` → `f(-x + 2)`.

## Retention rules (DON'T) — unchanged, now enforced by existing guards

- **R1 — an operator's non-atom RHS keeps its group**: `y := (1 + 2)` stays
  (eliding is illegal, rule 2). Today's
  `paren_removal_would_expose_operator_rhs_infix` already implements this —
  D1 must not weaken it for chain content.
- **R2 — right operands keep their groups**: `3 + (4 - 5)`, `3 + (4 + 5)`.
- **R3 — mixed-operator groups stay**: `(3 + 4) - 5`.
- **R4 — structural guards stay**: top-level comma, semicolon, comments
  inside the group, call delimiters, `fn`-type groups, dot-deref forms.

## Decision table (normative, input → output)

| Input | Output | Rule |
| --- | --- | --- |
| `func((expr1), x)` | `func(expr1, x)` | already shipped (E3) |
| `y := ((1 + 2))` | `y := (1 + 2)` | already shipped (E1, R1) |
| `(expr1) + (expr2)` (atom-like) | `expr1 + expr2` | D1 |
| `(3 + 4) + 5` | `3 + 4 + 5` | D2 |
| `(3 + 4) - 5` | unchanged | R3 |
| `3 + (4 - 5)` / `3 + (4 + 5)` | unchanged | R2 |
| `y := (1 + 2)` | unchanged | R1 |
| `y := ((1 + 2) + 3)` | `y := (1 + 2 + 3)` | D2 under R1 |
| `-(expr1)` | `-expr1` | D3 |
| `-(expr1 + expr2)` | unchanged | R3 (prefix binds ONE postfix expr) |
| `-(expr1.expr2)` | `-expr1.expr2` | D1/D3 |
| `?(*(x))` | `?*x` | D3 |
| `f(-(x) + 2)` | `f(-x + 2)` | D3 |
| `x - (-y)` | `x - -y` | D1 |

The originating draft's phrasing "keep one level on the right side of
another infix, otherwise remove" is too broad: it would elide `(3 + 4) - 5`
and `y := (1 + 2)`. The tables are normative.

## Implementation sketch

Extend the existing two-pass machinery in `src/formatter.yo`; do not build a
parallel system:

1. **D1**: in `is_redundant_grouping_paren`, replace the
   prev-operator/allow-list and next-operator blocks with a content
   check — the group is removable in operand position iff its content is
   atom-like (scan depth-0 for operator/comma/semicolon tokens; reuse
   `has_top_level_operator`-style helpers). Keep
   `paren_removal_would_expose_operator_rhs_infix` intact so chain-content
   groups after any operator still stay (R1).
2. **D2**: add a candidate rule for the `(a ⊕ b) ⊕ c` shape — group is
   directly followed by the same operator token that also appears at every
   depth-0 position inside the group, and the group's previous context is
   left-operand position (start of statement / after `(`/`,`/`;`).
3. **D3**: add a candidate rule for the prefix-call shape — operator token
   immediately before `(` with no whitespace, single argument, no top-level
   comma; recursing so `?(*(x))` reaches `?*x`. Guard the existing
   dot-deref forms (`(x).*`-style) — they must keep their parens.
4. **Re-parse verify gate (mandatory)**: after formatting a file where any
   D1–D3 elision applied, parse original and formatted text and assert
   `exprs_are_equal` (`src/expr.yo`, ignoring ExprIds/positions). On
   mismatch: discard that file's elisions, emit conservative output, log a
   warning. A meaning-changing format is structurally impossible.
5. **Idempotence**: the D1–D3 outputs contain no further elision targets by
   construction; FMT_IDEMPOTENT (tier-1 gate) stays green.
6. **Corpus dry run**: run the new fmt over the whole repo; review the full
   diff; commit it in the same PR (the tree must be fmt-clean).

## Tests

- Fixture matrix = every decision-table row plus regressions:
  `y := (1 + 2)` (R1), `x == (-(1) + 2)` (R1), `f((a, b))` comma guard
  (R4), comments inside a candidate group (R4), `1 + 2 + (3 + 4)` (R2),
  `(x).*` dot-deref forms, `fn`-type groups `(fn(x : i32) -> i32)`.
- FMT_IDEMPOTENT plus repo-wide `yo fmt --check` after the sweep commit.

## Non-goals

- No paren INSERTION (fmt never adds R1-required parens; that stays
  authoring guidance — a future lint could flag illegal spellings).
- No configuration flags.
- No changes to prefix-call spacing rules (`- -1` keeps its space, etc.).

## If adopted, update

- `.github/instructions/yo-syntax.instructions.md` "Don't write unnecessary
  parentheses" — currently claims fmt "preserves every parenthesis you
  write", which is already inaccurate today (E1–E3 ship); rewrite to
  describe the elision set and the R1 retention headline
  (`y := (1 + 2)` keeps its parens).
- `.github/skills/yo-syntax/syntax-cheatsheet.md` accordingly.
- Closing banner on `plans/archive/FMT_PAREN_CANONICALIZATION.md`: its
  Rule 3 rationale is obsolete under PR #201 — `3 - -3` now parses,
  prefix chains are legal — superseded by this plan; its "fmt is
  paren-preserving" premise was already false for the E1–E3 subset.
