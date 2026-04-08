# Inherent impl methods vs trait impl methods ambiguity

## Summary

When a type has both an inherent (non-trait) impl method and a trait impl method with the same name, the evaluator reports an "Ambiguous call" error instead of preferring the inherent method.

## Trigger

Commit `a7009e17` added a fallback in `getValueOfSomeTypeFromEnv` (env-lookup.ts) that correctly resolves SomeTypes after `synthesizeTypes` overwrites self-referential bindings. This fallback is essential for prelude compilation (e.g., `_Self` resolution for operator implementations). However, the improved resolution caused `tryMatchGenericImpl` to succeed for trait impls that previously didn't match, exposing this latent ambiguity bug.

## Example

```rust
// Prelude defines an inherent map on Option(T):
impl(forall(T), Option(T),
  map : (fn(forall(comptime(B) : Type), self : Self, f : Impl(Fn(a : T) -> B)) -> Option(B))(...)
)

// HKT test defines Functor trait with map:
impl(forall(A), Option(A), Functor(Option)(
  map : (fn(forall(A, B), self : Option(A), f : (fn(a : A) -> B)) -> Option(B))(...)
))

// This call finds both maps and reports ambiguity:
x.map(forall(i32), (fn(a: i32) -> i32)((a + i32(1))))
```

## Root cause

`findMethodsFromGenericImpls` collected all matching methods from both inherent impls and trait impls into the same array without any priority ordering. When both provided the same method name, the caller saw multiple candidates and reported ambiguity.

## Fix

Added inherent method priority in `findMethodsFromGenericImpls`: if the same method name is found from both inherent (anonymous trait, `typeName === undefined`) impls and named trait impls, only the inherent impl versions are returned. This mirrors Rust's behavior where inherent methods shadow trait methods.

## Files changed

- `src/evaluator/values/impl.ts`: Track `isInherentImpl` per method, filter out trait impl methods when inherent methods exist.
