# A trait default was materialized in the implementing module's scope, not its own

**Status:** FIXED 2026-09-28 (branch `tss/p6-generic-reraise`)
**Found:** 2026-09-28, by Phase 6 step 2's site-#14 re-raise: `tests/cli-cases/check-coherence-legitimate-impls`
started failing `check`.

## Symptom

A module that writes `impl(Point, Format());` (taking `Format`'s `format` default) but does not
import `FormatSpec` got, once the default's materialization failure was no longer swallowed:

```
error[E0401]: Variable "FormatSpec" not found.
  --> main.yo:14:13
14 | impl(Point, Format());
note: raised in the default body of "format", which trait Format gives Point because this impl does not provide it
  --> std/fmt/format.yo:58:14
58 |         s := FormatSpec.parse(spec);
```

## Mechanism (MEASURED)

`evaluate_impl_expression`'s per-impl materialization of a trait default (`values/impl.yo`,
`_materialize_default_body`'s caller) pushed its parameter frame onto the IMPL's environment and
evaluated the default body there. Names the default's own module binds (`FormatSpec` in
`std/fmt/format.yo`) were therefore looked up in the implementing module. Before Phase 6 the
failure was swallowed and the shared default (evaluated at trait creation, in the right scope)
was used instead, so the bug only showed as a hollow materialization — and as an extra function
in `compile-profile`'s count.

## Fix

The materialization builds its environment from the default FuncVal's own definition scope,
exactly as a call does (`capture_env_for` with the default's `env_key` and captures, the
default body's module path), then binds the Self-substituted parameters there.
Test: `tests/cli-cases/check-coherence-legitimate-impls` (and `compile-profile`'s function count).
