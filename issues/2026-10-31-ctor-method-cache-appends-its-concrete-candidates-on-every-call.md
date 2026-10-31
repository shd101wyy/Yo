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

## Fix (not applied here)

```yo ignore
out := match(
  g_ctor_method_cache.with(m => m.get(&key)),
  .Some(ce) => ce.impls.clone(),
  .None => _collect_generic_ctor_method_impls(ctor_fid, method) // (kept inside the miss arm)
);
```

i.e. clone the cached list before appending, so the stored entry stays
generic-only. Left for its own change: the fix changes what
static-argument inference sees (each concrete candidate exactly once), which
needs its own test selection (`tests/static_argument_inference.test.yo` and
the inference-feeding internal files), not a rider on an unrelated
performance PR.

## Verification plan (for the fixing change)

- A unit check that two consecutive `impls_of_constructor_method` calls with
  an unchanged epoch return lists of the SAME length.
- `yo test ./tests/static_argument_inference.test.yo --parallel 1` and the
  Tier-1 internal selection for `src/evaluator/values/impl.yo`.
