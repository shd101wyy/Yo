# An internal test imports a builtin constant the snake_case rename deleted

**Severity:** S3: test-only. `tests/internal/typeof.test.yo` stopped compiling on `develop`; no shipped code is affected, but the file's own coverage of `evaluate_typeof` was lost and a `tests/internal` run fails on it.

## Symptom

```
{ AstExpr, ast_expr_id, BF_TYPEOF } :: import("../../src/expr.yo");
```

`src/expr.yo` no longer exports `BF_TYPEOF`: #1283 (V3b Generation B, the
C-style builtins become snake_case) deleted `BF_TYPEOF`/`BF_SIZEOF`/
`BF_ALIGNOF`/`BF_TYPEID` in favour of `BF_TYPE_OF` and friends. Found while
sweeping `tests/internal/` with `yo fix --migrate params`: the file was the one
that did not evaluate.

## Root cause

The rename's sweep rewrote call sites (`typeof(x)` → `type_of(x)`) but not
imports of the Yo-side constant names, and `tests/internal/` is not part of the
local gate battery (only `diagnostics_registry_examples` is), so nothing ran the
file before the merge.

## Fix

`BF_TYPEOF` → `BF_TYPE_OF` (three sites). `yo test tests/internal/typeof.test.yo`
passes; it is its own regression test.
