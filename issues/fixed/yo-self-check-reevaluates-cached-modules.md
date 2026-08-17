# yo-self `check <dir>` re-evaluates already-cached modules — impl re-registration under fresh type identities breaks later dispatch

**Status: FIXED 2026-08-17.** Surfaced by the strict def-eval fatal
(issues/fixed/yo-self-check-misses-undefined-variable.md): GATE 3
(`check ./std`) failed on `std/string/string.yo` with

```
No matching call found with arguments:
!(self == other)
  std/string/string.yo:1571:14
```

but ONLY in a directory-wide check — the file alone checks clean.

## Reproduction (deterministic, 9 files)

A tree-minimization bisect (delete-halves over a copied std/ while the
signature persists) converged on string.yo plus exactly its own import
closure: `prelude.yo, allocator.yo, libc/{string,stdio,stdint}.yo,
string/{rune,string_builder}.yo, collections/array_list.yo`. No external
"poisoner" file exists — the ingredient is the module being loaded TWICE:
first as a DEPENDENCY (of the prelude/earlier files), then re-checked as a
top-level file. (An earlier remove-one-half bisect fingered
`std/allocator.yo`; that was an artifact — removing a hub file cascades
import failures that reshuffle everything downstream.)

## Root cause

TS's `check` driver reuses one CodeGenerator precisely so that "a file that
was already loaded as a dependency of an earlier file is a cache hit on the
second pass; we still re-run the 'evaluator OK' report … but no real work
happens" (yo-cli.ts:592-598). yo-self's `mm_load_file` had that guard for
the PRELUDE ONLY — added when re-evaluating the prelude corrupted
where-constrained generic-impl resolution
(issues/fixed/seed-built-stage1-array-fill-method-miss.md) — and every other
cached module was RE-EVALUATED: impls re-registered under fresh type
identities, so the re-check's def-eval of the `Eq(String)` impl's `(!=)`
body dispatched `==` against split registration state and found no
candidate. Latent for as long as the def-eval swallow ate the error; fatal
once the re-raise landed.

## Fix

Generalize the guard (`yo-self/module_manager.yo`, mm_load_file): resolve
the entry path first; when `module_cache_has(abs)`, report "evaluator OK"
and return the cached exports (`load_module_from_cache`) without parsing or
re-evaluating — exact TS parity.
