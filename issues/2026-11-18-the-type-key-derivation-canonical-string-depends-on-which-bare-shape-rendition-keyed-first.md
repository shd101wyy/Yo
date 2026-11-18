# The type-key derivation's canonical string depends on which bare-shape rendition keyed first

**Severity:** S3 (no wrong binary: shapes, tags, layouts, rc and stderr are identical; the emitted C's
synthesized enum-identity NAMES differ between compiler builds of the same program — visible in emitted-C
diffs and incremental caches, not in behavior)

Found 2026-11-18 by the 3e retype's G3b corpus swap (149/150 identical; the one differing program
`tests/codegen-bootstrap/assigned_param_overload_select.yo`). Fix is v0.2.80.

## What

Two compilers that agree on a program's semantics emitted C differing in exactly one eval-fresh enum
identity:

```text
B0: enum_std__prelude_Call_s2_r8535c2_n88_value_i64_error_str
B1: enum_std__prelude_Call_s2_r8535c2_n88_value_i64_error__str
```

Anchors, tags, layouts, sizes, rc and stderr identical; each binary self-deterministic across four fresh
compiles; B0 ≠ B1 reproducible. The program's shape: overloaded trait impls (`TryInto(i32)` /
`TryInto(i64)`) whose `Result` returns the Call desugar mints eval-fresh.

## Where

`type_key`'s eval-fresh enum canonicalization walks the bare-shape adoption tables
(`g_enum_bare_unclaimed` / `g_enum_bare_claims`, `src/types/type_key.yo` ~60–110): the canonical string
depends on which rendition of a bare shape keyed FIRST — an evaluation-order sensitivity of key
derivation. The `EvalValue` retype (3e) changed evaluation order on this path, flipping the separator
spelling; any order change (not only the retype) can flip it.

## Fix shape (v0.2.80)

Normalize the canonical choice in the adoption tables (pick by a stable criterion — lexicographic
rendition, or a canonical construction — instead of first-keyed). Until then the deviation is recorded in
the 3e PR body and its gate artifacts (`vbd-logs/retype3e/g3b-3e.txt`, `/tmp/r3d_g3b_3e/`).
