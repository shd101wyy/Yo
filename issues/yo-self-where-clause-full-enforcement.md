# yo-self: full call-site where-clause enforcement blocked by trait-checker gaps

**Status:** partially implemented (marker-trait subset live since `7a67b961`); the
remainder is blocked on two `type_implements_trait` gaps documented below.

## Context

TS re-applies `FunctionType.whereClauseExprs` at every call site once
parameters are bound (`helper.ts:1493-1506` → `applyWhereClauseConstraints` →
`validateSingleTraitOnConcreteType`, `types/function.ts:974`), validating
EVERY constraint whose LHS resolved to a concrete type.

yo-self now ports this via the `WhereConstraintEntry` func-id side table
(`evaluator/types/function.yo`) + `validate_where_constraints_for_call`
(`evaluator/calls/helper.yo`, called from both call paths), but **scoped to
marker traits (no methods) against fully concrete types (no SomeT anywhere)**.

## Why the scope-down

Unscoped enforcement (validating every constraint, like TS) regressed
`check ./std` 151→145 and `check ./yo-self` 285→64. Two false-rejection
classes, both `type_implements_trait` gaps — TS validates the same constraints
successfully because its `typeImplementsTrait` is complete:

1. **Method-trait satisfaction on concrete types.** `where(K <: (Eq, Hash))`
   (std/collections/hashmap.yo, std/imm/map.yo) rejected `String`:

   ```
   Error: Type String does not implement required trait (== : fn(lhs : Self, ...) ... + Hash)
   ```

   The constraint trait is a composed/anonymous method trait; yo-self's
   concrete-satisfaction path (registry step 4 + generic-impl matching) cannot
   prove `String <: (Eq, Hash)` even though String's impls exist. (The
   recursive `Self`-referencing render in the message also shows the composed
   trait type is self-referential — printing it goes exponential.)

2. **Marker derivation through constraint-bearing-SomeT instantiation
   fields.** Generic instantiations inside impl bodies (e.g. `<struct:struct_yo_id_3986>`
   in std/imm/map.yo) carry fields whose types are still SomeTs (the impl's
   forall `K`/`V`). TS proves `typeImplementsSend` for those via the SomeT's
   `requiredTraits` (the impl's own `where(K <: Send)` constraint); yo-self's
   on-demand marker derivation recursed into the field SomeT and got `false` —
   the constraint was attached to a DIFFERENT SomeT instance than the one
   stamped into the instantiation's fields (SomeT identity propagation gap).

## Path to full enforcement

- Fix (2) first: make generic instantiation stamp the SAME constraint-bearing
  SomeT objects into field types that the impl's where-clause mutated (or
  propagate `required_trait_types` across the copy in
  `substitution.yo`/`synthesizer.yo`).
- Fix (1): teach trait-checking step 4 / generic-impl matching to prove
  method-trait satisfaction for concrete types via the registered method
  tables (the `(Eq, Hash)` composite needs supertrait/composite expansion).
- Then delete the `trait_is_marker` + `get_all_some_types(...).len() == 0`
  guards in `validate_where_constraints_for_call` and re-sweep.

## Repro for the enforced subset (passes today)

```rust
{ Mutex } :: import("std/sync/mutex");
NonSendObj :: object(x : i32);
Bad :: Mutex(NonSendObj); // rejected: Type NonSendObj does not implement required trait Send.
```

Covered by `tests/sync/mutex.test.yo` (closed by `7a67b961` + `a821ed30`).
