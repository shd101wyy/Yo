# Evidence function pointer void return ABI mismatch

## Summary

Evidence handler functions with forall return types (e.g., `Exception.throw :: fn(forall(T), error: AnyError) -> T`) are compiled with `void` C return type because `SomeType` maps to `void`. However, `generateEvidenceFnPtrCall` was casting the function pointer to return the concrete call-site type (e.g., `JsonValue`), creating an ABI mismatch.

## Root Cause

1. Handler functions marked `isModuleEffectMember = true` with SomeType return types use `void` as their C return type (in both declarations and definitions)
2. The call site in `generateEvidenceFnPtrCall` builds a function pointer cast from the concrete argument/return types at the call expression
3. When the evidence parameter's `fieldFunctionType` has forall parameters and the return type is `SomeType`, the cast was using the concrete return type (e.g., `JsonValue`) instead of `void`
4. Calling a `void`-returning function through a struct-returning pointer is **undefined behavior** in C11

## Symptoms

- **WASM (emscripten):** `RuntimeError: unreachable` — the WASM type system detects the signature mismatch and traps
- **Native x86-64:** `SEGV on unknown address 0x000000000001` — corrupted return address on the stack
- The bug was latent since evidence passing was introduced but only manifested after the `static inline` change (commit 7d63df2e) altered inlining behavior

## Reproduction

Any code using `Exception` (or similar forall-returning effect handlers) with evidence passing:

```rust
{ Exception } :: import "std/error";

json_parse :: (fn(input: str, using(exn): Exception) -> JsonValue)(
  // ... throws on error
);

main :: () -> () {
  (given(exn) : Exception) = Exception(
    throw: (fn(error: AnyError) -> !)(escape ())
  );
  result := json_parse("", using(exn));
};
export main;
```

## Fix

In `generateEvidenceFnPtrCall` (`src/codegen/exprs/other-fn-call.ts`):

1. Check if the evidence parameter's field function type return is `SomeType` (forall type variable)
2. If so, use `"void"` as the cast return type instead of the concrete type
3. Generate a separate code path (`handlerReturnsVoid`):
   - Declare temp var zero-initialized before the call (escape-path drops may reference it)
   - Call handler as void (no assignment)
   - Check `__yo_effect_escaped` flag and propagate escape
   - Return zero-init temp for the (unused) resume path

## Affected Files

- `src/codegen/exprs/other-fn-call.ts` — the fix
- `tests/encoding/json.test.yo` — test "json_parse empty input" was crashing on WASM
- `tests/algebraic_effects.test.yo` — 57 tests, all pass after fix
