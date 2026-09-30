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
receiver typed through the helper's `comptime` type parameter. Enums fail the
same way but for a deeper reason; that case is
`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`.

## Cause

`YO_DEBUG_DISPATCH=1` shows the failing match runs at DEFINITION time
(`trial=false`): the receiver is the helper's own abstract `Br(K)`, and the
generic impl's pattern cannot bind its `K` to it outside a definition-time
trial. With a field of type `K` the same helper is DEFERRED — its body is only
trialled at definition and checked for real at each call, where the receiver
is `Br(i32)` and the match binds.

Whether a definition defers is decided by `should_defer_ft`
(`src/evaluator/calls/function_type.yo`): a `comptime(K) : Type` parameter does
not defer by itself (a TypeUni comptime parameter is excluded on purpose), so
the decision rests on whether a parameter type contains a type variable,
`type_contains_some_type_for_codegen_param` (`src/evaluator/trait_checking.yo`).
That predicate walked a struct's FIELDS and an enum's variant payloads only. A
phantom `Br(K)` has no field mentioning `K`, so `b : Br(K)` counted as
concrete and the body was checked eagerly against the abstract receiver.

## Fix

`type_contains_some_type_for_codegen_param` also walks a struct's
`type_arguments`, so a phantom `Br(K)` parameter defers the definition like any
other generic one. At the call the specialization then sees the argument's
`Br(i32)`, and the impl matches through the instantiation's type arguments
(`_bind_forall_from_type_args`). The regression test is the phantom case in
`tests/comptime_type_arg_binding.test.yo`.

A first attempt changed `get_all_some_types` (`src/types/utils.yo`) instead.
It did not fix the repro, since that is not the predicate the defer decision
reads, and the extra walk made `yo check` on the compiler's own evaluator
modules several times slower. It was reverted.
