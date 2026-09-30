# A `unit` parameter captured by an `io.async` body emits an initializer for an erased field

**Severity:** S2. An async function with a `unit` parameter that its `io.async` body reads fails the C compile.

**Status: FIXED (2026-10-01).** Found while re-verifying the async row of `issues/unit-zst-residual-gaps.md`. The v0.2.46 seed and develop `29bf728b4` both fail.

## Symptom

```rust
_a :: (fn(u : unit, io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => {
    e.await(yield(e), e);
    _w := _id(u);
    i32(1)
  })
);
```

clang: `error: field designator 'u' does not refer to any field in type '__yo_t_…'`.

## Cause

The capture struct's emitter erases a unit field, so the struct is member-less (`uint8_t _zst_dummy;`). But both capture-literal builders in `src/codegen/exprs/async.yo` emitted `.${label} = …` for every field:
- `_build_async_capture_struct_literal`;
- the label literal of `generate_io_async_sync_call`.

## Fix

Both builders skip a unit-typed field.

Test in `tests/async_await.test.yo`: "a unit parameter captured by an io.async body".
