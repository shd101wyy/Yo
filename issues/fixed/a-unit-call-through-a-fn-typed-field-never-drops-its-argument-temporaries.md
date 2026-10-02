# A unit call through a fn-typed field never drops its argument temporaries

**Severity:** S2. Each unit-returning call through a fn-typed struct field, used as a bare function body, leaks the temporaries built for its arguments.

**Status: FIXED (2026-10-01).** This is the long-standing leak behind `tests/async_await.test.yo`'s "Test Future with multiple effect row spreads", which fails under leak verdicts on the v0.2.46 seed and on develop `29bf728b4`.

## Symptom

```rust
Log :: (fn(msg : String) -> unit);
LogBundle :: struct(log : Log);
might_log :: (fn(e : LogBundle) -> unit)(e.log(`logged something`));
```

Valgrind: `48 (32 direct, 16 indirect) bytes definitely lost`, the `String` argument. The same call is clean in a block body `{ e.log(`x`); }`, through a fn parameter, or as a direct call.

## Cause

The fn-pointer call path in `src/codegen/exprs/other_fn_call.yo` emitted a unit call as a statement, followed by a flush of the call node's deferred drops, only when the callee may unwind. A plain fn-typed field may not, so the call came back as an inline expression.

The bare unit body emitter (`src/codegen/functions/generation.yo`) relies on that post-call flush:
- before the statement it flushes too early, while the temp is still undeclared, so the gate skips the drop;
- after it, it flushes only the parameters' drops.

So nothing dropped the argument temp.

## Fix

A unit call through a function pointer is always a statement followed by its deferred-drop flush. This is the contract of the registered direct-call unit path. The escape clear and check are emitted only when the call may unwind. `emitted_deferred_drop_ids` keeps a block epilogue from emitting the drop a second time.

Test in `tests/closure.test.yo`: "a unit call through a fn-typed field releases its argument temporary".
