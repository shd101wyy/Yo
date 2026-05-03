# Enum Data Variant Destructuring in Match Fails

## Problem

When matching enum variants that carry data fields (e.g., `Shape.Circle(r: i32)`),
destructuring the fields in match arms (`.Circle(r) => (r * r)`) fails at runtime
with exit code 134.

## Reproduction

```rust
// FAILS — destructuring enum data in match
Shape :: enum { Circle(r : i32), Square(s : i32) };
area := (fn(sh : Shape) -> i32)(match(sh, .Circle(r) => (r * r), .Square(s) => (s * s)));
r := area(Shape.Circle(r: i32(5)));
export r;
```

```rust
// WORKS — simple enum without data, no destructuring
Direction :: enum { North, South, East, West };
d := Direction.East;
r := match(d, .North => i32(1), .South => i32(2), .East => i32(3), .West => i32(4));
export r;
```

## Working Patterns

- Simple enums without data fields: `enum { A, B, C }` — matching works fine
- Enum equality comparison: `(x == MyEnum.Variant)` — works
- Enum with data construction: `Result.Ok(val: i32(5))` — works for construction
- Enum data extraction via `match` without variable binding: NOT tested

## Root Cause (suspected)

The self-hosted evaluator's match implementation may not correctly bind
destructured variables from enum data variants. The construction of enum
variants with data works, but the pattern matching/destructuring side fails.

## Workaround

- Use simple enums without data for match tests
- For enums with data, only test construction and equality, not destructuring

## Discovered

Phase 5ef testing, bootstrapping session.
