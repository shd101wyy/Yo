# A method on a phantom generic struct is not found through a `comptime(K) : Type` parameter

**Severity:** S2 — a valid program is rejected with "No method"; writing a module-level helper function instead of a method is the other spelling
**Found:** 2026-09-29, making `std/imm/map.yo`'s node buffers follow the allocation scope (`plans/EXPLICIT_ALLOCATORS.md` P3b): `MapBranch(K, V)` is `ref(struct(bitmap : u32, _children_ptr : *void, _children_len : u8))`, which uses neither `K` nor `V`.

## Reproducer

```rust
Br :: (fn(comptime(K) : Type) -> comptime(Type))(ref(struct(n : u8)));
impl(generic(K : Type), Br(K), size : (fn(self : Self) -> u8)(self.n));
helper :: (fn(comptime(K) : Type, b : Br(K)) -> u8)(b.size());
main :: (fn() -> unit)({
  x := Br(i32)(n : u8(3));
  y := helper(i32, x);
});
export(main);
```

```
error[E0610]: No method "size" on Br(K): the type has no field or method with that name.
```

`x.size()` in `main` works, and so does the helper when the struct has a field
of type `K`. The failure needs a phantom parameter (one no field uses) and a
receiver typed through the helper's `comptime` type parameter. Enums behave the
same.

## Cause

`YO_DEBUG_DISPATCH=1` shows the generic-impl match against the helper's receiver
ending `all_bound=false`, with the receiver's type arguments still `[K]` in the
`helper(i32, x)` specialization, while the non-phantom version matches the
argument's own `Br(i32)`. `get_all_some_types` (`src/types/utils.yo`) collects a
struct's type variables from its FIELDS only. A phantom `Br(K)` has none, so
the declared parameter type counted as concrete and the specialization kept
the definition-time `Br(K)` instead of adopting the argument's type. The impl
match then had nothing to bind `K` to.

## Fix

The Struct arm of `_collect_some_types_into` also walks `type_arguments`, and
the EnumT arm walks the enum's recorded arguments (`lookup_enum_type_arguments`).
