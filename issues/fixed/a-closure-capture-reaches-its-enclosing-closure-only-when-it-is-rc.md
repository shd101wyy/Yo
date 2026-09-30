# A closure's capture reaches its enclosing closure only when it is RC

**Severity:** S2. A generic function whose `io.async` body builds a closure that captures an `Impl(Fn)` parameter fails the C compile (`initializing 'void *' with an expression of incompatible type`).

## Reproducer

```rust
_run_it :: (fn(f : Impl(Fn() -> unit, Send)) -> unit)(f());
_relay :: (
  fn(generic(T : Type), cb : Impl(Fn() -> T, Send), io : Io, where(T <: (Send, Acyclic))) -> Impl(Future(T, Io))
)(
  io.async((io : Io) => {
    chan := SyncChannel(T).new(usize(1));
    sink := chan;
    _run_it(() => {
      sink.send(cb());
      ()
    });
    match(chan.try_recv(), .Ok(v) => v, .Err(_) => __yo_panic("no value"))
  })
);
// io.await(_relay(() => i32(42), io), io) == i32(42)
```

`tests/async_await.test.yo`, "an Impl(Fn) parameter captured inside a no-await io.async block".

## Cause

The inner closure captures `cb` from outside the `io.async` closure, so the `io.async` closure's capture struct must hold `cb` as well. Nothing recorded that explicitly. The inner closure's capture of `cb` reached the enclosing closure only as a side effect of evaluating the inner capture's `___dup(cb)` initializer in the enclosing context, and `generate_captured_variable_dup_expressions` builds a dup only for an RC-typed capture.

- In the definition-time evaluation, `cb` is an abstract SomeT, which counts as RC. The dup was evaluated and `cb` was recorded.
- In the specialization, `cb` is bound to the argument's capture struct, which is zero-size and not RC. So the `io.async` closure recorded no captures (`YO_DEBUG_CAPTURE`: an empty capture key at the block's position).
- Codegen then used the definition-time capture struct, whose `cb` field is the declared SomeT. Until #975 retired the id-keyed SomeT registry, that SomeT's id resolved to the argument's capture struct. After it, the field lowers to `void*`.

The seed (v0.2.46, before #975) showed only the separate `cb`-undeclared bug that `issues/fixed/impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct.md` fixes. The two are independent.

## Fix

`propagate_captures_to_enclosing` (`src/evaluator/utils/closure.yo`) re-tracks each capture of a just-built closure in the enclosing evaluation context, through `track_variable_usage_resolved`. That keeps only names from outside the enclosing body and drops its own parameters, as for an identifier read. Both closure-building paths call it: `anonymous_function.yo`, for an `=>` closure, and `calls/closure_type.yo`. The enclosing capture struct no longer depends on the capture's type.
