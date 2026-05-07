# Issue: `String.from(\`backtick\`)` produces "Cannot unify String and str"

## Status: BY DESIGN — backtick literals produce `String`, not `str`. Use `String.from("...")` (plain string literal) or pass `s.as_str()` to APIs that need `str`. The error message could be more specific in the future, but the behavior is correct.

## Status: Discovered (expected behavior, not a bug — use `String.from("...")` instead)

## Description

Using a backtick template literal as the argument to `String.from()` causes a compile-time
type error:

```
Error: Cannot unify incompatible struct types: "String" and "str"
```

## Root cause

In Yo, backtick literals (`` `...` ``) always produce a value of type `String` (the heap-allocated
mutable string type). However, `String.from` is defined as:

```rust
from : (fn(slice: str) -> Self)({ ... })
```

It takes a `str` (a borrowed string slice), not a `String`. Passing a backtick literal
directly as the argument passes `String` where `str` is expected, causing a type unification
failure.

The error location reported by the evaluator is the outermost function boundary (not the
inner call), which made this hard to locate initially.

## Example of failing code

```rust
// WRONG — backtick literal produces String, but String.from expects str
msg := String.from(`Expected ":=" or "::" for initialization assignment.`);
```

## Fix

Use double-quoted `str` literals instead of backtick literals when the string has no
interpolation:

```rust
// CORRECT — double-quoted literal is str
msg := String.from("Expected \":=\" or \"::\" for initialization assignment.");
```

## When to use backtick vs double-quote

- Use `` `...` `` (backtick) when you need string interpolation: `` `Hello ${name}!` ``
- Use `"..."` (double-quote) for plain string literals that produce `str`
- Use `String.from("...")` to convert a `str` literal to a heap-allocated `String`
- Do NOT use `String.from(\`...\`)`— this wraps`String`in`String.from(str)`, which fails

## Discovered

During Phase 2w porting of `yo-self/evaluator/exprs/init_assignment.yo`.

## Affected files

- `yo-self/evaluator/exprs/init_assignment.yo` — fixed during porting

## Documentation updated

- `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` — String/str section
- `.github/skills/yo-syntax/syntax-cheatsheet.md` — literals section
