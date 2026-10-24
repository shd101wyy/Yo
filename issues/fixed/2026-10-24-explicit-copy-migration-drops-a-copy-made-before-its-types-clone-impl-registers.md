# `yo fix --migrate explicit-copy` drops a copy made before its type's `Clone` impl registers

**Severity:** S3. The migration misses a `.clone()`: a unique-buffer copy whose type gets its `Clone` impl further down the module is neither rewritten nor listed, so it surfaces only as E0901 at the B8 flip.

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

The site keeps the copied type (`ExplicitCopySite.ty_value`), and
`_run_migrate_explicit_copy` (`src/main.yo`) asks `type_lacks_clone` when it
builds the listing. By then every module is evaluated and every impl is
registered. A copy whose type has `Clone` by then is cloned. One without
`Clone` is listed
(`issues/fixed/2026-10-22-explicit-copy-migration-omits-copies-of-a-type-without-clone-from-its-listing.md`).

Test: `tests/cli-cases/fix-migrate-explicit-copy-clone-impl-below`. `c := b` is cloned.
