# `if(io.await(…), …)` inside a `match` arm is rejected with E0904 although the await IS the first condition

**Severity:** S2 — an `if(await(...))` whose await IS the first condition is wrongly rejected with a misleading E0904 when the `if` sits inside a match arm

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit
(`plans/ASYNC_STATE_MACHINE_GENERATION.md`), while re-checking
`issues/retired/yoself-accepts-await-in-cond-that-ts-rejects.md`. Tree build of
develop `af62bdb28`.

## Symptom

```rust
match(opt, .Some(d) => { if(e.io.await(_f(d, e.io), e.io), { hits = (hits + i32(10)); }); }, .None => ());
```

```
error[E0904]: `io.await` in a `cond` condition inside an `io.async` block must BE the
first condition — it cannot be nested inside a larger expression, and it cannot be in
a later branch.
  --> …:7:34
```

The same `if(e.io.await(…), …)` as a top-level statement of the
`io.async` body compiles and runs correctly. That is the documented,
supported shape (`docs/en-US/ASYNC_AWAIT.md`, "Where `await` may appear").
Inside the match arm, the await is still the first and only condition, so
the message describes a mistake the user did not make.

Reproducer: `issues/repros/if-await-in-a-match-arm-is-rejected-as-a-later-cond-branch.yo`.

## Root cause

A condition await is compiled by hoisting: `hoist_non_splittable_awaits`
(`src/codegen/async/state_code_gen.yo`) moves the enclosing expression into
the next state, where the condition reads `sm->await_result_N`. The hoist
only inspects the LAST TOP-LEVEL expression of each segment
(`segment.expressions[last]`). A condition await nested inside a `match` or
`cond` arm is never hoisted. `_generate_cond_with_await_impl` then finds the
await still in condition position with no substitution and raises the
generic E0904.

This is one instance of the general limitation in
`plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.1: every rewrite in the
splitter works on top-level statements only, and nesting falls through to
a different, less complete path.

## Fix direction

Short term: apply the hoist recursively inside awaiting arms (the arm body
is itself a statement list with its own "previous state"), or make the
diagnostic say that condition awaits are only supported at the top level of
the `io.async` body.

Long term: the phase-1 normalisation in the plan puts every await in
statement position before splitting, which makes this shape (and E0904)
disappear.

## Fix (2026-09-29, async state-machine plan phase 5)

The segment lowering this shape broke is deleted. An `io.async` body is now
emitted once, by the ordinary expression generators, into its resume
function: each await suspends where it is written and resumes at its own
label, and every local, pattern binding and await result lives in the task
(`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5).

Regression tests (each fails on the v0.2.45 seed): `tests/async_await.test.yo` "an if whose condition awaits, inside a match arm".
