# A nested `io.async` closure inside an `io.async` body fails definition-time evaluation

**Status: FIXED (2026-08-30).** `try_to_call_function_with_arguments` gained a
Step 6b-nested fallback (`src/evaluator/calls/helper.yo`): an `io.async` call
whose expected type carried no concrete bundle binds `E` from the RECEIVER
expression — `e` for `e.io.async(...)` (the field-access base), the receiver
itself for a bare `io.async(...)` variable — since the nested future is
awaited with the enclosing bundle, making that bundle the only consistent
`E`. Guards: skipped when `E` is already concretely bound (every working
expected-type flow untouched), when the derived type is itself a SomeT (an
unbound outer trial), and when the closure argument ANNOTATES its parameter
(`(ctx : Ctx) => ...` — the annotation binds `E` through argument
unification, and pre-binding from the receiver made that unification fail).
Both nested shapes compile and run; `tests/async_await.test.yo`'s event-loop
regression test now uses the inline nested form it always wanted, plus a new
`e.io.async` IoExn-bundle test.
 Split out of
`issues/fixed/closure-nested-inside-io-async-closure-body-emits-abort-stub.md`
(2026-08-29). **Severity:** MEDIUM — the shape is idiomatic (`inner :=
io.async(...)` awaited from the enclosing body) and the spelling that works is
to hoist the inner body to a top-level `fn` returning `Impl(Future(...))`.

## Repro

```rust
two_hop :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io) => {
    inner := io.async((io) => {
      io.await(sleep(u64(1)), io);
      return(i32(1));
    });
    v := io.await(inner, io);
    return(v + i32(41));
  })
);
```

`YO_DEBUG_SWALLOW=1 yo check` shows the inner body's trial evaluation failing:

```
[anon-swallow] Error: No matching call found with arguments:
(io.await)(sleep(u64(1)), io)
```

— inside the INNER closure `io` is the inner bundle parameter, whose type is
the `io.async` effect generic `E`; during the OUTER body's definition-time
trial that `E` is not bound (the outer closure's own `io` is itself the outer
SM's bundle parameter), so `io.await` on it has no receiver type. Before the
C22 fix the inner closure was emitted as a unit-returning body (`return;` in a
non-void C function — clang error) or an `abort()` stub; now `yo compile`
reports the untranspiled body.

## Fix direction

Bind the nested `io.async` closure's effect parameter from the ENCLOSING
async body's bundle type when the call's receiver is the enclosing bundle's
`.io` (the outer closure's `E` is known at that point — it is the type the
enclosing `io.async` call was specialized with), the same resolution the
top-level `io.async(closure)` call performs through `expected_type_env`.

## Test

`tests/async_await.test.yo`'s event-loop regression test wanted exactly this
shape and hoists `one_after_timer` to a top-level fn instead; switch it back
when this lands.
