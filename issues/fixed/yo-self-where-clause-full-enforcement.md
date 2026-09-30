# yo-self: full call-site where-clause enforcement blocked by trait-checker gaps

**Severity:** S2 — where-clause bounds are under-enforced at call sites (marker-trait subset) — programs violating method-trait or SomeT-derived bounds can be accepted

**Status:** FIXED — closed 2026-09-29 after re-measurement (develop `c52ce152c` and the
Phase 3 step 7 branch). Every class below is enforced at the call site, and the two
"blocking" gaps no longer reject valid code. See **Closure 2026-09-29** at the end.

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

## Addendum 2026-09-23: method and composite bounds are enforced now (type-system audit)

MEASURED on the yo 0.2.39 seed (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2): `where(T <: Foo)` with
a method trait and a `Q` lacking `Foo` is rejected with
`error[E0602]: Type Q does not implement required trait Foo.`, and `where(T <: (Foo, Bar))` with
`Q` implementing only `Foo` reports `... required trait Bar.` The "marker traits only" scope
above is therefore partly stale. The `String <: (Eq, Hash)` residual was not re-measured.

## Closure 2026-09-29 (measured)

The enforcement this issue asked for runs in the function-TYPE evaluation, not in the
marker-only side channel it describes: a generic callee's type is re-evaluated with its
parameters bound, and `apply_single_trait_constraint` → `validate_concrete_type_constraints`
(`src/evaluator/types/function.yo`, the port of TS's `applyWhereClauseConstraints` /
`validateSingleTraitOnConcreteType`) checks every bound whose LHS resolved to a concrete type.
`validate_where_constraints_for_call` (`src/evaluator/calls/helper.yo`) stays as the marker
channel (function-value markers, rules D1/D4); its comment now says so.

Measured with a tree-built compiler, each rejected with `error[E0602]`:

| Bound | Call | Verdict |
| --- | --- | --- |
| composite method traits `where(T <: (Foo, Bar))` | a type implementing only `Foo` | `does not implement required trait Bar` |
| a type constructor's `where(T <: Bar)` | `Box(Q)`, `Q` lacking `Bar` | rejected |
| `where(T <: Send)` reached through an unconstrained generic forwarder, on `Pair(U)` | `U = ArrayList(i32)` | `Pair(ArrayList(i32)) does not implement required trait Send` |
| `HashMap`'s `where(K <: (Eq(K), Hash))` | a key with `Eq` only | `does not implement required trait Hash` |

and accepted, compiled and run: both traits present, the constructor's bound met, the
forwarder at `U = i32`, and `HashMap(String, i32)` — gap (1) above (`String <: (Eq, Hash)`) no
longer rejects, and gap (2) (a marker bound on a type carrying the forwarder's SomeT) is decided
correctly at instantiation.

Regression tests: `tests/where_clause_fn_inference.test.yo`, "where-clause bounds are enforced
at the call site" and "where-clause bounds accept the types that satisfy them". Flipping the
first negative to a satisfying type turns the batch red, so the `comptime_expect_error`s are
not vacuous.
