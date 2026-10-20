# Borrow liveness rejects the match switch-group lowering (develop regression)

**Severity:** S1 — release-blocking: `yo check ./src` fails on 16 files of the compiler's own
tree at develop `a24343bad`+ (the #1471–#1476 cluster): 32 `E0911` errors,
all the same shape, first at `src/evaluator/exprs/match.yo:1827`.

**Status:** fixed on develop by REVERTING #1476 (the borrow-liveness scan
that introduced the regression; the re-land is tracked in
`issues/2026-10-18-a-closure-parameter-named-like-a-live-local-borrow-extends-the-borrow.md`).
Found 2026-10-19 gating the nested-index write fix.
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

## Root cause (measured; CI-corroborated)

Culprit: #1476 (`a24343bad`), the scope-aware live-range scan. CI: the
battery at `f17367f98` (= #1473's code) was green on every Linux leg (the
macOS shard failure was a lost-runner infra flake, annotation "hosted runner
lost communication"); the battery at `a24343bad` fails `test (ubuntu)`,
`test (ubuntu-24.04-arm)`, `Build the suite candidate`, the fixpoint, the
self-hosted tier-1 and FV — all on this E0911.

Mechanism (probe: `YO_DEBUG_LB` print in `_lb_raise_conflict`): the borrow
`fidx` is born at a `match(&fa.pattern, .Variant(_, fidx, …) => …)` arm's
pattern. Its range comes from `local_borrow_range_of`'s STATEMENT-level
backward scan; #1476's arrow-literal skip answers "no mention" for the very
arm that binds `fidx` (the arm's left side binds the name), so no mentioning
child is found and the range's END falls back to `_last_token_of` of the
whole binding statement — past the arm body's write. Measured:
`lastuse=1825:78736` (correct, the `fidx == target_idx` comparison),
`end=1826:78794` (the whole statement), `access=1826:78778` (the
`fa.classic = false` write) — the write sits inside the inflated range.
Pre-#1476 the arm was visible to the scan and `_lb_region_end`'s branch-arm
logic ended the range at the condition.

A decl-aware refinement (an arm whose left side binds the tracked name AT
its declaration position is the birth site, and its body's uses count) was
built and DOES clear all 32 E0911s — but it re-opens #1476's own
false-positive class on the cursor-walk tests (`local_borrows`,
`match_async_arms`: E0919s), whose re-point `cur = n.next` token PRECEDES
the binding's last read inside one statement. Landing that refinement needs
the statement-internal evaluation-order rule settled, so v0.2.66 takes the
revert.

## Reproducer

```bash
yo check src/evaluator/exprs/match.yo --std-path ./std   # 2 E0911s on develop a24343bad+
```
