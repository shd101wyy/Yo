# A literal sub-pattern in a variant arm skips the following wildcard arm

**Severity:** S1 — a `match` returns an uninitialized value: when the variant tag matches but a literal sub-pattern does not, no arm runs.

Found 2026-10-06 while implementing capture lists (`plans/VALUES_BY_DEFAULT.md`
decision 35): `match(arg, .FnCall(_, _, ea, true, _) => …, _ => arg)` in
`src/evaluator/values/anonymous_struct.yo` crashed the self-built compiler
(SIGBUS in `__yo_decr_rc` on a non-infix call), because the `_` arm never ran.
The compiler's own source was rewritten not to use the shape; the bug itself is
open.

## Reproducer

`issues/repros/match-literal-subpattern-falls-through-the-wildcard.yo`:

```rust
E :: enum(Leaf(n : i32), Node(k : i32, flag : bool));
pick :: (fn(e : E) -> i32)(
  match(e, .Node(k, true) => k, _ => i32(-1))
);
picki :: (fn(e : E) -> i32)(
  match(e, .Node(7, f) => i32(70), _ => i32(-1))
);
```

| Call | Expected | Got (tree compiler at `feat/vbd-capture-lists`, and the v0.2.52 seed) |
| --- | ---: | ---: |
| `pick(E.Node(5, true))` | 5 | 5 |
| `pick(E.Node(6, false))` | -1 | 5 (the result temp is uninitialized) |
| `pick(E.Leaf(1))` | -1 | -1 |
| `picki(E.Node(7, false))` | 70 | 70 |
| `picki(E.Node(8, false))` | -1 | 70 (uninitialized) |

clang warns on the emitted C:
`variable '…temp…' is used uninitialized whenever 'if' condition is false [-Wsometimes-uninitialized]`.
The seed's binary of the same program crashes (rc=139).

## Root cause (as far as read)

The emitter groups arms by variant tag (`switch` on the tag) and guards the
literal sub-pattern with an `if` inside the `case`. When the `if` fails, the
`case` breaks without falling back to the later arms that also cover the tag
(here the trailing `_`). This is the shape of "Gap 1" in
`plans/reference/MATCH_PATTERN_MATCHING.md` §3.1, which recorded the missing
exhaustiveness error; with a `_` arm present the match is exhaustive and the
fallback still does not run.

## Fix direction

Lower a tag group whose first arm has a refutable sub-pattern as a decision
chain: on a sub-pattern miss, continue with the next arm that matches the same
tag (or the wildcard), as the general pattern compiler does for nested
patterns.
