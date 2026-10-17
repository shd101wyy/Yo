# A nullable-shaped enum over `Box(Self)` emits a self-referential typedef

**Severity:** S2: a valid program that `check` accepts fails in the C compiler.

**Status: FIXED 2026-10-17.** Found 2026-10-17 while checking `derive(Clone)` over `Box` fields for `issues/fixed/derive-clone-on-a-recursive-enum-over-an-arraylist-of-self-emits-invalid-c.md`. **Measured on:** `yo-dev-5425cd7bf` (develop with #1380). No derive is needed to reproduce it.

## Symptom

```yo
{ println } :: import("std/fmt");
T :: enum(Leaf, Node(b : Box(Self)));
main :: (fn() -> unit)({
  t := T.Node(box(T.Leaf));
  println(match(t, .Node(_) => i32(1), .Leaf => i32(0)));
});
export(main);
```

`yo check` passes. clang reports `unknown type name` on `typedef __yo_t_B* __yo_t_B; // Box(Self)`, followed by pointer-type mismatches.

## Root cause

`T` has the nullable-pointer shape: one unit variant, plus one variant whose single field is a `Box`, which is a never-NULL pointer. So `T` folds into its payload, `Box(T)`. But `Box(T)` is a newtype over `*(T)`, so its C type is a pointer to `T`. Folded, `T` therefore becomes a pointer to itself. No C declaration order can express that type.

## Fix

`can_optimize_as_nullable_pointer` (`src/types/guards.yo`) follows the payload's pointee through pointers, `Box`es and other nullable-shaped enums. If that walk reaches the enum itself, it refuses the fold, and the enum keeps the tagged layout (`struct { tag; union { Box(T) b; } }`). Its `Box(T)` then points at the forward-declared struct. A struct, a tagged enum or a reference handle along the way ends the walk, because each of those has a forward declaration the pointer can name. The size model asks the same predicate, so the two layouts agree.

**Test:** `tests/derive_clone_complex.test.yo` section 13 (`BoxChain`): a two-deep chain is cloned through `derive(Clone)`, and the depth of both the original and the clone is checked.
