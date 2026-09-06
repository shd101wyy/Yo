# `cond` with a comptime-TRUE condition in a non-first arm emits a dangling `else`

**Status: FIXED 2026-09-06** (`src/codegen/exprs/cond.yo`, PR #437).

**Severity: invalid C from valid Yo.** The batch fails to compile, so every test
in the batch is lost — or, in a value-returning fn, the body becomes an
`abort()` stub.

## Symptom

```rust
f :: (fn(x : i32) -> i32)(
  cond(
    (x > 10) => i32(1),
    (sizeof(i32) == usize(4)) => i32(2),   // comptime true, NOT the first arm
    true => i32(3)
  )
);
```

```
error: expected expression
      else {
      ^
```

The emitted C is `if (x > 10) { … } else { … else { … } }` — the comptime-true
arm was written as a bare `else { body }` and the following `true =>` arm was
then written as ANOTHER `else`, with no `if` for it to attach to.

## How it surfaced

`std/collections/array_list.yo` gained a zero-sized-element path
(`issues/fixed/unit-should-be-a-true-zero-sized-type-like-rust.md`):

```rust
cond(
  (cap == usize(0)) => Self.new(),
  size_would_overflow(T, cap) => __yo_panic(...),
  (sizeof(T) == usize(0)) => Self._zst_anchor(),   // comptime true at T = unit
  true => { ... }
)
```

Specialized at `T = unit` the third condition folds to `true`, and the
`ArrayList(unit)` batch stopped compiling. Any `cond` that mixes a runtime
guard with a type-level fact reaches this — generic std code is exactly where
that shape is natural.

## Root cause

`generate_cond_expression`'s if/else chain loop. It already knows a
comptime-true arm (`_cond_bool` → `is_ct_true`) and correctly writes it as a
bare `else {` (no `if`) — but it **kept iterating**, so the next arm's `else {`
landed inside that block with nothing to attach to. A comptime-true arm is the
chain's final `else`; everything after it is unreachable and must not be
emitted at all.

The first-arm case never hit this: `can_opt` collapses "first non-false arm is
comptime true" to direct emission before the loop. Only a comptime-true arm
AFTER at least one runtime arm reached the broken path.

## Fix

Stop the loop after a comptime-true arm (`ct_true_emitted`). The arm is still
written as the final `else { … }`; the unreachable tail is dropped.

## Regression test

`tests/basic.test.yo` — *cond: a comptime-true condition after a runtime arm is
the final else*: a runtime first arm, a `sizeof`-folded true second arm, and a
`true` third arm, in both value and statement position; asserts the runtime arm
still wins when it holds and the folded arm wins otherwise. Verified RED (batch C
compile failure) on the pre-fix binary.
