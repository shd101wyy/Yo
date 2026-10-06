# A literal sub-pattern in a variant arm skips the following wildcard arm

**Severity:** S1 — a `match` returns an uninitialized value: when the variant tag matches but a literal sub-pattern does not, no arm runs.

Status: FIXED 2026-10-06 — the evaluator now runs a variant-tag group coverage
check before `register_match_arms` (`src/evaluator/exprs/match.yo`): a group
whose every arm carries a literal payload sub-pattern (so the `case TAG:`
block has no unguarded arm of its own) is asked `variant_group_covers`
(`src/pattern.yo`, the Maranget usefulness query `.V(_, _, …)` over the
group's rows). An uncovered group flips its arms' `classic` bit, so codegen
takes the general test-chain lowering, where a literal miss continues with
the next arm instead of falling out of the switch. Groups that jointly cover
(`.Some(true)` + `.Some(false)`) keep today's switch shape byte-identically.
Tests: tests/match_catch_all.test.yo.

Found 2026-10-06 while implementing capture lists (`plans/VALUES_BY_DEFAULT.md`
decision 35): `match(arg, .FnCall(_, _, ea, true, _) => …, _ => arg)` in
`src/evaluator/values/anonymous_struct.yo` crashed the self-built compiler
(SIGBUS in `__yo_decr_rc` on a non-infix call), because the `_` arm never ran.
The compiler's own source was rewritten not to use the shape; with this fix
the shape works.

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

## Root cause

The emitter groups arms by variant tag (`switch` on the tag) and guards the
literal sub-pattern with an `if` inside the `case`. When the `if` fails, the
`case` breaks without falling back to the later arms that also cover the tag
(here the trailing `_`, which the switch holds in `default:` — unreachable
from inside the case). This is the shape of "Gap 1" in
`plans/reference/MATCH_PATTERN_MATCHING.md` §3.1, which recorded the missing
exhaustiveness error; with a `_` arm present the match is exhaustive and the
fallback still did not run.

## Fix

Lower a tag group whose arms do not jointly cover its variant onto the
general test-chain lowering (`_gen_general_match`): on a sub-pattern miss,
continue with the next arm that matches the same tag (or the wildcard), as
the general pattern compiler does for nested patterns. The coverage decision
is the usefulness query `variant_group_covers` in `src/pattern.yo`, run by
the evaluator after the arm loop and stamped into the registered arms'
`classic` bits, so both the sync and the async state-machine emitters
(they share `lookup_match_arms`) take the same path.
