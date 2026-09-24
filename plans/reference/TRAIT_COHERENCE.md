# Trait coherence: one impl of a trait per type

**Status:** DECIDED 2026-09-24 (Phase 2.3 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Rules 1–3 are
implemented; rule 4 is Phase 3.3's module-qualified identity.

## Problem

Before this decision nothing rejected a second impl of a trait for a type. Registration appended
(`register_type_trait_method`), and dispatch took the first hit, so the second impl was dead code
that looked live. Measured on the v0.2.39 seed and develop `d455b6a67`
(`issues/yo-self-missing-duplicate-impl-checks.md` addendum): two `impl(P, Foo(...))` in one
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
4. **Identity.** Rules 1–3 key on the trait's and the type's ids. Today those are position-derived
   and module-free (`issues/trait-ids-omit-the-module-so-two-traits-can-share-one-id.md`), so two
   traits of the same name at the same position in different modules could collide; Phase 3.3
   makes ids module-qualified, after which "same trait" is exactly "same declaration".

## What is not a duplicate

- **Re-evaluation of the same impl.** The loader's idempotent re-evaluation, a generic impl
  re-registering per instantiation, and the LSP re-evaluating an edited module all replay the
  SAME source site; a registration from the same site is not a second impl. The LSP purges the
  registry per invalidated module, as it already does for methods and generic impls.
- **Negative impls** (`impl(T, !(Send))`) are a separate registry and conflict only with the
  positive marker (unchanged).
- **Inherent methods** have their own rule (`plans/reference/FUNCTION_OVERLOADING_POLICY.md`,
  duplicate-inherent-method rejection).

## Diagnostic

E0602-family text naming both sites:

```
error: Trait "Foo" is already implemented for type "P" (first impl: m.yo:3:9). A type implements a trait at most once (plans/reference/TRAIT_COHERENCE.md).
```

## Consequences for `std/` and `src/`

Every duplicate the rule finds in the tree is fixed in the same change (the decision's point): see
`issues/stddoc-coll-duplicate-fromiterator-impl-on-hashset.md` and the PR body.
