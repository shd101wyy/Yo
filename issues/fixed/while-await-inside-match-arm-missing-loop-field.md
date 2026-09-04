# A while-with-await inside one arm of a match/cond whose other arm also awaits: the state struct never declares `while_loop_N_active`

**Found**: 2026-08-28 (C33, `std/http/client.yo`'s deadline race). **Status**:
**FIXED 2026-08-29** — loop-ness is now recorded PER BRANCH on the merged
point (`SuspensionPoint.cond_branch_suspension_in_while`, parallel to
`cond_branch_suspension_exprs`, `src/evaluator/shared/suspension_analysis.yo`);
the state-struct emitter declares `while_loop_<index>_active` when ANY branch
loops (`src/codegen/exprs/async.yo`); branches that disagree on loop-ness
force dispatch mode (`cond_await_point_needs_dispatch`), and the dispatch
emitter applies the `while_loop_N_active` check / `goto after_while_loop_N`
continuation only to the looping branches — a loop that encloses the whole
cond (the representative flagged from OUTSIDE its arm) still applies to every
branch (`_emit_await_suspension_dispatch`, `src/codegen/async/state_machine.yo`).
Regression test: `tests/async/while_await_in_match_arm.test.yo` (both arm
orders, RED on the pre-fix compiler with exactly the clang error below);
production pin: `std/http/client.yo`'s `fetch_with` now holds the deadline
race in its `.Some(limit)` arm directly. Original record follows.

clang rejected the emitted C, so the failure was LOUD — but it fired only
at C-compile time (`yo check` is green) and the diagnostic named a generated
member, not the Yo shape.

## Symptom

```
error: no member named 'while_loop_0_active' in 'struct _file____priv_temp_11262_state_t_struct'
```

## Reproducer

`issues/repros/while-await-inside-match-arm-missing-loop-field.yo` — an
`io.async` body with

```rust
match(limit,
  .None => { result = e.io.await(work(e.io), e); },
  .Some(l) => {
    h := e.io.spawn(work(e.io), e); dh := e.io.spawn(sleep(l, e.io), e.io);
    while(runtime(!(h.is_finished()) && !(dh.is_finished())), { e.io.await(yield(e.io), e.io); });
    ...
  })
```

`yo compile <repro> --release -o r` → the three clang errors above. No
network; std `sleep`/`yield` only.

## Mechanism

`src/evaluator/shared/suspension_analysis.yo` (the cond/match merge,
`is_cond_or_match` arm, ~line 470–600) walks each arm separately and then
re-adds ONE representative suspension point per depth position — the first
arm's point at that position. Loop-ness is a per-point flag
(`is_inside_while`, `while_nesting_depth`, `enclosing_while_expr`) set by the
`while` arm of the walker on the points found inside the loop. When the
representative comes from an arm that is not in a loop (`.None` above), the
merged point carries `is_inside_while = None`, so:

- `src/codegen/exprs/async.yo` (~line 830, the state-struct emitter) declares
  no `while_loop_<index>_active` field for it, while
- `src/codegen/async/state_code_gen.yo`'s while emitter, generating the
  looping arm's body, writes `sm->while_loop_<index>_active = true` and reads it
  at the loop head, and
- `state_machine.yo`'s post-await continuation (`while_info`) is likewise
  skipped for the point, so even with the field declared the loop would not
  re-evaluate its condition after the awaited `yield`.

Simply OR-ing `is_inside_while` across arms onto the representative is NOT
enough: the continuation code for a point with `while_info` ends in `} else {
goto after_while_loop_N; }`, which the non-looping arm would then also emit,
jumping over the rest of its own arm. Loop-ness has to become per-branch
information on the merged point (the way `branch_exprs` already records each
arm's suspension expr for dispatch-mode typing —
issues/fixed/async-cond-shared-await-point-only-models-representative-branch.md),
with the struct emitter declaring the field when ANY arm loops and the
continuation emitted per arm.

## Shape avoided in std (until the fix)

`std/http/client.yo` kept the deadline race in its own top-level future,
`_fetch_with_deadline`, so `fetch_with`'s match arms each contained a single
plain await. That indirection was removed with the fix; the arm is now the
production pin of this shape.
