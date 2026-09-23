# An `-> Impl(Trait)` return bound is never checked against the body

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** OPEN. Green `yo check`, then an internal compiler error in `yo compile`.
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
