# Recursive `derive(T, Clone)` codegen falls back to vtable dispatch

## Status: Open

## Repro

```rust
TreeNode :: enum(
  Leaf(value : i32),
  Branch(left : Box(Self), right : Box(Self))
);
derive(TreeNode, Clone);

main :: (fn() -> unit)({
  t := TreeNode.Branch(left: box(TreeNode.Leaf(i32(1))), right: box(TreeNode.Leaf(i32(2))));
  c := t.clone();
  ()
});
export main;
```

## Symptom

C compilation fails:

```
error: no member named 'clone' in 'struct __yo_enum_yo..._struct'
  ((... (*)(void**))(&(*self)->_u42_)->clone)(...)
```

## Diagnosis

The evaluator-side root cause was fixed in `src/evaluator/calls/trait-type.ts`
(SelfType substitution when extending `receiverType.trait.fields`). The
recursive `TreeNode.clone` body now type-checks correctly.

The remaining failure is in **codegen specialization ordering**:

1. `derive(TreeNode, Clone)` registers a Clone impl whose body calls
   `(self.*).clone()` on `Box(Self)` fields.
2. During TreeNode.clone codegen, `Box(TreeNode).clone` is specialized.
3. The generic `Box(T).clone` impl in `std/prelude.yo` has body
   `box((&(self.*.*)).clone())` — `(self.*.*)` is `T` (= `TreeNode`).
4. At specialization time for `T = TreeNode`, the codegen attempts to
   dispatch `(self.*.*).clone()` but TreeNode.clone hasn't been emitted
   yet (mid-registration), so it falls back to vtable-style dispatch
   through a struct field (`->clone`) that doesn't exist.

For non-recursive types (e.g. `Box(P)` where `P` is a plain struct),
P.clone is fully registered before `Box(P).clone` is specialized, so the
codegen emits a direct call `fn_yo..._clone(...)` correctly.

## Possible fixes

1. **Two-pass specialization**: defer specialization of generic impl
   bodies until all directly-related concrete impls (e.g. TreeNode's own
   Clone) have been registered, then re-specialize.
2. **Late dispatch resolution in codegen**: when emitting a trait method
   call inside a generic impl body, look up the concrete impl at codegen
   emit time rather than at specialization time.
3. **Force generic impl body to use `recur` for self-typed calls** —
   only works when self-typed; not applicable here because the call is
   on a `Box(T)` field's content.

Option 2 is likely the proper root-cause fix.

## Test

`tests/derive_clone_complex.test.yo` — test "derive Clone for recursive
enum with Box(Self)" (case 9).

The test is currently disabled with a comment pending the codegen fix.
