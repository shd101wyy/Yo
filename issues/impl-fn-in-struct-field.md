# `Impl(Fn(...))` not allowed as a struct/object/enum/union field type

## Status

✅ Fixed by surfacing a clear evaluator error (no codegen change required).

## Symptom (before fix)

Storing an `Impl(Fn(...))` value in a struct field was accepted by the evaluator
but produced broken C output for any closure that captured variables. Example:

```rust
WithCb :: struct(
  value : i32,
  cb : Impl(Fn(x : i32) -> i32)
);

make_adder :: (fn(n : i32) -> WithCb) {
  WithCb(
    value: n,
    cb: ((x) => (x + n))   // closure captures `n`
  )
};

main :: (fn() -> unit) {
  obj := make_adder(i32(5));
  result := obj.cb(i32(10));
  assert((result == i32(15)), "closure captures n=5");
};

export main;
```

C compilation failed with:

```
error: no member named 'call' in 'struct __yo_struct_..._id_40_struct'
  int32_t _yo..._temp = (obj.cb).call((obj.cb).data, 10);
                        ~~~~~~~~ ^
```

The struct field `cb` was emitted as the closure's **capture struct** (which has
fields `n`, etc.), not as the Impl closure pair (`call`/`data`/`dispose`). Codegen
then tried to call `(obj.cb).call(...)` on the capture struct, which has no
`call` member.

## Root cause

`Impl(Fn(...))` is a `SomeType` whose runtime layout is the closure's
capture struct (just like Rust's `impl Fn`). Each anonymous closure has a
**unique** type with a **capture-dependent size**, so a struct field typed as
`Impl(Fn(...))` has no fixed size — different closures assigned to the same
field would have different layouts. The codegen path special-cased `Impl(Fn)`
**locals** but not **fields**, hence the broken member access.

This is the same restriction Rust enforces:

```rust
struct S { f: impl Fn() }   // error[E0562]: `impl Trait` only allowed in
                            // function/inherent method return types
```

## Fix

`src/evaluator/types/field.ts` now rejects any `struct`, `enum`, or `union`
field whose type is `SomeType` implementing `Fn` (i.e., `Impl(Fn(...))`). The
error message is actionable:

```
Cannot use Impl(Fn(...)) as a field type:
  Impl(Fn(x : i32) -> i32)

Each closure has a unique anonymous type with a capture-dependent size, so an
Impl(Fn(...)) field has no fixed runtime size.

Options:
  - Use Dyn(Fn(...)) for a heap-allocated, type-erased closure
    (and wrap the value with dyn(...)).
  - Make the containing type generic over a closure type parameter, e.g.
      MyStruct :: (fn(comptime(F) : Type) -> comptime(Type))(struct(cb : F));
```

## Workarounds (in user code)

### Option A — `Dyn(Fn(...))` (boxed, type-erased)

```rust
WithCb :: struct(
  value : i32,
  cb : Dyn(Fn(x : i32) -> i32)
);

make_adder :: (fn(n : i32) -> WithCb) {
  WithCb(
    value: n,
    cb: dyn((x) => (x + n))   // explicit dyn() wrap required
  )
};
```

### Option B — generic over the closure type

```rust
WithCb :: (fn(comptime(F) : Type) -> comptime(Type))(
  struct(value : i32, cb : F)
);
```

Each instantiation `WithCb(SomeClosureType)` is monomorphic and has a fixed
size — analogous to Rust's `struct WithCb<F: Fn(i32) -> i32> { cb: F }`.

## Tests

`tests/impl_fn_field_rejection.test.yo` — uses `comptime_expect_error` to
assert that struct/object/enum/union field types containing `Impl(Fn(...))`
are rejected, and that the `Dyn(Fn(...))` and generic-over-`F` workarounds
both compile and run correctly.

## Files changed

- `src/evaluator/types/field.ts` — added the field-type validation.
- `tests/impl_fn_field_rejection.test.yo` — regression coverage.
- `issues/impl-fn-in-struct-field.md` — this document.
