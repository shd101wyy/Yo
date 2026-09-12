# An `Impl(Fn)` parameter captured by an `io.async` block is not in its capture struct

**Status:** open
**Found:** 2026-09-12, writing `spawn_blocking` for waker step 5
(`plans/WAKER_BASED_SCHEDULING.md`).
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
