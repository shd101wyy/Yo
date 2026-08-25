# `(T <: Trait).static_method()` bound `Self` to the TRAIT, not to `T`

**Status:** FIXED 2026-08-25.
**Found:** 2026-08-25, implementing `derive(Default)` (STD_API_AUDIT D3.1).
**Severity:** blocks every generic static trait method that constructs `Self`,
including the two derive rules that generate one.

## Symptom

A generic `impl` of a trait method with **no `self` parameter**, whose body
constructs through `Self(...)`, fails under the explicit-dispatch form:

```rust
GBox :: (fn(comptime(T) : Type) -> comptime(Type))(struct(value : T));
impl(
  generic(T : Type), where(T <: Default), GBox(T),
  Default(default : (fn() -> Self)(Self(value : (T <: Default).default())))
);

(GBox(i32) <: Default).default();   // Error: Receiver type is undefined when
                                    // implementing trait.
GBox(i32).default();                // fine
```

The failure is at INSTANTIATION, not definition — defining the impl and never
calling it is clean.

## Isolation

| shape | result |
| --- | --- |
| non-generic impl, `Self(...)`, either form | OK |
| generic impl, INHERENT static, `Self(...)`, plain dot | OK |
| generic impl, TRAIT static, `Self(...)`, plain dot | OK |
| generic impl, TRAIT static, `Self(...)`, **`<:` form** | **FAILS** |
| generic impl, TRAIT static, `GBox(T)(...)`, `<:` form | OK |

So neither genericity, nor the `where` clause, nor staticness alone is the
trigger: it is the `<:` dispatch form combined with a `Self` constructor.

## Root cause

`evaluate_subtype_of` (src/evaluator/exprs/subtype_of.yo) lowers `T <: Trait`
to the trait type with the receiver parked in its `is_concrete` slot — what TS
called `receiverType`.

`_static_dot_receiver_self_type` (src/evaluator/calls/function.yo) then binds
`ctx.self_type` for the method body from the dot-receiver's `TypeVal`, and
returned that value **verbatim**. For `T.method()` the TypeVal is `T`, which is
correct. For `(T <: Trait).method()` the TypeVal is the *trait*, so `Self` bound
to the trait — and `Self(value : ...)` then read as a trait IMPLEMENTATION,
reaching `try_to_implement_trait_with_arguments_by_trait_type`, which throws
"Receiver type is undefined" because `ctx.receiver_type` is never set on that
path.

An instance method never hit this: it has a `self` argument, so `Self` is
recovered from the argument's concrete type instead.

## Fix

`_static_dot_receiver_self_type` unwraps one level: when the dot-receiver's
TypeVal is a `TraitT` carrying a concrete receiver, `Self` binds to that
receiver rather than to the trait. The explicit-dispatch form now agrees with
the plain `T.static_method()` form.

## Test

`tests/impl.test.yo` — "explicit `<:` dispatch of a generic static binds Self to
the receiver", which asserts both forms and cross-checks them against each other.
