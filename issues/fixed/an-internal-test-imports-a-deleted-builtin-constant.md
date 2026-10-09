# Two internal tests still name the builtins the snake_case rename deleted

**Severity:** S3: test-only. `tests/internal/typeof.test.yo` stopped compiling and `tests/internal/lsp_protocol.test.yo` failed an assertion on `develop` (CI run 37886009263, shard 2); no shipped code is affected.

## Symptom

```
{ AstExpr, ast_expr_id, BF_TYPEOF } :: import("../../src/expr.yo");
```

`src/expr.yo` no longer exports `BF_TYPEOF`: #1283 (V3b Generation B, the
C-style builtins become snake_case) deleted `BF_TYPEOF`/`BF_SIZEOF`/
`BF_ALIGNOF`/`BF_TYPEID` in favour of `BF_TYPE_OF` and friends. Found while
sweeping `tests/internal/` with `yo fix --migrate params`: the file was the one
that did not evaluate.

`tests/internal/lsp_protocol.test.yo`'s "rename_rejection: only legal binding
names pass" asserted that `typeof` is a reserved binding name. It no longer is
(`type_of` is), so the assertion aborted with "reserved builtin binding name".

## Root cause

The rename's sweep rewrote call sites (`typeof(x)` → `type_of(x)`) but not
imports of the Yo-side constant names, and `tests/internal/` is not part of the
local gate battery (only `diagnostics_registry_examples` is), so nothing ran the
file before the merge.

## Fix

`BF_TYPEOF` → `BF_TYPE_OF` (three sites); the rename test asserts that
`type_of` is reserved and that `typeof` is now an ordinary name. Both files are
their own regression tests.
