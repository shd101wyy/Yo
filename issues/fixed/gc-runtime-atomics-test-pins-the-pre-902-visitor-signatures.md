# `gc_runtime_atomics` pins the GC visitors' pre-#902 signatures

**Found:** 2026-09-26, on develop run 36206559953: "Compiler internal tests (… shard 0)".
**Status:** FIXED 2026-09-26. **Class:** stale test (a gate that went red on a correct change).

## Symptom

```
✗ every full-GC visitor tests TRACKED through the prefix before a full-header cast
  codegen pin marker not found in emitted C: static void __yo_gc_mark_gray_visitor(void* ptr) {
```

## Cause

#902 gave the six trial-deletion visitors in `src/codegen/functions/gc_runtime.yo` a second
parameter, `(void* ptr, void* child_traverse)`. The test finds each visitor's body by its exact
signature text, so it could no longer find them. #902's local gates ran
`tests/internal/diagnostics_registry_examples` but not the rest of `tests/internal`, which is
where emitted-runtime text is pinned.

## Fix

`tests/internal/gc_runtime_atomics.test.yo` pins the current signatures. The property it checks,
that each visitor tests `__YO_GC_TRACKED` through the prefix before any full-header cast, still
holds for all seven visitors.

## Regression test

The test itself, green again (6 passed).
