# Stricter Operator Grouping

> **ARCHIVED 2026-09-04 — SUPERSEDED** by
> [`OPERATOR_SET_AND_PRECEDENCE.md`](../reference/OPERATOR_SET_AND_PRECEDENCE.md)
> (closed operator token set + no-precedence stance, 2026-08-21). The
> grouping implementation described below lives in `src/parser.yo`.

Status: **implemented** (`src/parser.ts` + `yo-self/parser.yo`; std/tests/yo-self
migrated; corpus 83/83). The infix branch now: same operator → left-associative
(`parseLeftAssociativeOperator`); adjacent different operators → parentheses-
required error; the newline-associativity logic is removed. Tests:
`tests/operator_grouping.test.yo` (same-op left-assoc, mixed grouping, comparison-
chaining rejection). Note: bare unary operands remain a separate, pre-existing
rule — `!x` must be `!(x)` (paren-less calls are unsupported).

## Summary

Two related changes to how Yo parses chained infix operators:

1. **Remove the newline-based associativity rule.** Today the *position of a
   newline* around an operator decides associativity. This makes program meaning
   depend on layout, which is fragile (a reformat or line-wrap can silently
   change semantics).
2. **Adopt a Pony-style grouping rule** in its place:
   - **Same operator repeated → left-associative**, no parentheses needed
     (`a + b + c` ⇒ `(a + b) + c`).
   - **Different operators adjacent → parentheses required** (`a + b * c` is a
     parse error; write `(a + b) * c` or `a + (b * c)`).

Yo has **no operator precedence** today and **keeps it that way**. This change
is purely about *associativity / grouping disambiguation*, not precedence.

## Motivation

- **No precedence ⇒ everything needs parens today.** Because Yo has no
  precedence, even `a + b + c` is rejected as ambiguous and must be written
  `(a + b) + c` (or disambiguated with a newline). Same-operator chains are
  unambiguous in practice and should not require ceremony.
- **Newline-as-semantics is a hazard.** Associativity currently depends on
  whether the operator sits at the *end* of a line (right-assoc) or the *start*
  (left-assoc). Consequences:
  - **`yo fmt` is dangerous** — reflowing or wrapping a long expression can
    change its grouping, hence its meaning. For a project that mandates
    `yo fmt` on every file, that is a latent correctness bug.
  - Copy-paste, line-wrapping, and merge conflicts become semantic operations.
  - It is non-discoverable; nobody expects a newline to flip associativity.
- Once same-op-left-assoc + parens-for-mixing is in place, the newline rule has
  **nothing left to disambiguate** — associativity is fixed by the operator and
  grouping is made explicit with parens. So the newline rule is not just risky,
  it is redundant.

## Current behavior (verified in `src/parser.ts`)

All infix operators — including `=` and `->` — go through **one uniform code
path** (`parseExpression` → the infix branch around `parser.ts:1071–1160`).
There is **no precedence layering and no per-operator grammar production.** When
the right-hand side of an operator is itself an unparenthesized infix expression
(a chain), the parser disambiguates using the newline layout:

```rust
// RIGHT associativity — operator at END of line:
1 +
  2 + 3        // ⇒ 1 + (2 + 3)

// LEFT associativity — operator at START of line:
  1
+ 2
+ 3            // ⇒ (1 + 2) + 3

// Operator ALONE on its line — right-assoc (special case):
a
=
  b -> c       // ⇒ a = (b -> c)

// No newline disambiguation ⇒ hard error:
a + b * c      // ⇒ "Ambiguous operator precedence" — must use parens or a newline
```

Note the error message is named "Ambiguous operator **precedence**," but it is
really about grouping; there is no precedence in the parser. The current rule
applies the ambiguity check to **all** chains, so even `a + b + c` (same
operator) requires either parens or a disambiguating newline today.

## Proposed behavior

When the RHS of an infix operator is an unparenthesized infix chain:

| Case | Today | Proposed |
| --- | --- | --- |
| **Same** operator (`a + b + c`) | ambiguous → parens/newline | **left-assoc, accepted** (`(a + b) + c`) |
| **Different** operators (`a + b * c`) | ambiguous → parens/newline | **parse error → parens required** |
| Fully parenthesized (`(a + b) * c`) | OK | OK (unchanged) |
| Newline layout | decides associativity | **ignored** (rule removed) |

Decisions (locked):

- **No precedence, ever.** Keep the parser flat/uniform.
- **"Different" is strict — no grouping into classes.** `+` and `-` are
  different operators, so `a + b - c` requires parens. Likewise `a * b / c`.
  We deliberately do **not** introduce additive/multiplicative tiers (that would
  be precedence by another name).
- **`=` and `->` are ordinary infix operators** (verified — not separate
  productions), so they follow the same rule. A same-operator chain like
  `a -> b -> c` is left-associative by default; if right grouping is intended
  (e.g. a curried function type), write `a -> (b -> c)`. A mixed chain like
  `a = b -> c` requires explicit parens.
- **Comparison chaining `a < b < c` is invalid** and needs no special parse
  rule: it parses as `(a < b) < c` under the same-op-left-assoc rule, and the
  type checker rejects it (`a < b` is `bool`, and `bool < c` is a type error).
- **Right-associative operators are not special-cased.** Yo has no `**`
  (exponentiation is/should be a method, e.g. `x.pow(y)`, like Rust). If a
  conventionally right-associative operator is ever added, it does **not** get a
  built-in right-assoc default — right grouping is written with parens. This
  keeps the rule exception-free:

  > **Same operator → left-associative. Different operators → parentheses.
  > No exceptions.**

## Error message

Keep an ambiguity error for the different-operator case, but **drop the
"or use a newline" suggestion** and show both explicit groupings:

```
error: adjacent different operators need parentheses to clarify grouping
  a + b * c
      ^
  write one of:
    (a + b) * c
    a + (b * c)
```

## Migration

The same-op-left-assoc rule is a **relaxation** — code that is already fully
parenthesized keeps parsing unchanged; it only *permits* dropping parens on
same-operator chains. The breaking part is removing the newline rule. Audit:

1. **Multi-line same-operator chains of a *non-associative* operator** (`-`,
   `/`, and `->` if used in curried position). These flip from right- to
   left-assoc and change meaning:
   ```rust
   a -      //  was a - (b - c)
     b - c  //  now (a - b) - c  ← different result, add parens to preserve
   ```
   (For *associative* operators — `+`, `*`, `&&`, `||` — the result is
   unchanged, so those are safe.)
2. **Multi-line different-operator chains** that relied on a newline instead of
   parens — these become parse errors and must be parenthesized.
3. Fully-parenthesized code: no change.

A mechanical migration aid: a one-shot pass (or a `yo fmt` mode) can insert
parentheses that **preserve the current newline-derived grouping**, after which
the newline rule can be deleted with zero semantic change. After the change,
`yo fmt` becomes free to reflow operator expressions safely.

Re-`check` `std/`, `tests/`, and `yo-self/` after the migration.

## Implementation sites

This is a **two-parser change** (the TS↔yo-self port is strict 1:1 — both must
change together) plus the formatter:

- `src/parser.ts` — the infix branch (~`1071–1160`):
  - delete `isOperatorAtLineStart`, `hasNewLineAfterOperator`,
    `isOperatorAloneOnLine` and the newline branches;
  - on a chained-infix RHS, compare the two operator tokens: **same token ⇒**
    `parseLeftAssociativeOperator(...)` (already exists); **different ⇒** throw
    the new parens-required error.
- `yo-self/parser.yo` — mirror the change 1:1.
- `yo fmt` (`src/formatter.ts` + `yo-self/formatter.yo`) — stop preserving
  newline-as-associativity; optionally add the auto-parenthesize migration mode.
- Tests: add parser cases for `a + b + c` (accepted), `a + b - c` and
  `a + b * c` (rejected with the new error), and a type-check case for
  `a < b < c`.

## Open questions

- **`a = b = c`**: under same-op-left-assoc this parses as `(a = b) = c`, which
  the type system rejects (assignment yields `unit`). Confirm Yo never relies on
  chained assignment; if it does, decide whether to forbid it explicitly.
- **`->` in curried function types**: confirm whether any `std`/`yo-self` code
  writes `A -> B -> C` expecting right-assoc; if so, parenthesize during
  migration.
