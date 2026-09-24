# An `-> Impl(Trait)` return bound is never checked against the body

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** FIXED 2026-09-24 (Phase 2.2 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Originally OPEN: green `yo check`, then an internal compiler error in `yo compile`.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
Foo :: trait(f : (fn(self : Self) -> i32));
P :: struct(x : i32);
Q :: struct(y : i32);
impl(P, Foo(f : (self -> self.x)));
bad :: (fn() -> Impl(Foo))(Q(y : i32(4)));
main :: (fn() -> unit)({ w := bad().f(); });
export(main);
```

`yo check`: `evaluator OK`. `yo compile`:

```
yo: error: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

In parameter position the check exists but reports the wrong thing: passing `Q` to
`take(v : Impl(Foo))` gives `E0610 No matching call (v.f)()` rather than "Q does not implement Foo".

## Fix direction

When a fn literal's declared result is an `Impl(...)` SomeT, run `type_implements_trait` on the
body type for each required trait and raise E0602 at the body. For the parameter case, raise E0602
at the argument when binding it.

## Fix

`impl_param_unmet_trait` (`src/evaluator/trait_checking.yo`) returns the first trait an
`Impl(...)` carrier requires that a concrete type does not implement. It judges only the `Impl`
carrier (a `where(T <: X)` binder is the where-clause validation's), skips `Fn` traits (the
callable check owns them) and defers a type still carrying a SomeT to its specialization. It is
called:

- for a RESULT, on the concrete definition path and the deferred-generic one
  (`src/evaluator/calls/function_type.yo`): `Function body has type Q, which does not implement
  required trait Foo of the declared result Impl : (Foo)`;
- for a PARAMETER, on both argument-binding paths (`check_if_function_parameter_matches_argument`
  in `calls/helper.yo`, the inline FuncVal arm in `calls/function.yo`): `Argument for parameter
  "v" does not implement required trait Foo`.

Both are E0602 ("does not implement required trait"), and the argument form is flagged through
the flow-violation channel like the E0606 callable check, so a def-time trial re-raises it.

## Verification

Both repros are rejected at `check`. `tests/type_soundness.test.yo` has the result and argument
rejections and a canary that an implementing type flows through both. `check ./std` 176/176,
`check ./src` 279/279.
