# Borrow liveness rejects the match switch-group lowering (develop regression)

**Severity:** S1 — release-blocking: `yo check ./src` fails on 16 files of the compiler's own
tree at develop `a24343bad`+ (the #1471–#1476 cluster): 32 `E0911` errors,
all the same shape, first at `src/evaluator/exprs/match.yo:1827`.

**Status:** fixed. For v0.2.66, develop reverted #1476 (#1481). For v0.2.67,
#1476 is re-landed with the actual cause below corrected. `yo check ./src`
passes 278/278 files with the re-landed scan, and the cursor-walk tests
(`tests/local_borrows.test.yo`, `tests/match_async_arms.test.yo`) stay green
(`issues/fixed/2026-10-18-a-closure-parameter-named-like-a-live-local-borrow-extends-the-borrow.md`).
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

Mechanism (probe: `YO_DEBUG_LB` print in `_lb_raise_conflict`):
`lastuse=1825:78736` (correct: the `fidx == target_idx` comparison),
`end=1826:78794`, `access=1826:78778` (the `fa.classic = false` write). The
write lies inside the inflated range.

**Corrected attribution (2026-10-20).** The first write-up blamed the arm
that binds `fidx`. That is wrong, and the decl-position-aware round built on
it fixed the wrong thing. Here is what actually happens:

- `fidx` is registered by `local_borrow_register_match_place`
  (`src/evaluator/exprs/match.yo`) with the arm BODY, so the arm that binds
  `fidx` is never scanned.
- The body is `if(fidx == target_idx, { fa.classic = false; })`, which the
  parser desugars to `cond((fidx == target_idx) => { … }, true => ())`.
- `_lb_mentions(body)` handles this correctly: walking a `cond` node, it passes
  the cond-arm flag to the arm children, so the condition counts as a use.
- `_lb_region_end(body)` did not pass the flag. #1476 left it unchanged when it
  gave the other three helpers the flag. It therefore read the arm
  `(fidx == target_idx) => { … }` as a closure: `==` binds nothing, only the
  body was scanned, and the body never mentions `fidx`.
- So no arm mentioned `fidx`, and the end fell back to `_last_token_of` of the
  whole `cond`, which is `end=78794`.

Before #1476 the condition counted, the branch-arm rule fired, and the range
ended at the condition. The decl-aware round changed which arms count as
shadows. It cleared these 32 errors and broke the cursor walks; its diff was
not kept, so this doc does not say how it cleared them. The missing flag
alone explains the measured `end`, and adding the flag clears all 32 errors.

**Fix:** `_lb_region_end` passes `is_cond && _lb_is_arrow_literal(child)`,
as `_lb_mentions` does. All four helpers now share one shadow predicate,
`_lb_arrow_shadows`. Regression test: "a match binding used only in an if
condition ends at the condition" in `tests/local_borrows.test.yo`.

## Reproducer

```bash
yo check src/evaluator/exprs/match.yo --std-path ./std   # 2 E0911s on develop a24343bad+
```
