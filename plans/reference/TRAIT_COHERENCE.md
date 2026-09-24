# Trait coherence: one impl of a trait per type

**Status:** DECIDED and IMPLEMENTED 2026-09-24 (Phase 2.3 of `plans/TYPE_SYSTEM_SOUNDNESS.md`;
rule 4 pulled forward from Phase 3.3 because rules 1–3 cannot be checked without it).

## Problem

Before this decision nothing rejected a second impl of a trait for a type. Registration appended
(`register_type_trait_method`), and dispatch took the first hit, so the second impl was dead code
that looked live. Measured on the v0.2.39 seed and develop `d455b6a67`
(`issues/fixed/yo-self-missing-duplicate-impl-checks.md` addendum): two `impl(P, Foo(...))` in one
module, a local re-impl of a trait an import already implements for `i32`, a user
`impl(i32, ToString(...))` against the prelude's, and an explicit impl beside a blanket impl that
covers the same type — all `check` and `compile` green, first registration wins, silently.

Yo has no overloading and no specialization; a program that states two different behaviours for
one (type, trait) pair has no meaning to give it.

## Rules

1. **Duplicate impl.** Two impls of the same trait instantiation for the same type are an error,
   wherever they are written. "Same trait instantiation" is the trait's instantiation id:
   `Eq(String)` and `Eq(str)` are different traits, so `String` may implement both.
2. **Imported impls count.** An impl already registered by an imported module — including the
   prelude — makes a local impl of the same (type, trait) a duplicate. There is no orphan rule
   beyond this: a module may implement any trait for any type as long as no other impl of that
   pair exists in the program.
3. **Blanket overlap.** A blanket impl (`impl(generic(T), where(...), T, Trait(...))`, a receiver
   that is a bare type variable) and a concrete impl of the same trait for a type the blanket
   covers are an error, in either registration order. There is no specialization: a later design
   that wants one must replace this rule, not work around it.
4. **Identity.** Rules 1–3 key on the trait's and the type's ids, so an id must name exactly one
   declaration. Type ids (`stable_type_id`: structs, enums, unions, traits, anonymous structs)
   carry the defining module's stem, and two modules whose stems coincide are told apart by a
   mint-owner registry (`_x2`, …). Before this they were position-only, and std had live
   collisions: `std/collections/deque.yo`'s and `array_list.yo`'s structs (both at 38:5) shared an
   id, so `Deque(T)`'s `Dispose` impl read as a second `Dispose` for `ArrayList(T)`
   (`issues/fixed/trait-ids-omit-the-module-so-two-traits-can-share-one-id.md`).

## What is not a duplicate

- **Re-evaluation of the same impl.** The loader's idempotent re-evaluation, a generic impl
  re-registering per instantiation, and the LSP re-evaluating an edited module all replay the
  SAME source site; a registration from the same site is not a second impl. The LSP purges the
  registry per invalidated module, as it already does for methods and generic impls.
- **Negative impls** (`impl(T, !(Send))`) are a separate registry and conflict only with the
  positive marker (unchanged).
- **Inherent methods** have their own rule (`plans/reference/FUNCTION_OVERLOADING_POLICY.md`,
  duplicate-inherent-method rejection), which now also covers a GENERIC receiver: two blanket
  inherent impls over the same receiver pattern and the same bounds may not define one method
  name (over different bounds they may). Its diagnostic shares E0612.

## Diagnostic

E0612 (`yo explain E0612`), naming both sites:

```
error: Trait "Foo" is already implemented for type "P" (first impl: m.yo:3:9). A type implements a trait at most once (plans/reference/TRAIT_COHERENCE.md).
```

## Consequences for `std/` and `src/`

Every duplicate the rule finds in the tree is fixed in the same change:

- `std/collections/hash_set.yo` registered `FromIterator` for `HashSet(T)` twice, byte-identical
  (`issues/fixed/stddoc-coll-duplicate-fromiterator-impl-on-hashset.md`); the undocumented copy is
  gone.
- `std/fmt/format.yo` had concrete `Format` impls for the eighteen numeric types AND a blanket
  `impl(generic(T), where(T <: ToString), T, Format(...))` documented as "a concrete impl above
  always wins" — specialization by registration order, exactly what rule 3 forbids. `Format` now
  requires `Self <: ToString` and carries a DEFAULT `format` (width, fill, alignment and
  truncation over `to_string()`); the numeric impls keep their bodies, every other std
  `ToString` type has a one-line `impl(X, Format())`, and a user type opts in the same way. This
  is Rust's model (`Display` is implemented per type). A negated bound
  (`where(T <: ToString, T <: !(Numeric))`) was considered and rejected: generic impls do not
  accept negated bounds today, and even with them a user `ToString` type could never give its own
  `Format` without overlapping the blanket.

## Where it is enforced

`src/evaluator/values/impl.yo`: the concrete-impl path calls `note_trait_impl_site`
(`src/evaluator/values/type_trait_methods.yo`, keyed by type id and trait instantiation key,
recording a canonical `path:row:col` site) and `_check_concrete_impl_coherence` (against the
registered generic impls); the generic-impl path calls `_check_generic_impl_coherence` (an
identical generic impl — binders renamed by position — from another site, and every registered
concrete impl the new entry covers, matched with its where-clauses enforced). The diagnostic is
E0612. Tests: the `check-coherence-*` cases in `tests/cli-cases/`.
