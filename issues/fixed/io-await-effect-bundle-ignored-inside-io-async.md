# Inside an `io.async` body, `e.io.await(fut, bundle)` ignores `bundle` — throws route to the enclosing task's handlers

**Status: FIXED** (2026-08-29, `src/codegen/async/state_machine.yo`
`emit_effect_injection_for_sm`: when the await call names a bundle, that
bundle is materialized into a temp of its own recorded type and injected via
`set_effect("__bundle")` — the top-level path's behaviour — instead of the
enclosing state machine's own bundle field; only an await WITHOUT a bundle
argument forwards the task's bundle). Regression test:
`tests/async_await.test.yo` "io.await inside an async body injects the bundle
named at the await, not the task's own" (inner handler resumes with 7 →
`Some(8)`; the task's own would have unwound → `None`). Found 2026-08-29 writing the chunked-body tests for `std/http`.
**Severity:** MEDIUM-HIGH — effect routing is silently wrong: a handler
installed for one awaited future never runs, the enclosing task's handler
runs instead (and, unwinding, kills the whole task).

## Reproducer

`issues/repros/io-await-bundle-ignored-inside-io-async.yo`:

```rust
outer_task :: (fn(log : ArrayList(String), io : Io) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    inner_exn := Exception(throw : ((err) -> { unwind(()); }));
    inner := IoExn(io : e.io, exn : inner_exn);
    r := e.io.await(thrower(e.io), inner);   // thrower does e.exn.throw(...)
    log.push(`inner returned ${r}`);
  })
);
h := io.spawn(outer_task(log, io), IoExn(io : io, exn : outer_exn));
```

Expected (docs/en-US/ALGEBRAIC_EFFECTS.md "Async + effects": the bundle
passed to `io.await` supplies the awaited future's handlers): `inner_exn`
runs and unwinds `outer_task` at the await. Observed: `OUTER handler got:
bang` — the task's own bundle handled the throw; `inner_exn` never ran.

At top level (`io.await(fut, bundle)` outside any `io.async`) the bundle IS
honoured — `tests/http/http.test.yo`'s limit tests rely on it.

## Root cause (confirmed)

`emit_effect_injection_for_sm` (the cold-start injection for a future awaited
inside a state machine) handled a struct-typed effect by
`find_bundle_field_name(...)` — the SM's OWN captured bundle (`&sm->__yo_param_0`
in the emitted C) — and never looked at the await call's second argument; the
evaluator accepted the argument (it type-checks against `E`) and codegen
dropped it. The top-level `emit_effect_injection_for_await` (exprs/await.yo)
already generated the argument into a temp; the SM path now does the same.

## Test restructure that predates the fix

`std` never needed a workaround; `tests/http/http.test.yo`'s malformed-chunk test was
restructured to spawn the throwing fetch as its own task (its bundle is the
spawn's, which IS honoured) and to read `JoinHandle.await`'s `None` for the
unwound task.
