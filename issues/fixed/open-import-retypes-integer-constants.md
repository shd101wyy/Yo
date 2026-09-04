# `open(import(m))` re-types every exported integer constant from its VALUE

**Status: FIXED 2026-08-28** (`src/evaluator/exprs/open.yo`, the D3.9 Hasher PR).
**Found:** 2026-08-28 — `tests/hash.test.yo` did `open(import("std/hash"))` and
`d.k0 == DEFAULT_KEY_0` (a `u64` field against `DEFAULT_KEY_0 :: u64(0)`)
failed with `Cannot unify incompatible types: "u64" and "i32"` — reported at
`1:1` with no location.
**Severity:** MEDIUM — a hard compile error, but a confusing one (no location,
and the same program with a named import works), and it made every exported
integer constant of a width other than `i32` unusable through `open`.

## Trigger

```rust
// m.yo
K7 :: u64(7);
S3 :: usize(3);
export(K7, S3);

// user
open(import("./m.yo"));
z := (K7 + u64(1));      // ❌ Cannot unify "i32" and "u64"
{ K7 } :: import("./m.yo");
z := (K7 + u64(1));      // ✅
```

Any width other than the literal default (`u8`, `u16`, `u32`, `u64`, `usize`,
`i8`, `i16`, `i64`, `isize`) triggers it; `i32` constants were fine by
coincidence.

## Root cause

`evaluate_open`'s module branch binds each export with

```rust
field_ty := match(field_val,
  .FuncVal(...) => get_func_type(...),          // registered Func type
  .StructVal(...) => declared type, else type_of_eval_value,
  _ => type_of_eval_value(field_val));          // ← everything else
```

`type_of_eval_value(IntVal 7)` is the literal default `i32`. The namespace
struct type already carries each export's DECLARED type (`field_labels` /
`field_types` in lockstep with the module's names/values — the same arrays the
struct-valued arm consults), and the named-import path binds from it, which
is why the two forms disagreed.

## Fix

Every non-function member takes the declared type when the label at the same
index matches (the existing `declared_ty_opt`), falling back to
`type_of_eval_value` only when the namespace type is absent (the cycle /
no-loader path). Functions keep the registered Func type as before.

## Regression test

`tests/open_import_constants.test.yo` over the fixture
`tests/open_import/constants.yo` — every integer width through `open`,
non-integer exports unchanged, and `open` vs named import agreeing.
