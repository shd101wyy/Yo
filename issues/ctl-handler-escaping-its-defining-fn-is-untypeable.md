# A ctl handler returned OUT of the fn that defines it is untypeable — and the def-eval swallow made it silently hollow

**Status: OPEN** (the evaluator accepts the shape; the one std-adjacent use was
rewritten). Found 2026-08-29 by the C22 stub gate: `tests/http/server.test.yo`'s

```rust
_exn :: (fn() -> Exception)(
  Exception(throw : ((err) -> { assert(false, ...); unwind(()); }))
);
```

failed to batch-compile once live value-returning stubs became fatal.

## What is wrong with the shape

A ctl handler is FRAME-BOUND: `unwind` exits the fn its record is installed
in at the throw site. A handler defined inside `_exn` and returned in the
record has no knowable install frame at definition time, so the def-time
trial types its `unwind(())` against the only enclosing fn it can see —
`_exn` itself (`Expected: Exception, Got: unit`) — fails, and the swallow
left the handler body hollow: **the emitted handler was missing its `unwind`
statement entirely** (pre-C22-gate it shipped silently; a handler that RAN
would fall off the end instead of unwinding). Batch-composition side effects
of the same def-eval failure also produced misleading `Type mismatch for
parameter "fut"` errors under `--test-name-pattern` filters.

Closures are already forbidden from CAPTURING control-bound values
("the captured value would escape its install frame"); RETURNING a record
whose field is a ctl handler is the same escape through a different door.

## What should happen

Either reject the escape (a fn whose return type transitively contains a
`ctl(...)` field and whose returned value carries a handler defined in its
own body), or defer the handler's unwind typing to install sites. Rejection
matches the existing closure-capture rule; passing records DOWNWARD
(parameters — every `{ io, exn }` bundle) stays legal, it is only the upward
direction that dangles.

## The rewrite

`tests/http/server.test.yo` installs its handlers inline per test (the idiom
every other test file uses); the batch compiles and all 8 tests pass under
the stub gate.
