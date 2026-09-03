# A bare `(e) =>` io.async closure body never evaluates — it compiled to a runs-nothing future, silently

- **Status**: FIXED 2026-09-03 — the `.io` projection is now total: on a
  bare `Io` receiver it is the IDENTITY (evaluator +
  codegen `property_access.yo` twins), so the bundle-style body evaluates at
  def time and the future runs it. Pinned by the "bare-e closure with
  e.io.await body runs" test in tests/async_unit_tail_await.test.yo.
- **Found**: 2026-09-02, validating #390's poison gate against the test suite
  (`tests/async_unit_tail_await.test.yo`'s `outer_unit`, wasm + macOS legs).

## The shape

```rust
outer_unit :: (fn(io : Io) -> Impl(Future(unit)))(
  io.async((e) => e.io.await(inner_unit(io), e.io))
);
```

The closure parameter is BARE (`(e) =>`, no annotation). At the def-time
anon-body trial, `e`'s type is the io.async builtin's abstract effect-bundle
generic `E`, which is only bound at the call site when the future's expected
type carries a concrete effect (`Impl(Future(unit, IoExn))` does;
`Impl(Future(unit))` — the signature above — does not). `e.io.await(...)`
then fails to resolve:

```
[anon-swallow] Error: No matching call found with arguments:
((e.io).await)(inner_unit(io), (e.io))
```

The trial swallows it (correctly, by the deferral philosophy), and the body
never receives ExprInfo. Before #390, codegen's sync-future fallback emitted
a `_sync_fut_t` future whose resume called a closure C function whose body
statements were all skipped — the future ran nothing and completed, and
NOTHING checked the difference (the test's `assert(true, "completed")`
cannot). An ANNOTATED param (`(io2 : Io) =>`) evaluates the body at def time
and is the form every other async test uses; the test file was rewritten to
it in #390.

## What a real fix needs

Bind the effect bundle before the def-time trial when the ENCLOSING
signature declares the future's effect: `-> Impl(Future(T))` must give the
trial an `e` of the ambient `Io` bundle (the same Step-6b binding
`try_to_call_function_with_arguments` already does at call sites with
concrete expected types). Then the bare-`e` body evaluates at def time,
gets ExprInfo, and routes the state machine instead of the sync stub.

## Containment

Until that lands, the poison gate makes the silent form a compile error
with the "body was never fully evaluated" diagnostic, so no new silently-
vacuous bare-`e` code can ship. std/ and src/ are clean (the whole-compiler
self-compile passes the gate); the one test-file use was migrated.
