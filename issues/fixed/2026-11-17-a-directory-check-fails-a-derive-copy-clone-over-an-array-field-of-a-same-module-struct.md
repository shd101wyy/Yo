# A directory check fails a `derive(..., Copy, Clone)` over an `Array` field of a same-module struct

**Severity:** S2 (a wrong rejection — the two files check green alone and the pair fails only under the
combined directory check; loud, never a wrong binary)

Filed from the v0.2.79 README-projects sweep (raylib_yo's `check ./src`), 2026-11-17. Present on the
v0.2.78 seed and on develop `c1363dc91` alike.

## Repro

Two files in one directory; `yo check <dir>` (or `yo check lib.yo main.yo`; `yo check main.yo` alone,
which demand-loads `lib.yo`, is green):

```yo
// lib.yo
Matrix :: struct(m0 : f32, m1 : f32);
VrStereoConfig :: struct(projection : Array(Matrix, 2), scale : Array(f32, 2));
derive(Matrix, Copy, Clone);
derive(VrStereoConfig, Copy, Clone);
export(Matrix, VrStereoConfig);
```

```yo
// main.yo
{ println } :: import("std/fmt");
{ Matrix, VrStereoConfig } :: import("./lib.yo");
main :: (fn() -> unit)({
  m := Matrix(m0 : f32(1), m1 : f32(2));
  println(`${m.m0}`);
});
export(main);
```

```text
error: derive on "VrStereoConfig" failed: Cannot unify incompatible struct types: "Matrix" and "Matrix"
```

Each file alone is green; only the combined check fails. `VrStereoConfig`'s `Array(Matrix, 2)` field is
load-bearing: a struct of plain `Matrix` fields derives fine.

## Root cause

Not a regression: v0.2.79 fails the same way (re-confirmed 2026-11-26 with the v0.2.79 release
binary; its `check` of several FILE arguments checked only the last one, which hid it there, but
`check <dir>` showed it).

`mm_load_file` (src/module-manager.yo) evaluates a check target through `mm_eval_entry_exprs` and
never put the result in the module cache. Its guard "ANY already-cached module is a HIT — never
re-evaluate it" covered a target that an EARLIER target had demand-loaded, but not the other order:
`check src` takes `lib.yo` first (as an entry, uncached), and `main.yo`'s `import("./lib.yo")` then
missed the cache and evaluated `lib.yo` a second time. The second evaluation minted a second
`Matrix` while the first evaluation's registrations (its `Array(Matrix, 2)` instances, its derived
impls) stayed live, and the two eras met inside the derived `Clone` for `Array(Matrix, 2)`
(`MaybeUninit(Self).new()`, std/prelude.yo): `Cannot unify incompatible struct types: "Matrix" and
"Matrix"` — the identical-names signature of an id/era split. The path spelling was not the
problem: the entry key (`mm_resolve_entry_abs`) and the import key are the same `file://` path.

## Fix

`mm_load_file` registers a successfully evaluated target in the module cache under its `file://`
key (`register_module`), as `_load_module_at_abs` does for a demand-loaded module. A later
target's import of it is a cache hit. A target that fails is not registered, as before. The
watch modes, `yo fix` and the LSP invalidate by key (`invalidate_module` removes the key and its
dependents whether or not it was cached), so an edited target is still re-evaluated.

## Verification

- `tests/cli-cases/check-a-target-that-a-later-target-imports-is-evaluated-once` (`yo check src`
  over this repro): `1/2 file(s) passed`, rc 1 on v0.2.80; `2/2`, rc 0 on the fixed tree.
- raylib-yo `yo check ./src` with the tree binary: green.
