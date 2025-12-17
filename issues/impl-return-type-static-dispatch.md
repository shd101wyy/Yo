# Implementation Plan: Static Dispatch for `Impl(Module)` Return Types

## Problem

Functions returning `Impl(Module)` (like `fn() -> Impl(RetI32)`) should support static dispatch for method calls on the return value. Currently, the codegen generates dynamic dispatch code (`void*` with vtable lookup) instead of static dispatch (concrete type with direct function call).

## Example

```yo
RetI32 :: module(
  return_i32 : (fn(self : *(Self)) -> i32)
);

impl(boolean, RetI32(...));

ret_boolean_i32 :: (fn() -> Impl(RetI32)) {
  return true;  // Returns boolean which implements RetI32
};

main :: (fn() -> unit) {
  b := ret_boolean_i32();           // b has type Impl(RetI32), concrete type is boolean
  assert(&(b).return_i32() == 1);   // Should call fn_id33365_return_i32(bool*)
};
```

## Current State

1. ✅ Function collection works - functions returning `Impl(Module)` are collected
2. ✅ Function generation works - declarations and definitions have correct concrete return types
3. ✅ Evaluator sets `resolvedConcreteType` on function call results
4. ❌ Variable declaration uses `void*` instead of concrete type
5. ❌ Method call generates dynamic dispatch instead of static dispatch

## Generated C Code (Current - Wrong)

```c
void* b = fn_id33456_ret_boolean_i32();  // Wrong: should be `bool b`
int32_t result = b->return_i32(b);       // Wrong: should be `fn_id33365_return_i32(&b)`
```

## Expected C Code

```c
bool b = fn_id33456_ret_boolean_i32();
int32_t result = fn_id33365_return_i32(&b);
```

## Root Cause Analysis

1. **Variable Declaration**: When `b := ret_boolean_i32()` is evaluated, the type of `b` is `SomeType` (from `Impl(RetI32)`). The codegen's `getTypeString` should use `resolvedConcreteType` but may not be seeing it.

2. **Method Resolution**: When `.return_i32()` is called on `b`, the evaluator needs to:
   - Detect that `b` has type `SomeType` with `resolvedConcreteType = boolean`
   - Find the `return_i32` implementation for `boolean`
   - Generate a direct function call, not vtable lookup

## Implementation Steps

### Step 1: Verify `resolvedConcreteType` Propagation

The evaluator sets `resolvedConcreteType` on function call results, but we need to verify:
- [ ] The type is properly cloned (not mutating shared type objects)
- [ ] The `resolvedConcreteType` survives through variable assignment
- [ ] The codegen sees the `resolvedConcreteType` when generating variable declarations

### Step 2: Fix Variable Declaration Codegen

In `src/codegen/expressions/generation.ts`, when generating variable declarations for `SomeType`:
- [ ] Check if the type has `resolvedConcreteType`
- [ ] Use `getTypeString(type.resolvedConcreteType, context)` instead of `void*`

### Step 3: Fix Method Call Resolution

In `src/evaluator/exprs/property_access.ts` or method call handling:
- [ ] When calling a method on a `SomeType` with `resolvedConcreteType`:
  - Use the `resolvedConcreteType` to find the correct impl
  - Set the method call's `functionValue` to the concrete implementation
- [ ] The codegen should then generate a direct function call

### Step 4: Ensure Codegen Uses Static Dispatch

In `src/codegen/expressions/generation.ts` for method calls:
- [ ] If the receiver type is `SomeType` with `resolvedConcreteType`, generate static dispatch
- [ ] The function name should be the concrete impl's function name
- [ ] Arguments should match the concrete impl's signature

## Files to Modify

1. `src/evaluator/calls/function.ts` - Already modified to set `resolvedConcreteType`
2. `src/codegen/expressions/generation.ts` - Variable declarations and method calls
3. `src/evaluator/exprs/property_access.ts` - Method resolution for `SomeType`
4. `src/env.ts` - `getMethodsByNameFromEnv` may need to handle `resolvedConcreteType`

## Testing

After fixes, this should work:
```sh
bun run src/yo-cli.ts compile src/tests/examples/fixme.yo --release -o test_fixme && ./test_fixme
```
