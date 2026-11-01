# `impls_of_constructor_method`'s cache returns the STORED list and then pushes the concrete candidates into it on every call

**Severity:** S3 — static-argument inference re-scans an ever-growing duplicate
list within one trait-impl epoch (wasted work), and the returned candidates
repeat, so any consumer that registers or specializes per entry repeats itself
per call.

Discovered while studying the generic-impl registry for the
`find_methods_from_generic_impls` cache (2026-10-31, VBD v0.2.74 window); this
is pre-existing on develop (`fd206efe7`).

## Symptom

`impls_of_constructor_method` (`src/evaluator/values/impl.yo`) serves the
cached generic half and then appends the concrete half:

```yo ignore
out := match(g_ctor_method_cache.with(m => m.get(&key)), .Some(ce) => ce.impls, .None => ArrayList(CtorMethodImpl).new());
...
while(ci < n_conc, ci = (ci + usize(1)), {
  ...
  out.push(CtorMethodImpl(...));
  ...
});
out
```

`ce.impls` is the STORED `ArrayList` handle, so every call within one
`(ctor_fid, method)` key and one `trait_impl_epoch` appends the current
concrete candidates to the SAME list again. Call it k times while the epoch
stands and the list holds `generic + k × concrete` entries; the duplicates are
returned to the caller each time and re-scanned by static-argument inference.

## Root cause

The cached list is treated as a per-call result. It is the cache's STORAGE;
the concrete half must go into a per-call copy (or the concrete half must be
cached beside it).

## Fix (applied)

The cached entry is the cache's STORAGE and stays generic-only: the hit path
copies its elements into a fresh per-call `ArrayList` (shallow element copies —
the binder/pattern handles are what callers already read through) before the
concrete half is appended. `impls_of_constructor_method`
(`src/evaluator/values/impl.yo`) now returns `generic + concrete` exactly once
per call.

## Verification

- New regression test in `tests/internal/type_trait_methods.test.yo`
  ("impls_of_constructor_method: repeated calls within one epoch return the
  same list"): registers one visible concrete ctor method, calls the function
  twice with an unchanged epoch, asserts both lists have the same length and
  exactly one entry. FAILED on the unfixed tree (first=1 second=2, rc=1) and
  PASSES with the fix.
- `yo test ./tests/static_argument_inference.test.yo --parallel 1` — pass.
- Tier-1 internal selection for `src/evaluator/values/impl.yo`
  (`type_trait_methods`, `module_invalidation`, `check_watch`) — pass, one
  file per call.
- Emit-diff of `src/main.yo` against a develop-built base binary — identical
  (the deduplicated candidate list changes no emitted C).

