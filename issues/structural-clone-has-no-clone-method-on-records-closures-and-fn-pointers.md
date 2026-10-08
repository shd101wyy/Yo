# Structural `Clone` has no `clone()` method on anonymous records, closures and `fn` pointers

**Severity:** S2 — `Type.impls(T, Clone)` holds for an anonymous record, a closure or a `fn` pointer whose parts are `Clone`, so a `where(T <: Clone)` function accepts one, but `x.clone()` in its body is E0610

Found 2026-10-06 while landing `plans/VALUES_BY_DEFAULT.md` decision 36's Generation A (`Copy` requires `Clone`, #1245).

> **Partly fixed 2026-10-08** (decision 36 Generation B's sweep, #1269): `x.clone()` on a value that is `Copy` structurally (a `fn` pointer, a closure whose captures are all `Copy`, an anonymous record whose fields are) expands to its receiver, the copy (`_try_structural_copy_clone`, `src/evaluator/calls/function.yo`), so a derived `Clone` over a `fn` field works too. **Still open:** a record or a closure that is `Clone` but not `Copy` (a `String` field or capture) still has no `clone()`; it needs the field-wise clone below.

## Symptom

```rust
clone_any :: (fn(generic(T : Type), x : T, where(T <: Clone)) -> T)(x.clone());
main :: (fn() -> unit)({
  r := _(a : i32(1), b : i32(2));
  comptime_assert(Type.impls(type_of(r), Clone), "structural Clone");
  s := clone_any(r);
  println(s.a);
});
export(main);
```

```
error[E0610]: No method "clone" on <struct:...>: the type has no field or method with that name.
```

The same holds for `r.clone()` written directly, for a closure (`f.clone()` on an `Impl(Fn(x : i32) -> i32)`) and for a `fn` pointer.

## Root cause

Decision 36 makes an anonymous composite `Copy`, and `Clone`, exactly when its parts are. `type_implements_trait` answers both structurally (`copy_structural_parts`, `src/evaluator/trait_checking.yo`). Method dispatch has no entry to find:

- A tuple's `clone()` comes from the prelude's element-wise `impl(generic(A…), where(A <: Clone, …), Tuple(A, …), Clone(...))` for arities 1 to 12, and an array's from `impl(generic(T : Type, U : usize), where(T <: Clone), Array(T, U), Clone(...))`.
- An anonymous record, a closure and a `fn` pointer have no receiver pattern a prelude impl can name, and no type id to hold a registry entry. So `_try_find_receiver_method` (`src/evaluator/calls/function.yo`) misses.

The trait answer is still right: these types must be `Clone` for `Copy: Clone` to hold for them, since they are `Copy` structurally.

## Fix direction

A builtin structural `clone` in method dispatch for the three kinds:

- a `Copy` one clones as the bitwise copy (`__yo_return_self`);
- a non-`Copy` record clones field-wise;
- a non-`Copy` closure clones its capture record.

Decision 36's Generation B lists this item. The test is the symptom above, at a record, a closure and a `fn` pointer, Copy and not.
