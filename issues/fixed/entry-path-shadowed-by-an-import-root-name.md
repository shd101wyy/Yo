# An entry file whose path starts with a mapped import name loses its module identity

**Status:** FIXED (2026-09-12) — `mm_resolve_entry_abs` resolves the entry as a
FILE PATH (`resolve_module_path_ex(..., consult_import_roots : false)`).

## Symptom

A `--static-library` build of a package exported **no symbols**, so the program
linking it failed:

```
Undefined symbols for architecture arm64:
  "_square", referenced from: ___yo_user_main in app_chunk000.o
```

The archive was built and was 512 bytes with an empty object; the emitted C had
`static inline int32_t yo_id_7037(int32_t n)` where a library must emit
`int32_t square(int32_t n)`.

## Reproducer

A package at `mathlib/src/lib.yo` (`square :: (fn(n : i32) -> i32)(n * n);
export(square);`) and an imports file mapping that same name:

```
$ printf 'mathlib=mathlib/src/lib.yo\n' > x.imports
$ yo compile mathlib/src/lib.yo --static-library --imports x.imports -o libmathlib
$ grep -c 'int32_t square(' libmathlib.c
0                      # 2 without --imports, or when the mapping names anything else
```

The discriminating variants, all with the same file:

| entry path | mapping | plain export |
| --- | --- | --- |
| `mathlib/src/lib.yo` | none | **yes** |
| `mathlib/src/lib.yo` | `other=mathlib/src/lib.yo` | **yes** |
| `<abs>/mathlib/src/lib.yo` | `mathlib=<abs>/mathlib/src/lib.yo` | **yes** |
| `mathlib/src/lib.yo` | `mathlib=…` (relative or absolute) | **no** |

So the trigger is not `--imports` itself: it is an entry path whose FIRST
SEGMENT matches a mapped import name.

## Root cause

`mm_resolve_entry_abs` (src/module_manager.yo) ran the command-line path through
`resolve_module_path`, and that function's **rule 0** treats a leading segment
as an import-root name: head `mathlib` → root `<abs>/mathlib/src/lib.yo` → root
dir `<abs>/mathlib/src` → rest `src/lib.yo` → `<abs>/mathlib/src/src/lib.yo`.
`--profile` shows the bogus identity directly:

```
profile: module 0.6 ms .../mathlib/src/src/lib.yo
```

That path does not exist, so the resolver reported NotFound and the loader fell
back to the typed path and parsed the right file — but the module ENV was
created for the rewritten key. Codegen decides which top-level exports get
plain, externally-linked C names by comparing the defining token's module path
against `context.current_module_path`
(`_is_entry_module_path`, src/codegen/functions/collection.yo); the comparison
matched nothing, so every export fell back to its mangled `static inline` name.
Same family as `issues/fixed/static-library-exports-no-symbols.md`, one layer
further out: there the two spellings differed, here the entry's identity was
rewritten outright.

## Fix

Rule 0 belongs to `import("…")` specifiers, not to a filesystem path typed on
the command line. `resolve_module_path_ex(path, dir, std, consult_import_roots)`
carries the switch; `resolve_module_path` keeps passing `true`, and
`mm_resolve_entry_abs` passes `false`.

## Gate

`tests/cli-cases/build-dep-artifact` — a path dependency whose own `build.yo`
defines a static library, consumed through `dep.artifact(...)`. It is the
natural shape of this bug: the dependency lives in `./mathlib` and the manifest
maps it as `mathlib`, so the runner's child compile names the entry
`mathlib/src/lib.yo`. Verified red before the fix (undefined `_square`).
