# Async post-while cond-branch cleanup can run twice — stale `cond_branch_N` key over-releases every slot it drops

**Status: FIXED in tree (2026-08-23). Surfaced by the fix for
issues/async-future-result-never-dropped.md — the leaked future-result count
used to mask this over-drop exactly (one leaked count per awaited RC result
absorbed one extra drop).**

## Symptom

`tests/fs/walker.test.yo` "walk_with max_depth limits traversal" crashed
(SIGBUS/SIGTRAP, malloc freelist corruption) under a stage-1 carrying the
future-result-drop fix, ~50% of runs. Minimal repro: one `walk(...)` over a
3-level tree followed by one `walk_with(..., max_depth 0)` in the same
program. Deterministic under GuardMalloc: the faulting access is
`__yo_decr_rc(sm->var_<entries>)` in the post-while-loop cleanup block of the
walker's state machine — dropping a list that was already dropped and freed.

## Mechanism (verified with lldb breakpoint counting)

`_emit_post_while_cond_branch` (src/codegen/async/state_machine.yo) emits the
branch's post-loop deferred drops guarded ONLY by the branch key:

```c
after_while_loop_1:
if (sm->cond_branch_0 == 12) {
  ...                                    // post-while exprs
  __yo_decr_rc((void*)(sm->var_160280)); // deferred drops of branch locals
}
// shared outer-loop continuation code follows
```

The guarded block sits on the SHARED loop-continuation path. When a LATER
iteration of the enclosing loop takes a branch WITHOUT an await, the resume
skips directly into the state's continuation code — with `cond_branch_0`
still holding the stale `12` from the earlier iteration. The cleanup block
re-executes and re-drops every RC slot it names. Breakpoint counting showed
the same list pointer hitting the cleanup decr twice within one resume
invocation.

Pre-existing and previously invisible: each awaited RC result carried one
LEAKED count (the future's dispose never dropped `sm->result`), which
absorbed exactly one extra drop. Making the dispose real
(issues/async-future-result-never-dropped.md) turned the double cleanup into
a use-after-free.

## Fix

Consume the key once the guarded cleanup has run: emit
`sm->cond_branch_N = -1;` at the end of the block (non-chained, guarded form
only). A real re-selection of the branch re-assigns the field before the
next pass, so the cleanup still runs once per selection; stale passes now
skip it. Chained continuations keep the key — their next state's own guard
needs it, and their drops move to that state.

## Left open (noted, not changed)

The `skip_cond_branch_check` variant emits the same cleanup UNCONDITIONALLY
(`{ ... }` with no key) because a nested cond overwrote the field — that
form is still susceptible to the same re-entry double-drop if such a shape
can reach the continuation path twice; no failing shape is known today.

## Regression coverage

The walker repro above is exactly `tests/fs/walker.test.yo` ("walk lists all
entries recursively" followed by "walk_with max_depth limits traversal" in
one batch binary), which now gates this under CI's stage-1 suite. The fix
was verified with 20 clean plain runs + GuardMalloc runs of the previously
~50%-failing repro.
