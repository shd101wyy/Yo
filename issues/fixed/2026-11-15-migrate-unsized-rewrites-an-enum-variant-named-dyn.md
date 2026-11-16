# `yo fix --migrate unsized` rewrites an enum variant named `Dyn` as if it were the `Dyn` type

**Severity:** S3: the migration turns a file that checks into one that does not, and counts the edit as a successful rewrite. Only an enum variant named `Dyn` declared on one line triggers it. The prelude's `TypeInfo.Dyn` variant has this shape, and is spared only because it spans several lines (it is listed instead, with the wrong advice).

**Status:** FIXED by #1970 (decision 49 S2 flip A, 2026-11-16), confirmed 2026-11-16 by the S3b-`Dyn` lane. Found 2026-11-15 by the unsized-sweep lane while auditing the S2 sweep of std and src (`vbd/unsized-sweep`).

## Reproducer

`issues/repros/2026-11-15-migrate-unsized-rewrites-an-enum-variant-named-dyn.yo` checks clean:

```yo
Shape :: enum(
  Dyn(x : i32),
  Plain
);
get :: (fn(s : Shape) -> i32)(
  match(
    s,
    .Dyn(x : v) => v,
    .Plain => i32(0)
  )
);
mk :: (fn() -> Shape)(.Dyn(x : i32(1)));
main :: (fn() -> unit)({
  n := get(mk());
});
export(main);
```

`yo fix <file> --migrate unsized`, run with a pre-flip v0.2.78 tree binary, reports `rewrote 1 Dyn(...) spelling(s)` and changes the variant declaration to `Box(Dyn(x : i32)),`. A `yo check` afterwards fails:

```text
error: Expected a trait type for argument 1 of 'Dyn' expression.
  --> <file>:2:13
  |
2 |   Box(Dyn(x : i32)),
  |             ^
```

The `.Dyn(...)` constructor and pattern are untouched, because their head is the `.` prefix.

In the std/src sweep, the multi-line `TypeInfo` variant at `std/prelude.yo` (`Dyn(required_traits : …, negative_traits : …)`) is listed with the advice to write `Box(Dyn(required_traits : …))`, which is wrong in the same way.

## Root cause

`_unsized_sites_expr` (`src/main.yo`) treats every call whose head is `Dyn` as a type spelling (kind 0) unless its parent is a wrapping head. It does not exclude an argument of `enum(...)`, where `Dyn(...)` declares a variant.

## Fix direction

Skip the direct arguments of `enum(...)` (and `union`-style declarations, if any reuse the variant syntax): a variant declaration is never a type spelling. The variant's field types are still visited, so `Wrap(inner : Dyn(T))` is still rewritten. The repro then becomes a test: the migration must leave the file unchanged and it must still check.

## Fix

The flip (#1970) retired the mode's syntactic type-spelling pass: under v0.2.78 a bare `Dyn(...)` type is E0619 and
v0.2.77 is the release that migrates the type spellings (`issues/fixed/2026-11-15-what-does-migrate-unsized-do-under-the-binary-that-flips-dyn.md`).
`_unsized_sites_expr` is gone, and nothing in v0.2.78's mode reads a `Dyn(...)` call head. Measured with the develop
binary (`223b188f4`): the reproducer reports `rewrote 0` and is unchanged. The v0.2.77 binary keeps the defect; it is
published and not patched.

Test: the cli case `tests/cli-cases/fix-migrate-unsized-sites` declares a one-line `Dyn(x : i32)` variant, builds and
matches it, and expects the file unchanged after two runs and clean under `yo check`.
