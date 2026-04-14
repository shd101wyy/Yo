# WASM: Dispose function pointer type mismatch for type-function instances

## Symptom

On WASM (Emscripten/WASI), `imm_map.test.yo` and `imm_set.test.yo` fail with
C compilation errors:

```
error: incompatible pointer types passing '__yo_struct_..._id_466 *'
to parameter of type '__yo_struct_..._id_5372 *' [-Wincompatible-pointer-types]
  fn_..._dispose_specialized_K_i32_V_i32_Self_MapBranch_(...)(__yo_self);
```

## Root cause

Type functions like `MapBranch(K, V)` can produce multiple struct instances
with different type IDs when called from different specialization contexts
(e.g., when generic functions using `MapBranch(K, V)` are specialized with
the same concrete types from different call sites).

The `Dispose` trait impl is specialized for one specific instance (e.g.,
struct ID 5372). The `___dispose` function for a _different_ instance
(e.g., struct ID 466) resolves to the same specialized dispose function
via `areTypesCompatible` (which matches structurally identical types).
However, the C parameter types differ because each struct instance has
a unique C struct name.

On macOS/Linux, `-w` suppresses this as a warning (Apple clang 15 treats
`-Wincompatible-pointer-types` as a warning). On emscripten/WASI clang 16+,
it's an error even with `-w`.

## Fix

When generating the dispose call inside `___dispose`, check if the dispose
function's SelfType has a different C name than the current type. If so,
cast through `(void*)` to the expected type:

```c
// Before (type mismatch when IDs differ):
fn_dispose(__yo_self);

// After (safe cast through void* for structurally identical types):
fn_dispose((TargetType*)(void*)(__yo_self));
```

Changed `findUserDisposeMethodForType` to return a `DisposeMethodInfo` with
both the C function name and the SelfType, enabling the call site to
generate the cast when needed.

## Files changed

- `src/codegen/functions/generation.ts` — `findUserDisposeMethodForType()`: return `DisposeMethodInfo`
- `src/codegen/functions/generation.ts` — `generateFunction()`: add pointer cast when dispose SelfType differs

## Note

The underlying issue (type functions producing multiple struct instances for
the same type arguments) could be addressed by improving type function
memoization across specialization contexts. This is a broader change and
the cast fix is correct and safe for structurally identical types.
