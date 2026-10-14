# Drop and Dispose are not one trait for bounds and `Type.impls`, so migrating flips reflection

**Severity:** S2 — after `yo fix --migrate drop-trait`, `where(T <: Drop)` rejects every std destructor type (E0602) and `Type.impls(T, Drop)` silently answers `false` for them.

**Status:** Fixed (v0.2.63). Found by the v0.2.62 adversarial review; new with decision 45 Generation A (#1343).

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
needs_cleanup :: (fn(comptime(T) : Type) -> comptime(bool))(Type.impls(T, Drop));
retire :: (fn(generic(T : Type), x : T, where(T <: Drop)) -> unit)(drop(x));
main :: (fn() -> unit)({
  println(`${needs_cleanup(ArrayList(i32))}`);   // false; `Dispose` answers true
  retire(ArrayList(i32).new());                  // E0602: does not implement required trait Drop
});
export(main);
```

Both lines are what the migration writes from the `Dispose` spellings, which
worked.

## Root cause

Only `type_implements_dispose` (`src/evaluator/trait_checking.yo`) asked both
spellings. Bounds, witnesses and `Type.impls` go through
`type_implements_trait` with the plain trait identity, and every std
destructor type still implements `Dispose` in Generation A.

## Fix

`type_implements_trait` answers the prelude `Drop` and `Dispose` as one trait:
when the asked spelling is not implemented, it asks the other
(`_destructor_twin_trait`); the per-trait body is `_type_implements_trait_one`,
so the fallback never recurses back. The guard is a name test on the
`TraitT`, so other traits pay nothing. `type_implements_dispose` asks once.

## Test

`tests/move_only.test.yo`, "Drop: Drop and Dispose satisfy each other's bounds
and Type.impls": `Type.impls` both ways (a user `Drop` type, a user `Dispose`
type, std's `ArrayList(i32)`, a generic `Drop` impl, and `i32` answering
neither), a `Drop` value through a `where(T <: Dispose)` function and a
`Dispose` value and an `ArrayList` through a `where(T <: Drop)` one. Before the
fix the first `comptime_assert` fails.
