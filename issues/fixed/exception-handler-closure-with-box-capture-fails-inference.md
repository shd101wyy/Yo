# An `Exception(throw : (err) -> {…})` handler that assigns a captured `Box` fails to type — `Type mismatch for type member "throw" … Got: Type(1)`

**Found**: 2026-08-28 while writing the C33 http tests. **Status**: **CLOSED
2026-08-29 — BY DESIGN, diagnostic FIXED.** Measured on the current compiler:
the handler fails for ANY runtime capture — a plain read (`consume(n)`), a
module-level runtime global (`g_flag = true`), `thrown.set(true)` — and works
for a comptime constant. That is the documented rule: `Exception.throw` is a
`ctl` field and handlers are `->` functions, which are capture-free
(docs/en-US/ALGEBRAIC_EFFECTS.md rule 4 / plans/archive/EXPLICIT_EFFECTS.md
§4: "Handlers must be bare (non-capturing) anonymous functions"). The
anonymous-function evaluator already rejects it with a precise message —
"A regular function (using ->) cannot capture outer runtime variables:
thrown …" — but the struct-member argument site evaluated the handler through
the def-eval SWALLOW (`evaluate_expression`, which eats every error) and then
reported only "Failed to evaluate argument expression" (earlier compilers:
"Type mismatch … Got: Type(1)"). Fix: `src/evaluator/calls/type.yo` evaluates
struct-literal member args through `evaluate_expression_raw` with the caller's
handler, so the real diagnostic propagates; the message itself now names
`unwind` (not the retired `escape`) and says what a handler MAY use. Pinned by
the cli-case `tests/cli-cases/check-handler-captures-runtime-local`. The
idiom for "record that the handler ran" is the one the http tests and the
compiler's `_probe_*` helpers use: derive it after the guarded call (the
handler unwinds past the code that would have recorded success). Original
record follows.

`yo check` reported it, so it was loud, but the message named
`Type(1)` and pointed at the file's first line, not at the handler.

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
