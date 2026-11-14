# `Deref` on `ArrayList` / `String`: a trait `deref` method, or a compiler-known projection?

**Kind:** design question

**Status:** OPEN. Filed 2026-11-14 by the decision 49 S2 lane. The coordinator's
ruling: the feature stays in v0.2.79, and the mechanism is chosen by a Fable
consult at the start of v0.2.79.

## What

Decision 49 gives `ArrayList(T)` a `Deref(Target : [T])` impl and `String` a
`Deref(Target : str)` impl, so `list.*` is the `[T]` view and slice methods
reach a list through `.*`. Today `Deref` is a marker the compiler
understands only for the prelude's cells:

- `_throw_if_deref_impl_outside_prelude` (`src/evaluator/values/impl.yo`)
  rejects any impl outside the prelude ("only the prelude's Box, Rc and Arc
  implement it").
- `deref_target_type` and the `.*` lowering forward only through a cell's
  payload pointer.

A list's `[T]` view is not a payload pointer: it is the fat pointer
`(data, len)` built from two fields. The v0.2.77 seed also rejects the std
impls (finding F2, `plans/backlog/SEED_VERSION_AUTOMATION.md`), so whatever
mechanism is chosen lands as Generation A (compiler) and then Generation B
(the std impls).

## Options

1. **A trait method.** `Deref` gains
   `deref : fn(self : &Self) -> &Self.Target`. `.*` on a non-cell type lowers
   to a call. This is general, so a user type could implement it too. It
   costs a call per `.*` (inlined in practice), and the origin of the result
   is the receiver's, which the reference rules already handle for a
   `&Self -> &T` method.
2. **A compiler-known projection.** The impl names the fields,
   `Deref(Target : [T], data : _ptr, len : _len)`, and the compiler builds the
   fat pointer in place. No call is made, and codegen sees the place. But it
   is a closed set of shapes: each new shape, such as a strided view, needs
   compiler work.

## Recommendation

Option 1, the trait method. It is exact: one rule for every non-cell
`Deref`, with no special shapes, and it matches the "prefer the
semantically exact design" direction. The reference and origin machinery
already types `fn(self : &Self) -> &[T]`. Keep the cells' built-in
forwarding as it is, since their `.*` is a place rather than a call. Then
`Deref` has two arms: a cell, which is a place, and anything else, which
calls `deref`. Revisit option 2 only if a measured hot path shows the call
surviving `-O2`.
