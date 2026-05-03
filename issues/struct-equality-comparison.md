# Struct `==` Comparison Fails in Self-Hosted Evaluator

## Problem

When comparing two struct instances with `==` at module level, the self-hosted
evaluator crashes with exit code 134 (SIGABRT/unreachable).

## Reproduction

```rust
// FAILS — struct == struct
Box :: struct(size : i32);
b1 := Box(size: i32(10));
b2 := Box(size: i32(10));
r := (b1 == b2);  // crashes
export r;
```

```rust
// WORKS — struct field access and comparison of field values
Box :: struct(size : i32);
b1 := Box(size: i32(10));
b2 := Box(size: i32(10));
r := (b1.size == b2.size);  // works
export r;
```

## Workaround

Compare struct fields individually instead of entire structs.

## Root Cause (suspected)

The self-hosted evaluator's equality operator for `StructVal` values may not
be implemented or may not correctly compare struct instances.

## Discovered

Phase 5eq testing, bootstrapping session.
