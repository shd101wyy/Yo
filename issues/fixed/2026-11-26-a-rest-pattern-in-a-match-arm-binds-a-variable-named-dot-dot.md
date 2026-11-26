# A rest pattern `..` in a match arm binds a variable named `..`, or fails with an uncoded arity error

**Severity:** S3 — Rust's rest pattern is not Yo syntax, yet `.Rect(a, ..)`, `(1, ..)` and `(..)` compiled (each `..` a binding of the element at its position), and `.Rect(..)` failed with the uncoded `Variant "Rect" expects 2 parameters, got 1`, which does not say that the bare `.Rect` is the spelling; `Point(x : 0, ..)` was E0406 `Label ".." not found`.

- Filed and fixed: 2026-11-26 (lane `v81-bare-variant`), on a tree binary built from develop `997c71269`.

## Reproducer

```yo ignore
Shape :: enum(Circle(r : i32), Rect(w : i32, h : i32), Empty);
kind :: (fn(s : &Shape) -> i32)(match(s, .Circle(_) => i32(1), .Rect(..) => i32(2), .Empty => i32(3)));
first :: (fn(t : Tuple(i32, i32)) -> i32)(match(t, (1, ..) => i32(1), _ => i32(0)));
export(kind, first);
```

```text
error: Variant "Rect" expects 2 parameters, got 1
   --> tmp/fixme.yo:2:65
```

With the `.Rect(..)` arm removed, `first` compiled: `(1, ..)` bound the tuple's second element to a variable named `..`.

## Root cause

The lexer reads `..` as an operator atom. `compile_pattern` (`src/evaluator/exprs/pattern-compile.yo`) treats any atom that names no constant as a binding, so `..` bound its position. `_compile_variant` checked the positional arity before compiling the sub-patterns, so `.V(..)` (one sub-pattern) failed the arity check of a multi-field variant; `_compile_struct` read a bare `..` as a field name.

## Fix

`..` is E0609 ("`..` is not a pattern: Yo has no rest pattern") wherever the pattern compiler meets it, checked before the arity and label checks, with one repair each: `.V(..)` → `.V` (the bare form matches any payload); a `..` among positional sub-patterns → one `_` per element it stands for, or deleting `, ..` when it stands for none; in a labeled variant pattern or a struct pattern (both partial already) → deleting `, ..`; a lone `..` → `_`. `yo fix` applies them. Tests: the `..` cases in `tests/match-bind-nothing.test.yo`, `tests/cli-cases/a-rest-pattern-is-e0609`, `tests/cli-cases/fix-writes-a-bare-variant-for-a-rest-pattern`. The binder and curly-field-list sites stay open: `issues/2026-11-26-a-rest-pattern-outside-a-match-pattern-is-a-binding-or-the-block-error.md`.
