# An `Impl(Fn)` parameter captured by an `io.async` block is not in its capture struct

**Severity:** S2 — an Impl(Fn) param captured in io.async is emitted as a bare identifier — undeclared-identifier C error

**Status:** fixed 2026-09-30 (together with `issues/fixed/a-closure-bound-to-a-local-inside-an-io-async-body-emits-invalid-c.md`)
**Found:** 2026-09-12, writing `spawn_blocking` for waker step 5
(`plans/archive/WAKER_BASED_SCHEDULING.md`).
**Reproducer:** `issues/repros/impl-fn-param-captured-by-an-async-block.yo`

## Symptom

```
error: use of undeclared identifier 'cb'
```

in a state-machine resume function, from a capture-struct initializer the
resume function emits for a closure built INSIDE the async block:

```c
__yo_t_N __capture_closure_… = (__yo_t_N){
  .cb = cb,                                          // ← undeclared here
  .sink = (…)__yo_incr_rc_atomic(sm->var_chan_…),    // ← every OTHER capture
  .w    = (…)__yo_incr_rc_atomic(sm->var_w_…),       //    is read from the SM
  .owner = owner
};
```

## Shape

The enclosing function takes an `Impl(Fn)` parameter and returns an `io.async`
block that builds a closure over it:

```rust
relay :: (
  fn(generic(T : Type), cb : Impl(Fn() -> T, Send), io : Io,
     where(T <: (Send, Acyclic))) -> Impl(Future(T, Io))
)(
  io.async((io : Io) => {
    chan := Channel(T).new(usize(1));
    sink := chan;
    run_it(() => { sink.send(cb()); () });     // ← captures `cb`
    match(chan.try_recv(), .Ok(v) => v, .Err(_) => __yo_panic("no value"))
  })
);
```

`chan`/`sink` are ordinary locals of the async body and are emitted correctly
through `sm->var_…`. `cb` is the one capture that is a PARAMETER of the
enclosing function, and the one that renders as a bare identifier.

## Where it goes wrong

`_generate_sm_atom` (`src/codegen/exprs/atom.yo`) maps a name to its
state-machine slot and returns `.None` when the name is in neither the
analysis's captured variables nor the async block's `__capture` struct; the
caller (`src/codegen/exprs/closures.yo`, the capture-struct field initializer)
then falls back to `get_variable_name_for_codegen`, which yields the bare
source name.

The outer half of that map is built in `_build_combined_sm_variables`
(`src/codegen/async/state_machine.yo`) from the async closure's CAPTURE STRUCT
field labels — so the question is why `cb` is not a field of it. The likely
answer is that an `Impl(Fn)` parameter is bound VALUELESS by the specialization
binder (the finding behind
`issues/fixed/generic-channel-send-specialisation-is-called-but-never-emitted.md`),
and `enrich_captured_variables` (`src/evaluator/utils/closure.yo`) drops a
capture with no runtime value as compile-time-only. That is a hypothesis and
not measured — the measured facts are the two above.

A near neighbour that behaves DIFFERENTLY, and so is a useful contrast while
fixing this: calling `cb()` directly in the async body (no inner closure)
produces a different failure, `conflicting types for closure_yo_id_…`, rather
than an undeclared name.

## Impact

`std/thread.yo`'s `spawn_blocking` is written EAGERLY — the worker thread is
started in the function body, and the returned `io.async` block only awaits the
park — which is both the better semantics (Rust's `spawn_blocking` starts the
work immediately rather than on first poll) and outside the shape above. Any
API that wants to call a closure PARAMETER from inside its own async block hits
this.

## Re-verified 2026-09-28 (async state-machine audit)

Tree build of develop `af62bdb28`, and the v0.2.45 seed unless noted. See `plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.3.

**STILL REPRODUCES for the committed repro, but at a different site** (seed and tree build): `error: use of undeclared identifier 'cb'` in `.cb = cb`. It now fires in the SYNC-future closure (`closure_yo_id_…`, a body with no await), which never reads `closure_context`. With an `io.await` added (the resume-function shape the doc describes), it works (`n=42`). What remains: `generate_io_async_sync_call` plus the capture-init fallback, i.e. the io.async closure's transitive capture of an `Impl(Fn)` parameter.

## Fix (2026-09-29, async state-machine plan)

A closure built inside a no-await `io.async` block initialized its capture struct with a bare name for a variable the block itself captured. The fallback in `generate_closure_construction` (`src/codegen/exprs/closures.yo`) now reads it through `closure_context`, with the same membership test `generate_atom` uses (`_enclosing_closure_capture_read`). Test: `tests/async_await.test.yo` "an Impl(Fn) parameter captured inside a no-await io.async block" (a C compile error on the v0.2.45 seed).

**Measured independently (2026-09-30).** The root cause was also measured on
the `fix/closure-local-in-io-async` branch (PR #1031) before #1018 landed.
`YO_DEBUG_CAPTURE=1` showed the block's read of `cb` tracked only in the
inner closure's body context, which is the capture-propagation gap that
`propagate_captures_to_enclosing` closes
(`issues/fixed/a-closure-capture-reaches-its-enclosing-closure-only-when-it-is-rc.md`).
That branch carries this repro's shape as a case in
`tests/closure_inside_io_async.test.yo`. It fails to compile on the v0.2.46
seed. The PR's gate re-runs it on the merged tree, where develop's mechanism
replaces the branch's own.
