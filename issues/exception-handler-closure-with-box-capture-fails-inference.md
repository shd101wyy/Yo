# An `Exception(throw : (err) -> {…})` handler that assigns a captured `Box` fails to type — `Type mismatch for type member "throw" … Got: Type(1)`

**Found**: 2026-08-28 while writing the C33 http tests. **Status**: OPEN
(evaluator). `yo check` reports it, so it is loud, but the message names
`Type(1)` and points at the file's first line, not at the handler.

## Reproducer

`issues/repros/exception-handler-box-capture-inference.yo`:

```rust
main :: (fn() -> unit)({
  thrown := Box(bool)(false);
  exn := Exception(
    throw : (
      (err) -> {
        msg := err.to_string();
        assert(msg.contains(`kaboom`), `got: ${msg}`);
        thrown.* = true;          // ← remove this line and it type-checks
        unwind(());
      }
    )
  );
  _r := boom(exn);
  assert(false, "must throw");
  ()
});
```

```
check: error in: Error: Type mismatch for type member "throw":
Expected: fn(generic(ResumeType) error : dyn(Error + ToString)) -> ResumeType
Got:   Type(1)
```

The identical handler without the `thrown.* = true` assignment (as every
`tests/**` handler that only asserts and unwinds) is accepted. A `Box` written
inside an `io.async` closure is fine (tests/async/combinators.test.yo `ran.*
= true`), so it is specifically the handler closure — the one typed against the
`Exception` struct's generic `throw` field — whose inference collapses to a
`Type` value once it contains a deref-assignment to a captured `Box`.

## Impact

Tests that want to record "the handler ran" through a flag cannot; the
workaround is to rely on the `assert(false, "must throw")` after the call and
the assert inside the handler, which is what the http tests do.
