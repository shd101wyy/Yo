# `yo fix --migrate explicit-copy` drops a copy made before its type's `Clone` impl registers

**Severity:** S3. The listing is incomplete: a unique-buffer copy whose type gets its `Clone` impl further down the module is neither rewritten nor listed, so it surfaces only as E0901 at the B8 flip.

> Found 2026-10-24 while building P8
> (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.4). P8 lists clone-less
> copies instead of dropping them. Its first std dry run then listed
> `std/string/string.yo:693` as "`String` has no `Clone`".

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
Bag :: struct(items : ArrayList(i32), label : i32);
count :: (fn(b : &Bag) -> usize)({
  c := b;
  c.items.len()
});
derive(Bag, Clone);
main :: (fn() -> unit)(());
export(main);
```

`yo fix main.yo --migrate explicit-copy --dry-run` on the v0.2.69 tree
(`f271ed005`) reported nothing: 0 inserted and 0 listed. With `derive` moved
above `count`, the same copy is reported. In std, `String.split` pushes
`self` (`std/string/string.yo:693`) about 2,700 lines above `String`'s
`Clone` impl, and it was dropped the same way.

## Root cause

`_ic_migrate_site` (`src/evaluator/utils.yo`) asked `type_lacks_clone(ty)`
when the copy was recorded, during evaluation. Impls register in evaluation
order, and a body's definition-time evaluation can run before a later
`derive`/`impl` statement of the same module. So the answer depended on
where the impl was written. A "no" dropped the site.

## Fix

The site keeps the copied type (`ExplicitCopySite.ty_value`) and whether a
`.clone()` written at the copy would resolve there
(`ExplicitCopySite.lacks_clone_at_copy`, `_ic_clone_unresolved_here` in
`src/evaluator/utils.yo`). That second answer is asked as the `.clone()`
method lookup would ask it: when the type has no `Clone` yet, the pending
`impl`s of the type and of its type arguments that declare `clone` are
forced first (`force_pending_impls_for_type_name`), and the type is asked
again. `_run_migrate_explicit_copy` (`src/main.yo`) asks `type_lacks_clone`
once more when it builds the listing, by which time every module is
evaluated and every impl registered:

- no `Clone` at the end: listed as clone-less
  (`issues/fixed/2026-10-22-explicit-copy-migration-omits-copies-of-a-type-without-clone-from-its-listing.md`);
- `Clone` from an `impl` further down the module: the forcing registers it,
  and the copy is cloned like any other;
- `Clone` at the end but a `.clone()` at the copy would not resolve: listed
  as "copied above the `derive` that gives `T` its `Clone`". This is a
  `derive(T, Clone)` below the copy, which the method lookup does not force
  (`issues/2026-10-24-a-derive-below-its-first-method-use-is-not-forced.md`,
  S2, open). Once that is fixed, these sites can be cloned.

A first version listed every copy made above its type's `Clone`, an `impl`
included. On develop `f1cfa553d`'s tree that was 8 std sites and 1 src site.
The 8 std sites (`String.split` pushing `self`, and seven `JsonValue` and
`ArrayList(JsonValue)` copies in `std/encoding/json.yo` above its
`impl(JsonValue, Clone)`) have impls below them, and are now cloned. The src
site, `src/diagnostics.yo:88`, copies a `Diagnostic` about 280 lines above
`derive(Diagnostic, Clone)`, and stays listed.

Test: `tests/cli-cases/fix-migrate-explicit-copy-clone-impl-below`. `c := b` above a `derive` is
listed, the copies of a `Sack` and an `ArrayList(Sack)` above an `impl` are
cloned, and the file still checks.
