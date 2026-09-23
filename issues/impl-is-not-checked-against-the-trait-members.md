# `impl(T, Trait(...))` is never checked against the trait: missing members and wrong signatures pass

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** OPEN. Soundness/diagnostics hole: the error, if any, appears at an unrelated call site.
**Measured:** yo 0.2.39 seed.

## Repro 1: a required member is missing

```rust
Foo :: trait(f : (fn(self : Self) -> i32), g : (fn(self : Self) -> i32));
P :: struct(x : i32);
impl(P, Foo(f : (self -> self.x)));
main :: (fn() -> unit)({ p := P(x : i32(1)); p.f(); });
export(main);
```

`yo check`: `evaluator OK`. `P` is registered as implementing `Foo` without `g`. Calling `p.g()`
later reports `error[E0610]: No matching call found`, which names neither the trait nor the impl.

## Repro 2: a member with the wrong signature

```rust
Foo :: trait(f : (fn(self : Self) -> i32));
P :: struct(x : i32);
impl(P, Foo(f : (fn(self : Self) -> bool)(true)));
main :: (fn() -> unit)({ p := P(x : i32(1)); p.f(); });
export(main);
```

`yo check`: `evaluator OK`. A wrong arity, `f : (fn(self : Self) -> i32)` against a trait member
`(fn(self : Self, k : i32) -> i32)`, is also accepted until a call reports E0603.

## Mechanism (READ)

- The only code that checks "member not provided"
  (`Trait member "X" is not provided and has no required/default value.`), unknown labels, and
  member type compatibility (`Type mismatch for the trait member`) is
  `try_to_implement_trait_with_arguments_by_trait_type`
  (`src/evaluator/calls/trait_type.yo` ~409-459).
- It is reached only when a trait constructor is *called as a value*
  (`src/evaluator/calls/function.yo` ~4577). The `impl` path in `src/evaluator/values/impl.yo`
  (~4374) collects the colon pairs into `method_exprs` and registers them without calling it.

## Fix direction

After collecting `method_exprs` in `impl.yo`, walk the trait's `field_labels`/`field_types`:
error on a missing label that has no default, on an unknown label, and when the provided member's
type is not compatible with the trait member type after `Self` substitution. Reuse the messages
from `trait_type.yo` and give them a code.
