# Export in executable mode produces static functions

## Status: Fixed

## Description

When compiling an executable (non-library), `export fn_name;` has no effect on the
generated C linkage. All exported functions (except `main`) get `static inline`
linkage, making them invisible to external tooling like Emscripten's
`-sEXPORTED_FUNCTIONS`.

## Steps to Reproduce

```rust
my_api :: (fn(x: i32) -> i32)(x);
main :: (fn() -> unit)(());
export main, my_api;
```

Compile with `--emit-c --skip-c-compiler`. In the generated C:

```c
static inline int32_t fn_yoXXX_id_N_my_api(int32_t x) { ... }
```

The function is `static inline` despite being explicitly exported.

## Expected Behavior

Exported functions should have external linkage (no `static inline` prefix) and
use plain C names so they can be referenced by linker flags, FFI, or WASM
`EXPORTED_FUNCTIONS`.

## Root Cause

In `src/codegen/functions/collection.ts`, `collectRequiredFunctions` only
populates `exportedFunctionLabels` (and assigns plain C names) when
`context.isLibrary` is true (line 124). The `else` branch for executables
(line 147) uses hashed names and never registers exports.

## Fix

In the `else` branch, also assign plain C names and register in
`exportedFunctionLabels`, matching the library-mode behavior for functions
from the current module.
