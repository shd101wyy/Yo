# A `=>` closure argument inside an `io.async` body loses the future's result type

**Status: OPEN** (found 2026-09-11 while implementing `std/async/stream.yo`,
`plans/reference/ASYNC_ITERATION_STREAM.md`). **Severity:** MEDIUM — the error
lands on the caller's `await`, nowhere near the closure, and the working
spelling (build the chain outside the async body, or use a `fn` literal) is
not discoverable from the message.

## Symptom

Passing an `=>` closure to a generic callback parameter from INSIDE an
`io.async` body compiles the body but leaves the enclosing future's result
type unresolved, so the SPAWN SITE fails:

```
error: No matching call found with arguments:
(h.await)(io)
```

Minimal reproducer:
`issues/repros/closure-argument-inside-an-io-async-body-loses-the-future-result-type.yo`

```rust
task := io.async((io : Io) => {
  r := apply(i32(5), x => (x + i32(1)));   // generic callee, closure argument
  r
});
h := io.spawn(task, io);
got := h.await(io);            // error[no matching call]: (h.await)(io)
```

Three one-line variations that all COMPILE and run, which is what pins the
trigger to "closure argument + generic callee + inside an async body":

| variation | result |
| --- | --- |
| `apply(i32(5), (fn(x : i32) -> i32)(x + i32(1)))` — `fn` literal, same place | works, prints 6 |
| the same closure call moved OUTSIDE the `io.async` body | works |
| a generic call with no callback argument inside the body (`mk(i32(7))` returning `Wrap(i32)`) | works |

## Why it matters

It is exactly the shape a stream/iterator chain has:
`s.map(x => …).collect(io)` written inside a task body. The workaround is to
build the chain in the enclosing scope and await it inside the task — which
works, and is what `std/async/stream.yo`'s doc and `tests/async/*.test.yo`
now say to do — but the failure mode (an error attributed to `await`, on a
line that mentions neither the closure nor the generic call) costs a session
to diagnose.

## Suspected root cause (NOT yet confirmed)

The async body is evaluated as a deferred trial (the same swallow that makes
`yo check` blind to async bodies — see the testing instructions' table). A
closure argument whose result type must be bound into the generic callee's
type variable is synthesized during that trial; the binding does not survive
into the state-machine's own env, so the body's tail type stays an unresolved
SomeT and the future is typed `Future(<unresolved>, Io)`. The
`No matching call` on `await` is that unresolved carrier reaching a method
lookup. `plans/backlog/DEFTIME_BODY_EVAL.md` and
`issues/fixed/generic-impl-async-method-closure-param-return-type-collapse.md`
(C27) are the neighbourhood — C27 was the same family, one substitution
channel over.

## Next step

Instrument the deferred-trial path in `src/evaluator/calls/` for the
closure-argument case and compare the bound result type inside the trial with
the one the spawn site reads. The C27 fix is the model.
