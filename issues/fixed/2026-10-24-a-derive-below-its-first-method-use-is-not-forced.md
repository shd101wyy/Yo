# A `derive` below a method call that uses it is not forced: E0610

**Status: FIXED** 2026-10-29 (`src/evaluator/context.yo`: a `derive` is a pending impl of its target type).

**Severity:** S2. A valid program is rejected: `b.clone()` above `derive(Bag, Clone)` fails with E0610 "No method `clone` on Bag", where the same call above an `impl(Bag, Clone(...))` checks clean. The workaround is to move the `derive` above its first use.

> Found 2026-10-24 while building P8 (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md`
> §4.4). The explicit-copy migration was taught to ask a copied type for
> `Clone` once the run is evaluated. It would then have written
> `d.clone()` at `src/diagnostics.yo:88`, about 280 lines above
> `derive(Diagnostic, Clone)`, and that call does not resolve there.

## Symptom

`issues/repros/2026-10-24-a-derive-below-its-first-method-use-is-not-forced.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
Bag :: struct(items : ArrayList(i32), label : i32);
count :: (fn(b : &Bag) -> usize)({
  c := b.clone();
  c.items.len()
});
derive(Bag, Clone);
main :: (fn() -> unit)(());
export(main);
```

`yo check` (the v0.2.69 seed and the tree at `f271ed005`):

```text
error[E0610]: No method "clone" on Bag: the type has no field or method with that name.
  --> issues/repros/2026-10-24-a-derive-below-its-first-method-use-is-not-forced.yo:7:9
```

With `impl(Bag, Clone(clone : (fn(self : &Self) -> Self)(Bag(items : self.items.clone(), label : self.label))))`
in place of the `derive`, the program checks clean.

## Root cause (suspected, not traced)

Lazy top-level bindings (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`) force a
pending `::` definition or `impl(...)` registration when a lookup misses,
including a method lookup on a named type. `count`'s body is evaluated at its
definition, before the module reaches `derive(Bag, Clone)`. A `derive` is a
statement evaluated in order (`src/evaluator/builtins/derive.yo`), not a
registration the miss forces, so the lookup fails.
`docs/en-US/DEFINITION_ORDER.md` names `::` definitions and `impl`
registration only. It says nothing about `derive`.

## Direction

Register a top-level `derive(T, Traits...)` with the lazy-binding forcing
pass, as an `impl(...)` registration is, so a method or trait lookup on `T`
that misses forces it. Or, if `derive` is meant to stay ordered, document it
in `DEFINITION_ORDER.md` (both languages) and make E0610 suggest moving the
`derive` up. Until then, `yo fix --migrate explicit-copy` lists a copy whose
type gets `Clone` only further down the module, instead of writing a
`.clone()` that may not resolve
(`issues/fixed/2026-10-24-explicit-copy-migration-drops-a-copy-made-before-its-types-clone-impl-registers.md`).

## Fix (2026-10-29, branch `fix/derive-order-independence`)

One root cause for this doc and
`issues/fixed/2026-10-27-a-derive-is-not-order-independent-like-an-impl.md`:
a top-level `derive(...)` was an ordered statement, so no lookup miss could
force it. `classify_pending_def` (`src/evaluator/context.yo`) now classifies
`derive([generic(...)], [where(...)], T, Trait...)` as a pending impl of `T`'s
head (`PendingDef.is_derive`, with `is_impl` set), exactly as it classifies
`impl(T, ...)`. A method or trait miss on `T` reaches
`force_pending_impls_for_type_name`; no derive declares a member label, so the
named pass passes it over and the "force every pending impl of the type"
fallback forces it. Three adjustments keep everything else as it was:

- **Inside an impl of `T`** the fallback used to be skipped (the in-block
  guard). A named miss there now falls back to `T`'s pending derives only: a
  derive declares its methods only once it runs, and forcing it registers
  whole impls rather than touching the half-registered block (a member calling
  `self.clone()` above `derive(T, Clone)`).
- **A derive in flight does not take the in-impl guard.** It declares no
  member and registers whole impls, so a trait-bound miss under it still forces
  later impls, as when derives were ordered: `derive(K, Ord(K))` above
  `impl(K, Eq(K)(...))` keeps checking, and above `derive(K, Eq(K))` now checks
  too (it was E0603 before).
- **Identity anchors are unchanged.** `register_module_anchors` keeps a
  derive's unnamed-statement label (`<prev>_s<n>`); naming it `impl_<T>` would
  rename every id minted in it and in the statements after it, and the next
  `impl_<T>`.

A forced derive that fails reports its own error with the note
`` `derive(T, …)` (line N) was evaluated here because a method or trait of `T`
is used before that derive in the source ``.

Regression tests: `tests/lazy_toplevel_bindings.test.yo` — "a method call
above the derive that provides it", "a definition forced before the derive its
body needs", "an impl member calls a method from a later derive of its type",
"a derive whose trait bound is met by a later derive or impl" (all but the
last case's impl half fail on develop `d25241bdf`: the module is E0610 at the
first one).

Byte identity: the compiler's own emitted C for `src/main.yo` (155 MB) is
identical before and after (sha256 `ca2f00db…`, develop `d25241bdf`'s binary
against this branch's), as are `tests/derive.test.yo`'s and
`tests/derive_clone_complex.test.yo`'s emissions: no derive in the corpus is
forced out of order.

Seed gate: `std/` and `src/` keep their derives above first use until
`SEED_VERSION` carries the release with this fix; `yo fix --migrate
explicit-copy` keeps listing (not cloning) a copy made above its type's
`derive(T, Clone)` for the same reason.
