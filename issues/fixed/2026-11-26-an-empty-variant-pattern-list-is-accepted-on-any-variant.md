# An empty variant-pattern list `.V()` / `.V({})` is accepted on any variant

**Severity:** S3 — `.Empty()` on a variant without fields and `.Rect()` / `.Circle({})` on variants with fields all compiled, as a fifth and sixth spelling of "this variant, whatever its payload"; on a variant with fields the empty list reads as "no fields", which is wrong.

- Filed and fixed: 2026-11-26 (lane `v81-bare-variant`, from VERDICTS-88 §9, probes `p4`, `p10`), on the v0.2.80 seed.

## Reproducer

```yo ignore
Shape :: enum(Circle(r : i32), Rect(w : i32, h : i32), Empty);
k :: (fn(s : &Shape) -> i32)(match(s, .Circle({}) => i32(1), .Rect() => i32(2), .Empty() => i32(3)));
export(k);
```

`yo check` passed.

## Root cause

`_compile_variant` (`src/evaluator/exprs/pattern-compile.yo`) ran its count check only for a non-empty positional list (`dparams.len() > 0`), and an empty list on a fieldless variant raised nothing, so every empty list compiled to the bind-nothing variant test.

## Fix

VERDICTS-88: a variant pattern has parentheses exactly when the variant has fields. `.Rect()` and `.Rect({})` are E0626 "An empty list names none of the fields of variant "Rect"" with the repair `(..)`; `.Empty()` (and `.Empty(..)`, `.Empty({})`, `.Empty(_)`) is E0626 "Variant "Empty" has no fields" with the repair deleting the group. Tests: the E0626 cases in `tests/match-bind-nothing.test.yo` and `tests/cli-cases/fix-writes-the-variant-pattern-shape`.
