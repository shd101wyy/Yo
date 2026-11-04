# Should a SomeT carry its bounds immutably from construction?

**Kind:** design question: an open decision, not a defect. Filed 2026-11-02 from the B8 flip (`vbd/b8-arraylist-string-flip-r4`), on consultation #13's instruction (`VERDICTS-13.md` §10, "Soundness note, recorded not built"). Target: a V4 `TypeValue` follow-up for v0.2.75.

## Background

A `TypeValue` is an `Rc` handle to a node that is rebuilt, never mutated, with one exception: a `SomeT`'s trait bounds. A where clause is evaluated after `generic(T)` has minted T's `SomeT`, and after other parameter types already hold that `Rc` (`x : T`, `ArrayList(T)`, the `Arc(T)` head of `impl(generic(T), where(T <: (Send, Sync)), Arc(T), Send())`). The bound must reach every one of those holders. Before B8 the bound lists were `ArrayList` handles, and the in-place push reached every holder through the shared handle. Once `ArrayList` is a value, B8 keeps that meaning with ONE shared mutable cell, `SomeTBounds` (`src/types/definitions.yo`: `Rc(RefCell(SomeTBoundsCell(T)))`), following the `ValueCell` precedent (#1696).

The cell has exactly two writers: `_add_where_clause_constraint` (`src/evaluator/types/function.yo`) and `_stamp_impl_where_bound` (`src/evaluator/values/impl.yo`). Every new `SomeT` identity builds a fresh cell (`some_t_bounds`).

A `TraitT` has the same shape for the same reason, and the flip gave it the same cell: `TraitTBody` (`Rc(RefCell(TraitTBodyCell(T)))`, consultation #13 §13). A trait's node is minted before its body is evaluated, because the body names the trait itself (`SelfTrait`, `Self.X` through `ctx.self_trait_type`, a member typed over `Dyn(SelfTrait)`). Its members and `where(Self <: X)` constraints are written afterwards, by `evaluate_trait_type`'s member push and the two `where(Self <: X)` parsers (`src/evaluator/types/trait.yo`). Re-minting the node after each write (the alternative considered for B8) is unsound, not merely risky: traits have no id-to-value resolution, so a `Dyn` vtable, an impl check and a default-method lookup read the embedded node's own lists, and a copy embedded before the last member would build a narrower vtable and a narrower impl check without any error.

## The question

Should the bounds instead be fixed when the `SomeT` is built, so that `TypeValue` has no mutable cell at all?

## Options

1. **Keep the cell** (B8's shape). It is simple and preserves the pre-flip meaning exactly. Every holder sees a later stamp. The cost is that it is the one interior-mutable door into an otherwise immutable type graph: any memo keyed on a type (the CTFE memo, the specialization keys, the intern table) can observe a `SomeT` before and after a stamp under one identity.
2. **Bounds immutable at construction: two-pass parameter evaluation.** Mint T, evaluate only the where clauses, then re-mint T with the bounds baked in, and only then build the parameter types over the final T. This matches V4's "trees immutable after construction", and it deletes the cell and its two writers. The risk is the throwaway pass-1 identities: anything keyed on a `SomeT` id during pass 1 (the CTFE memo, specialization keys, generic-impl caches) would have to be audited so that no pass-1 identity leaks into a result.

The trait half has a third shape, the end state for `TraitT`: a struct-style **shell plus registry**. A trait would be resolved by id, as structs and enums are through their shells, so the embedded node needs no lists of its own and the cell disappears. Not built in B8.

## Recommendation

For `SomeT`: Option 2 in v0.2.75, as a V4 `TypeValue` follow-up, after the audit of the CTFE memo and the specialization keys for pass-1 identities. For `TraitT`: the shell plus registry, in the same follow-up; two-pass evaluation does not fit a trait whose members name the trait itself. Option 1 is the right shape for B8 itself, because the flip must preserve meaning and cannot carry that audit on the critical path. But a mutable cell inside an immutable graph is exactly the kind of exception that memo and cache bugs grow from, and the two-pass order is how the where clause's meaning ("T is bounded") is stated without a later write.
