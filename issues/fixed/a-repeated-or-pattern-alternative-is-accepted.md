# A repeated or-pattern alternative is accepted

**Found:** 2026-09-25, implementing `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.5.
**Severity:** LOW (dead code accepted silently; no wrong output).
**Status:** FIXED on `tss/phase4-5`.

## Reproducer

```rust
Color :: enum(Red, Green, Blue);
pick :: (fn(c : Color) -> i32)(match(c, (.Red | .Green | .Red) => i32(1), .Blue => i32(2)));
export(pick);
```

`yo check` passed, and so did `match(n, (1 | 1) => …, _ => …)`. The E0608 explanation in
`yo explain` says a repeated or-pattern alternative is an error.

## Root cause

`arm_is_unreachable` (`src/pattern.yo`) asked whether the arm's WHOLE pattern was useful
against each earlier arm. An or-pattern is useful when any one alternative is, so an
alternative that repeats an earlier sibling, or one an earlier arm covers, was never
examined on its own.

## Fix

`arm_reachability` judges the whole pattern first, then each alternative of a top-level
or-pattern (looking through `(name := …)`) against the earlier arms plus its earlier
siblings. The message names the alternative:

```
error[E0608]: Unreachable match arm: .Red — every value it matches is already matched by an earlier arm or an earlier alternative of its or-pattern
```

## Tests

`tests/cli-cases/match-or-alternative-repeated-is-an-error`.
