# A same-operator chain of FOUR or more operands is not left-associative — `20 - 5 - 4 - 3` is 16

> **FIXED 2026-10-01 — option 1 of this doc's own fix list ("mark the nodes
> `parse_left_assoc_op` itself creates"), refined with a paren-DEPTH tag.**
> `parse_left_assoc_op` now splices `primary` at the BOTTOM of the rhs's
> left spine, descending only through same-operator infix nodes the
> operator machinery recorded at the CURRENT `paren_depth` (a new Parser
> field bumped by `parse_paren_expr`; a new `infix_chain_node_depths` map
> carries id → depth). A parenthesized group's inner chain records one
> depth deeper, so `a - (b - c) - d` keeps its explicit grouping — the
> regression this doc warned about does not happen (pinned in
> `tests/operator_grouping.test.yo` for group-first, group-middle,
> group-with-own-3-chain, and group-then-chain shapes). Verified: the repro
> prints 8/6/5/10 for `-`/`/` chains of 4–6 operands; 278/278 `check ./src`;
> the full tree passes `fmt --check` after the sweep below; stage-2/3
> fixpoint per `scripts/bootstrap/fixpoint_only.sh`.
>
> **Two consequences that shipped with the fix:**
> 1. The formatter's D2 flatten rule (`is_left_same_operator_flatten_group`,
>    #386) is gated on a re-parse that must reproduce the original tree —
>    under the old parser the flattened form re-parsed mis-grouped, so long
>    same-op chains could never flatten. The fix unlocks it: 50 files
>    (`src/`, `std/`, `tests/`) carried `(x ⊕ y) ⊕ z …` groups that fmt now
>    flattens; they were reformatted in the same commit (the fmt gate is
>    green again).
> 2. `infix_chain_node_depths` adds one HashMap(usize, usize) entry per
>    infix node a file parses (~the infix-node count; the memory-ratchet
>    plans should account for it if it shows).
>
> The doc below is the frozen pre-fix record.

**Severity:** S1 — a 4+-operand same-operator chain parses one level off — `20 - 5 - 4 - 3` silently evaluates to 16

**Status:** OPEN (frozen pre-fix record; see the banner above).

**Severity: language semantics.** Yo has no operator precedence; the rule is
that a chain of the SAME operator left-associates
(`plans/archive/OPERATOR_ASSOCIATIVITY.md`, and the header of
`tests/operator_grouping.test.yo`). That holds for THREE operands and breaks at
FOUR: the parser splices the new left operand one level too high, so
`a - b - c - d` parses as `((a - (b - c)) - d)`.

For `+` and `*` the mis-grouping is invisible (they are associative). For
`-`, `/` and `%` it silently changes the value.

**Found** 2026-09-05, by making `comptime_assert` fire inside a function body
(`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`).
`tests/operator_grouping.test.yo` has asserted `(20 - 5 - 4 - 3) == 8` since it
was written — the assertion had never run.

## Reproducer

```rust
{ println } :: import("std/fmt");
_A3 :: (20 - 5 - 4);
_A4 :: (20 - 5 - 4 - 3);
_A5 :: (20 - 5 - 4 - 3 - 2);
_A6 :: (20 - 5 - 4 - 3 - 2 - 1);
_D4 :: (1000 / 10 / 5 / 2);
_M4 :: (100 % 30 % 7 % 3);
_P4 :: (((20 - 5) - 4) - 3);
main :: (fn() -> unit)({
  println(`20-5-4        = ${_A3}   want 11`);
  println(`20-5-4-3      = ${_A4}   want 8`);
  println(`20-5-4-3-2    = ${_A5}   want 6`);
  println(`20-5-4-3-2-1  = ${_A6}   want 5`);
  println(`1000/10/5/2   = ${_D4}   want 10`);
  println(`100%30%7%3    = ${_M4}   want 3`);
  println(`((20-5)-4)-3  = ${_P4}   want 8`);
});
export(main);
```

Measured on v0.2.24 (the released seed) AND on this tree — identical, so it is
not a regression:

```
20-5-4        = 11   want 11     ok  (three operands)
20-5-4-3      = 16   want 8      WRONG
20-5-4-3-2    = 14   want 6      WRONG
20-5-4-3-2-1  = 17   want 5      WRONG
1000/10/5/2   = 250  want 10     WRONG
100%30%7%3    = 0    want 3      WRONG
((20-5)-4)-3  = 8    want 8      ok  (explicit parentheses)
```

## Root cause

`src/parser.yo`. `parse_primary_end`'s infix branch parses the ENTIRE rest of
the chain with `self.parse_expression(rhs_start, exn)` and then hands it to
`parse_left_assoc_op`, which performs a SINGLE rotation: it takes the rhs's two
arguments `L` and `R` and builds `((primary op L) op R)`.

That is correct only when the rhs is a two-operand chain. For `20 - 5 - 4 - 3`
the rhs comes back already left-nested as `((5 - 4) - 3)`, so `L` is `(5 - 4)`
— not `5` — and the one-level rotation yields `((20 - (5 - 4)) - 3)` instead of
`(((20 - 5) - 4) - 3)`. Each extra operand adds one more misplaced level:

```
20-5-4-3-2   ->  ((20 - (5 - (4 - 3))) - 2)
```

The fix is to splice `primary` at the BOTTOM of the rhs's left spine rather
than at its top.

## Why this is not a small fix

The obvious recursive splice — descend the rhs's left spine while the node is
an infix call of the same operator, and rebuild — **regresses explicit
parentheses**. For `a - (b - c) - d` the rhs is `((b - c) - d)`, whose left
child is a same-operator infix node too, so a naive descent produces
`(((a - b) - c) - d)` where the source clearly says `((a - (b - c)) - d)`.
Today that case is CORRECT, and it must stay correct.

The AST carries no "this node came from a parenthesised group" bit, and
`parse_left_assoc_op` has no token span for the rhs's sub-nodes — only
`is_parenthesized_expr(start, end)` over a token range, and only the rhs's
whole range is known at the call site. A correct fix therefore needs one of:

* mark the nodes `parse_left_assoc_op` itself creates and descend only through
  those; or
* count the TOP-LEVEL (paren-depth-zero) occurrences of the operator in the
  rhs's token range and splice at exactly that depth; or
* restructure the infix branch so the rhs is parsed as a single primary and the
  existing `recur` loop left-associates naturally — which is the real fix, and
  the largest.

All three are parser surgery, and the parser is what compiles the compiler: a
mistake is not a failing test, it is a broken bootstrap. It needs its own PR
with `check ./src`, a stage-2/stage-3 fixpoint and the hollow sweep, not a
drive-by in the change that revealed it.

## Blast radius today

`grep -rnE '[A-Za-z0-9_)\]] - [^;,)]* - [^;,)]* - ' src/ std/` finds **no**
four-operand chains in the compiler or the standard library — every arithmetic
site there is either short enough or explicitly parenthesised — so no shipped
code is currently mis-computed by this. It is a hazard for user code and for
anything the formatter might un-parenthesise in future.

## What the tests do meanwhile

`tests/operator_grouping.test.yo` now asserts the MEASURED values for the
four-operand chain with a comment naming this issue and the value the chain
should have. The assertion stays live on purpose: when the parser is fixed it
goes red, and that red is the reminder to restore the correct value.
