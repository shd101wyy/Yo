# The compiler stamps constraints into a TypeValue's lists in place

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — found 2026-10-20 while making TypeValue's label/type lists
shared (`perf/share-typevalue-lists`, VALUES_BY_DEFAULT V2b B1 prerequisite).

## What the code does

`src/types/definitions.yo` says a `TypeValue` "is rebuilt, never mutated
(... a codebase-wide audit found no in-place write to a node's fields)".
That holds for the node's fields, but not for the CONTENTS of its lists:
`ArrayList` is still `ref(struct(...))`, so a list read out of a node is a
handle to the node's own buffer, and these sites push through it:

| site | list written | why |
| --- | --- | --- |
| `src/evaluator/types/function.yo` `_add_where_clause_constraint` | a `SomeT`'s `required_trait_types`/`_levels`, `negative_trait_types`/`_levels` | a where clause stamps its bound on the type variable every holder sees |
| `src/evaluator/values/impl.yo` (the where-clause walk of a generic impl head) | a `SomeT`'s `required_trait_types`/`_levels` | the same stamp for an impl's `where(T <: ...)` |
| `src/evaluator/types/trait.yo` (`Self` constraints) | a `TraitT`'s `self_constraints`/`neg_self_constraints` | a trait's `where(Self <: ...)` |
| `src/evaluator/types/trait.yo` `evaluate_trait_type` | a `TraitT`'s `assoc_type_names`, `field_labels`, `field_types` | the trait type is built first and filled field by field, so `Self`-referential members see the trait as it grows |

The aliasing graph is behaviour: a stamp is visible to every node that holds
the same list handle (every copy of the `TypeValue`, and every structural
rebuild that carried the list over).

## Why it is a question now

Under V2b's unique buffers every one of those reads is a copy, so each stamp
silently writes a temporary and is lost. `perf/share-typevalue-lists` therefore
leaves exactly these nine lists (the four `SomeT` lists and five `TraitT`
lists above) as plain `ArrayList`; every other label/type list in
`TypeValueNode` and `FuncMeta` became a `SharedList` (`Rc` of a cell that no
code writes after construction), so the branch changes no aliasing. The B1 sweep cannot convert them mechanically: there is no
spelling that keeps the stamp.

## Options

1. A side table keyed by the type variable's / trait's id (`SomeT.id`,
   `TraitT.id`) holding the stamped constraints, read wherever the lists are
   read today. Nodes become truly immutable; the stamp stays global, which is
   what the current aliasing achieves.
2. Rebuild-and-re-register: a stamp builds a new node and re-binds it in the
   environment. Every holder of the old node (captured `Dyn(SelfTrait)`,
   memoized instances) keeps the old one, so this changes behaviour wherever
   the aliasing was relied on.
3. Make these lists an explicit shared mutable cell (`Rc(RefCell(ArrayList(T)))`).
   Keeps today's semantics with the sharing visible in the type.

## Recommendation

Option 1 for the `SomeT` bound lists and the trait `Self` constraints: the
stamp is a fact about an identity, which is what an id-keyed table models, and
it removes the only writers into a shared node. For `evaluate_trait_type`'s
incremental build, option 3 (or the same id-keyed table for the trait's
member list) until the trait evaluator can build members before minting the
node. Decide before the B1 re-sweep, which otherwise inserts copies that drop
every stamp.
