# Enum Data Destructuring — Syntax Clarification (NOT A BUG)

## Status: RESOLVED — was a syntax misunderstanding

## Summary

Enum data destructuring in match WORKS correctly with the positional syntax.
The original report incorrectly used `enum { Variant(name : Type) }` instead
of the correct `enum(Variant(Type))`.

## Correct Syntax

```rust
// ✅ WORKS — positional enum syntax
Shape :: enum(Circle(i32), Square(i32));
area := (fn(s : Shape) -> i32)(match(s, .Circle(r) => (r * r), .Square(side) => (side * side)));
r := area(.Circle(i32(5)));
// r == 25

// ✅ Multi-field enum variants
Shape :: enum(Circle(i32), Rect(i32, i32));
area := (fn(s : Shape) -> i32)(match(s, .Circle(r) => (r * r), .Rect(w, h) => (w * h)));
r := area(Shape.Rect(i32(4), i32(7)));
// r == 28
```

## Incorrect Syntax (what caused the original report)

```rust
// ❌ NOT SUPPORTED in self-hosted evaluator
Shape :: enum { Circle(radius : i32), Square(side : i32) };
s := Shape.Circle(radius: i32(5));
```

## Key Rules

1. Enum definition uses `enum(Variants...)` not `enum { Variants... }`
2. Variant fields are positional: `Circle(i32)` not `Circle(radius : i32)`
3. Construction uses positional args: `.Circle(i32(5))` or `Shape.Circle(i32(5))`
4. Destructuring in match: `.Circle(r) => expr` binds positional fields

## Discovered

Phase 5ed testing. Correctly diagnosed Phase 5ey.
