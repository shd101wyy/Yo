# Memory leak: `_ :=` discards RC-typed values without dropping

**Status:** Fixed (commit e7370305)

## Problem

When writing `_ := expr` where `expr` returns an RC-typed value (e.g., `Result`, `Option`, `String`), the value was **never dropped**, causing a memory leak.

### Root cause

`addVariableToFrame` in `env.ts` has a fast-path that skips `_` variables:

```typescript
if (variable.name === "_") {
  return frame; // Variable never stored in the frame
}
```

This means:

1. The `_` variable is never tracked in the frame
2. At scope exit, the codegen walks frame variables to emit `___drop` calls — `_` isn't there
3. The RC-typed value leaks

Additionally, multiple `_ :=` in the same scope generated duplicate C variable declarations (`__yo_enum... _ = ...;` twice), which is a C compilation error.

### Affected code

```rust
// std/collections/hash_set.yo
_ := result_set.add(element);  // Result leaks

// std/collections/linked_list.yo
_ := self.pop_front();  // Option leaks

// Any user code
_ := m.set(`key`, `value`);  // Result(Option(String), HashMapError) leaks
```

## Fix

In `initialization-assignment.ts` (evaluator), when the LHS is `_`, rename it to a unique temp variable name before calling `addVariableToEnv`. This ensures:

- The value is tracked in the frame (proper drop at scope exit)
- Each `_` gets a unique C variable name (no duplicate declarations)
- The `addVariableToFrame` skip for `_` is no longer reached from init-assignment

The codegen reads the renamed name from `lhs.$.variableName`.

### Files changed

- `src/evaluator/exprs/initialization-assignment.ts` — rename `_` to temp name
- `src/codegen/exprs/initialization-assignment.ts` — use `$.variableName` fallback

## Follow-up: comprehensive `_` handling (commit fd28cd21)

### Reassignment `_ = expr`

Reassigning `_` (e.g., `_ = i32(42)`) now produces a compile error:

> Cannot reassign "\_". Use ":=" to discard a value, or use a named variable for reassignment.

Since `_` is never stored in the frame, reassignment would always fail with "Variable not found". The new error message is more helpful.

### Destructuring with `_`

In destructuring like `_(x: _, y: val) := point`, the `_` field binding is properly skipped in C codegen — no variable declaration is emitted for discarded fields. This prevents duplicate C declarations and unnecessary value extraction. No RC leak because destructuring uses `isOwningTheRcValue: false` (borrows, not owns).

### Match arm `_` bindings

Already correctly handled — evaluator skips `addVariableToEnv` for `_`, codegen skips extraction. The scrutinee owns the values and handles their cleanup.
