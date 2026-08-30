# A ctl handler returned OUT of the fn that defines it is untypeable — and the def-eval swallow made it silently hollow

**Status: FIXED (2026-08-30).** The evaluator now rejects the escape at
DEFINITION time: a fn whose declared result type is control-bound
(`type_is_control_bound` — transitively contains a `ctl(...) -> ret` field)
errors in `evaluate_anonymous_function_implementation`
(`src/evaluator/values/anonymous_function.yo`, next to the `ctl_force`
computation, OUTSIDE the def-eval trial swallow). ctl handlers themselves are
exempt (their result flows DOWN into the still-live throw frame), and SomeT
results are conservatively not control-bound, so generic and
`Impl(Future(...))` async results are unaffected.

En route, the "ctl rule 8" tests in `tests/algebraic_effects.test.yo` turned
out to be passing only in `comptime_expect_error`'s PROPAGATE mode — outside
it the def-eval trial swallow accepted the same shapes silently (a standalone
`fn() -> (ctl(msg : String) -> i32)` returning a local handler compiled
clean). The new definition-time check makes them fail for the stated reason
in every mode; a third rule-8 test pins the `fn() -> Exception` helper shape.
Eleven test files still using the hollow `_exn()`/`_noexn()`/`_ioexn(io)`
helper idiom were rewritten to per-test inline installs.

Residual (separate hole, same family): a MODULE-LEVEL
`(g : Exception) = Exception(throw : ...)` binding is still accepted even
though escape boundary 2 should reject it — the pointer rule proves
`type_is_control_bound(Exception)` is true, so the module-level rule's
`rhs_info.ty` must be losing the type;
issues/module-level-control-bound-binding-not-rejected.md.

Found 2026-08-29 by the C22 stub gate: `tests/http/server.test.yo`'s

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
