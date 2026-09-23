# A higher-kinded return type `F(A)` is never applied at the call site

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** OPEN. Completeness bug: a documented feature (kind-annotated `generic(F : ...)`) cannot
be used as a result type.
**Measured:** yo 0.2.39 seed.

## Repro

```rust
identity :: (fn(generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type), x : F(A)) -> F(A))(x);
main :: (fn() -> unit)({
  o := Option(i32).Some(i32(1));
  r := identity(o);
  (r2 : Option(i32)) = r;
});
export(main);
```

```
error[E0601]: Incompatible types: Expected Option(i32), Given TypeApp(F, [A])
```

## Mechanism (READ)

`F(A)` is represented as `TypeAppT(constructor : SomeT, args)` (`src/types/definitions.yo`). The
forall binder binds `F` and `A` at the call, but the result type is substituted without
re-applying the bound constructor to the bound arguments, so the `TypeAppT` node survives. The
message also leaks the internal `TypeApp` spelling.

## Fix direction

After forall binding, normalize every `TypeAppT` whose constructor is now bound by evaluating the
constructor on the substituted arguments (through the CTFE memo, so the result shares identity
with a direct `Option(i32)`).
