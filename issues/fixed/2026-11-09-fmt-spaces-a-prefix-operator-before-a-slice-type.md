# `yo fmt` spaces a prefix operator before a slice type

**Severity:** S3: `yo fmt` lays out `&[i32]` as `& [i32]`. The program is unchanged; only the layout is wrong.

Found 2026-11-09 while formatting `tests/unsized_pointers.test.yo` (decision 49 S1b+S1c). The bug was only on the branch: `[T]` became a type in decision 49 S1a, which had not shipped.

## Repro

```yo ignore
f :: (fn(xs : &[i32]) -> unit)(());
```

`yo fmt` rewrites the parameter as `xs : & [i32]`. `*[u8]` and `?*[u8]` get the same space.

## Root cause

A prefix-capable operator in prefix position prints tight when the next token starts its operand (`next_starts_prefix_operand` in `is_tightly_bound_operator`, `src/formatter.yo`). That check accepted an atom-like token or another prefix operator, but not `[`. Before decision 49, `[` never started a prefix operand, because the parser rejected `[T]`.

## Fix

`next_starts_prefix_operand` also accepts `[`.

Test: `tests/internal/formatter.test.yo`, "fmt: a prefix operator before a slice type is tight".
