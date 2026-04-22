# Recursive `derive(T, Clone)` codegen falls back to vtable dispatch

## Status: Fixed

## Repro

```rust
TreeNode :: enum(
  Leaf(value : i32),
  Branch(left : Box(Self), right : Box(Self))
);
derive(TreeNode, Clone);
```

## Symptom (before fix)

C compilation failed:

```
error: no member named 'clone' in 'struct __yo_enum_yo..._struct'
  ((... (*)(void**))(&(*self)->_u42_)->clone)(...)
```

## Diagnosis

The recursive `Box(T).clone` impl from `std/prelude.yo` is specialized for
`T = TreeNode` _while_ `TreeNode.clone` itself is mid-registration. At that
point, the call expression `(self.*.*).clone()` inside the generic body has
no resolved `expr.$.value` (no concrete `FunctionValue`), so codegen fell
through to a regular field access on the struct — emitting
`(receiver)->clone` and casting it as a function pointer.

## Fix (option 2 — late dispatch resolution at codegen)

`src/codegen/exprs/property-access.ts` now performs a late lookup when
`expr.$.value` is missing but the field name corresponds to a method on
the receiver type's trait. The lookup:

1. Strips pointer layers from `objectType`.
2. Skips when `fieldName` is a real data field of the receiver type.
3. Searches the trait's direct fields for a matching `FunctionValue`.
4. If not found, iterates nested trait impls (unlabeled trait fields whose
   value is a `TraitValue` — the form created by `derive(...)`) and
   returns the matching method's C function name.

This makes the dispatch decision at codegen emit time rather than relying
on the evaluator having set the value during initial generic body
type-checking. Concrete impls registered after the body is type-checked
are now picked up correctly.

## Test

`tests/derive_clone_complex.test.yo` — test "derive Clone for recursive
enum with Box(Self)" (case 9). Re-enabled and passing.
