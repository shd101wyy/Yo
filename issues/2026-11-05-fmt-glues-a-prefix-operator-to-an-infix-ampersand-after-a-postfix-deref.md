# `yo fmt` glues a prefix operator to an infix `&` that follows a postfix deref

**Severity:** S3 — cosmetic: `(o.* & ~y)` is formatted as `(o.* &~y)`. The tokens and the meaning are unchanged (the program computes the same value and `fmt --check` accepts its own output), but the canonical layout is wrong and differs from `(o & ~y)`.

Found while porting `tests/origins/model.yo` off `ref` types (V5 part B, branch
`vbd/v5-part-b-tests`), on develop 68b45b81d. A pattern binding `o` became a reference, so
`(o & ~ELIDED)` became `(o.* & ~ELIDED)`, and the tree formatter rewrote it to
`(o.* &~ELIDED)`.

## Symptom

```yo ignore
g :: (fn(o : &i64, y : i64) -> i64)((o.* & ~y) | ~y);
```

`yo fmt` (tree binary) prints:

```yo ignore
g :: (fn(o : &i64, y : i64) -> i64)((o.* &~y) | ~y);
```

Measured shapes:

| Source | Formatted |
| --- | --- |
| `(o & ~y)` | unchanged |
| `(o.* & ~y)` | `(o.* &~y)` |
| `o.* - -y`, `o.* + ~y`, `o.* && !y` | unchanged |

## Cause

`prefix_operator_needs_leading_space` (`src/formatter.yo`) decides the space before the `~`
from its two predecessors: `previous` = `&`, `prev_prev` = `*`. A prefix chain (`&~`) is
emitted tight when the previous operator is itself in prefix position, and that is judged by
`prev_prev_ends_rvalue`. A postfix deref `*` (an operator directly after a `.`) ends an
rvalue, but the predicate counts only atoms, `.` and closing brackets, so the infix `&` looks
like a prefix `&` and the chain is glued. The space before the `&` itself is right, because
the tightness rule (`prev_is_postfix_deref`) does recognise the postfix deref. The same holds
after a postfix `.&` and for an infix `*` (`o.* * ~y`).

## Fix direction

Treat a postfix deref as an rvalue end in `prefix_operator_needs_leading_space`, as the
tightness rule already does. That needs the token before `prev_prev` (or a flag carried by
the caller) to tell the postfix `*` from a prefix `*`.

## Test

The fix adds `(o.* & ~y)` and `(o.* * ~y)` to `tests/internal/formatter.test.yo`'s idempotence
cases, which must format unchanged, and moves this doc to `issues/fixed/`.
