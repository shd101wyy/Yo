# N1e-1's `.*` rule broke the `yo explain` registry examples

**Severity:** S3. A develop CI shard went red, and `yo explain` showed examples that fail with E0926 instead of the code they explain. No compiler behavior was wrong.

**Status:** fixed 2026-11-04 by `fix/develop-e0909-example`.

## Symptom

Develop battery run 41823671930 on `c900b3fe6` (#1752) failed "Compiler internal tests (tests/internal, self-hosted differential shard 2)":

```
✗ every registry example reproduces its code, and every good example loads clean
  E0909: the bad example must fail with E0909, got "E0926"
```

## Root cause

The examples are Yo programs held in string literals in `src/diagnostics_registry.yo`. They load as user files, so N1e-1's E0926 applies to them, but `--migrate deref` never sees code inside a string literal. Eleven halves across eight codes read or wrote a `&`/`&mut` binding whole. E0920's examples cannot be reproduced in a user file at all, because the error now fires only in deref-exempt files.

## Fix

- The seven reproducible entries now spell `.*`: E0909, E0910, E0911, E0912, E0919, E0921 and E0922.
- `tests/internal/diagnostics_registry_examples.test.yo` exempts both halves of E0920 until N3 retires E0920.
- The test: that file failed before the fix and passes 1/1 after it.
