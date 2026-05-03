# `:: fn(...) -> T { body }` Shorthand Not Supported in Self-Hosted Evaluator

## Problem

The bare `name :: fn(...) -> T { body }` shorthand does NOT work when evaluated
via `generate_exprs_from_code`. The parser splits `{ body }` into a separate
expression instead of treating it as the function's body argument.

**However**, `name :: (fn(...) -> T)(body)` works perfectly!

## Root Cause

The Yo parser handles `{ ... }` after an expression differently:

- In `(fn(x : i32) -> i32)(body)`: the parenthesized type expr is complete,
  then `(body)` is an explicit call with it as the callee.
- In `fn(x : i32) -> i32 { body }`: the parser sees `fn(x:i32) -> i32` as a
  complete infix expression, then `{ body }` is parsed as a SEPARATE statement
  (either a struct literal or begin block depending on semicolons).

Additionally, there's an ambiguous operator precedence between `::` and `->`:

```
name :: fn(x : i32) -> i32 { body }
```

Could be: `name :: (fn(x:i32) -> i32 {...})` or `(name :: fn(x:i32)) -> i32 {...}`
The parser requires explicit disambiguation.

## Reproduction

```rust
// ❌ FAILS — bare fn syntax; { body } parsed as separate expression
compute :: fn(x : i32) -> i32 { (x + i32(1)) };
```

```rust
// ✅ WORKS — explicit (fn)(body) form with ::
compute :: (fn(x : i32) -> i32)((x + i32(1)));
```

```rust
// ✅ WORKS — same form with :=
compute := (fn(x : i32) -> i32)((x + i32(1)));
```

## Working Patterns

Both `::` and `:=` work with the explicit `(fn(...) -> T)(body)` form:

```rust
// Compile-time constant function (idiomatic for module-level functions)
name :: (fn(params) -> ReturnType)(body);

// Runtime variable holding a function
name := (fn(params) -> ReturnType)(body);
```

## Verified Working (via tests)

- Single `:: (fn)(body)` function definition ✅
- Multiple `::` function definitions in same module ✅
- Recursive functions with `recur(...)` using `::` ✅
- Functions calling other `::`-defined functions ✅

## NOT Working

- `name :: fn(...) -> T { body }` — bare shorthand ❌
- This is a PARSER issue, not an evaluator issue

## Discovered

Phase 5ed testing (initially misdiagnosed as evaluator bug).
Correctly diagnosed Phase 5ey: parser splits `{ body }` as separate statement.
