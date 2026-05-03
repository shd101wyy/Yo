# Multiple `::` Function Definitions at Module Level Break Evaluation

## Problem

When the self-hosted evaluator processes `:: fn` syntax (constant function definitions)
via `generate_exprs_from_code`, evaluation fails with exit code 134 (SIGABRT/unreachable).
This affects ALL `name :: fn(...) -> T { body }` definitions, even a single one.

## Reproduction

```rust
// FAILS — :: fn syntax
compute :: fn(x : i32) -> i32 { cond((x > i32(10)) => (x * i32(2)), true => (x + i32(10))) };
r := compute(i32(21));
export r;
```

```rust
// WORKS — := with anonymous function expression
compute := (fn(x : i32) -> i32)(cond((x > i32(10)) => (x * i32(2)), true => (x + i32(10))));
r := compute(i32(21));
export r;
```

## Working Pattern

All functions must be defined using `:=` with anonymous function expressions:

```rust
name := (fn(params) -> ReturnType)(body);
```

NOT:

```rust
name :: fn(params) -> ReturnType { body };
```

## Affected Patterns

- `name :: fn(...) -> T { body }` — constant function definition syntax
- Even a single `:: fn` definition fails

## Root Cause (suspected)

The self-hosted evaluator's `evaluate_module_body` via `generate_exprs_from_code`
does not properly handle `ConstDeclaration` (the `::` infix operator) for function
definitions. The manual AST-based test (`evaluate: :: fn constant`) works because
it builds the AST directly, but the parser path may produce a different AST shape.

## Workaround

Always use `:= (fn(...) -> T)(body)` pattern for function definitions in eval tests.

## Discovered

Phase 5ed testing, bootstrapping session.
