# A module-level global referenced inside an io.async closure body emits undeclared-identifier C

- **Status**: FIXED 2026-09-03 — `trackVariableUsage` (src/evaluator/context.yo)
  now excludes module-level globals from closure captures (keyed on the
  `is_module_level_global` registry): a module global lowers to a
  process-global C symbol, so closures reference it directly instead of
  capturing. Measured wider than the async shape: a plain inline anon
  closure referencing a module global broke identically. Pinned by arms in
  tests/closure.test.yo and tests/async_await.test.yo.
- **Found**: 2026-09-03, building the bare-`e` repro for
  `issues/fixed/io-async-bare-e-closure-body-never-evaluates.md` (PR #394).

## Reproducer

```rust
{ AtomicI32, MemoryOrder } :: import("std/sync/atomic");

counter := AtomicI32(i32(0));

annotated_unit :: (fn(io : Io) -> Impl(Future(unit)))(
  io.async((io2 : Io) => { counter.fetch_add(i32(1), MemoryOrder.Relaxed); () })
);

main :: (fn(io : Io) -> unit)({
  io.await(annotated_unit(io), io);
});
export(main);
```

`yo compile` fails at the C level — the async closure's emission references
the module global TWO incompatible ways at once:

```
error: use of undeclared identifier 'counter'
error: no member named 'counter_m8791753955306202863' in 'struct __yo_t14_struct'
```

The capture machinery routes the module-level binding into the closure's
capture struct (the `counter_m<hash>` member — the module-global C-name
mangling from `issues/fixed/module-global-c-names-are-not-namespaced.md`)
while at least one use site emits the RAW name `counter`. Note the ANNOTATED
closure form fails identically — this is not the bare-`e` class.

Workaround used by every existing async test: reference only fn-locals and
params inside async closure bodies (the `Box`-local pattern of
`tests/async_await.test.yo`).

## Where to look

The async state-machine / sync-future closure capture collection: a binding
that is MODULE-level should not be captured at all (it is process-global in
C) — the capture filter probably tests "not in the closure's local frames"
and misses the module-global registry.
