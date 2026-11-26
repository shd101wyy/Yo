# A rest pattern `..` in a match arm binds a variable named `..`, or fails with an uncoded arity error

**Severity:** S3 — `.Rect(a, ..)`, `.Circle(..)` (one field), `(1, ..)` and `(..)` compiled, each `..` a binding of the element at its position; `.Rect(..)` on two fields failed with the uncoded `Variant "Rect" expects 2 parameters, got 1`; `Point(x : 0, ..)` was E0406 `Label ".." not found`.

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

The lexer reads `..` as an operator atom. `compile_pattern` (`src/evaluator/exprs/pattern-compile.yo`) treats any atom that names no constant as a binding, so `..` bound its position. `_compile_variant` checked the positional arity before compiling the sub-patterns, so `.V(..)` (one sub-pattern) failed the arity check of a multi-field variant and bound `..` on a one-field variant; `_compile_struct` read a bare `..` as a field name.

## Fix

VERDICTS-88: `..` written alone in a variant's parentheses, `.V(..)`, matches the variant whatever its payload (a variant test with no sub-patterns). Every other `..` the pattern compiler meets is E0609 ("`..` stands for a variant's whole payload and is written alone, as `.V(..)`"), checked before the arity and label checks, with one repair each: among positional sub-patterns, one `_` per element it stands for, or deleting `, ..` when it stands for none; in a labeled variant pattern or a struct pattern (both partial already), deleting `, ..`; alone as a whole pattern, `_`. `yo fix` applies them. Tests: the `..` cases in `tests/match-bind-nothing.test.yo`, `tests/cli-cases/a-rest-pattern-is-e0609`, `tests/cli-cases/fix-writes-the-variant-pattern-shape`. The binder and curly-field-list sites stay open: `issues/2026-11-26-a-rest-pattern-outside-a-match-pattern-is-a-binding-or-the-block-error.md`.
