# Borrow liveness rejects the match switch-group lowering (develop regression)

**Severity:** S2 — `yo check ./src` fails on 16 files of the compiler's own
tree at develop `a24343bad`+ (the #1471–#1476 cluster): 32 `E0911` errors,
all the same shape, first at `src/evaluator/exprs/match.yo:1827`.

**Status:** open. Found 2026-10-19 gating the nested-index write fix.
NOT a regression of that change: with the fix's three files reverted to
develop, the same binary still rejects the same site, and the fix's only
borrow-adjacent edit (`_reject_if_container_reachable`'s trial-receiver
skip) is unreachable outside an index-method specialization trial —
match.yo's evaluation runs none. An older binary (develop `9fb88177f` era)
checks the same file clean.

## Symptom

```text
error[E0911]: Cannot write `fa.classic` here: `fidx` borrows `fa.pattern` with `&` and is still live, and a `&` borrow freezes its place: ...
     --> src/evaluator/exprs/match.yo:1827:21
 1827 |                   fa.classic = false;
```

`fidx` is the `match(&fa.pattern, .Variant(_, fidx, ...))` pattern binding;
the arm writes a sibling field of `fa` while the binding is live — a
pattern binding that never escapes the arm. The site is old code
(#1439-era); the REJECTION is new.

## Where to look

The borrow-liveness changes between `9fb88177f` and `a24343bad` — #1471
(a match through a borrowed element reads it in place, the `_is_index_place`
hook), #1473, #1476 (a closure parameter named like a live local borrow no
longer extends the borrow). A pattern binding's live range appears to have
been widened to the whole arm, freezing sibling-field writes that the
lowering performs mid-arm.

## Reproducer

```bash
yo check src/evaluator/exprs/match.yo --std-path ./std   # 2 E0911s on develop a24343bad+
```
