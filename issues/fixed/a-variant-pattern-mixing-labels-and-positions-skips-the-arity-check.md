# A variant pattern that mixes labeled and positional fields skips the arity check

**Severity:** S2 — an invalid pattern with more fields than the variant has is accepted silently, and its extra positional binders bind nothing

**Found:** 2026-10-03, while removing `SomeT.is_effects_row` (the `...(E)` effect-row spread removal, `issues/fixed/effect-row-spreads-outlived-the-single-bundle-future.md`): `collect_wrapper_trait_somes` in `src/evaluator/types/function.yo` kept the 11-argument pattern `.SomeT(_, _, _, _, required_trait_types : rts, _, _, _, _, _, _)` after `SomeT` went to 10 fields, and `yo check ./src` passed it. **Status:** FIXED 2026-10-03.

## Reproducer

```rust
{ println } :: import("std/fmt");
E :: enum(A(a : i32, b : i32), B);
main :: (fn() -> unit)({
  e := E.A(a : i32(1), b : i32(2));
  r := match(e, .A(_, b : y, _) => y, _ => i32(0));   // 3 sub-patterns, 2 fields
  println(r);
});
export(main);
```

`yo check` accepts it and the binary prints `2` (v0.2.49 seed). The all-positional form `.A(_, _, _)` is rejected: `Variant "A" expects 2 parameters, got 3`.

## Root cause

`src/evaluator/exprs/pattern_compile.yo` (the variant-destructuring arm, ~line 780) runs the arity check only when `!has_labeled`, so labeled partial patterns (`.SomeT(name : n)`) may omit fields. A positional sub-pattern in a mixed list then takes `fidx = pi`, and when `pi >= arity` the field type lookup falls back to `TypeValue.Unit` instead of reporting an error.

## Fix direction

In a mixed list, reject a positional sub-pattern whose index is `>= arity` (`Variant "A" has 2 fields; positional sub-pattern 3 is out of range`), keeping labeled partial patterns legal. Regression: the reproducer above under `comptime_expect_error`.

## Fix

`src/evaluator/exprs/pattern_compile.yo`: a labeled (or mixed) variant pattern that lists more sub-patterns than the variant has fields is an error, `Variant "A" has 2 fields, but the pattern lists 3`. Labeled partial patterns, which list fewer, stay legal.

Regression test: "a mixed labeled/positional pattern with too many fields is rejected" in `tests/match_curly.test.yo`.
