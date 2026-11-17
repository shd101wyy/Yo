# A directory check fails a `derive(..., Copy, Clone)` over an `Array` field of a same-module struct

**Severity:** S2 (a wrong rejection — the two files check green alone and the pair fails only under the
combined directory check; loud, never a wrong binary)

Filed from the v0.2.79 README-projects sweep (raylib_yo's `check ./src`), 2026-11-17. Present on the
v0.2.78 seed and on develop `c1363dc91` alike.

## Repro

Two files in one directory; `yo check <dir>` (or `yo check main.yo`, which demand-loads `lib.yo`):

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
main :: (fn() -> unit)({ m := Matrix(m0 : f32(1), m1 : f32(2)); println(`${m.m0}`); });
export(main);
```

```text
error: derive on "VrStereoConfig" failed: Cannot unify incompatible struct types: "Matrix" and "Matrix"
```

Each file alone is green; only the combined check fails. `VrStereoConfig`'s `Array(Matrix, 2)` field is
load-bearing: a struct of plain `Matrix` fields derives fine.

## Where to look

The demand-loaded second evaluation's `Matrix` type identity clashing with the directly-checked one —
the same file evaluated through two module paths (the two-spellings pitfall in AGENTS.md) inside the
derive's comptime trial over an `Array(T, N)` of the module's own struct. `_canonical_module_path` is
the usual first suspect.
