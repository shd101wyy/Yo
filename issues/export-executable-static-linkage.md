# Export in executable mode produces static functions

## Status: Partially Fixed (library mode only)

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

## Fix History

### Initial fix (commit b69948f9)

In the `else` branch, also assign plain C names and register in
`exportedFunctionLabels`, matching the library-mode behavior for functions
from the current module.

### Regression (reverted in executable mode)

The initial fix caused name collisions:

1. **dyn.test.yo**: Multiple trait impls with same method name (e.g., `print` for
   both `i32` and `bool`) all got the same plain C name → C type conflict.
2. **index.test.yo**: Impl method `index` from `impl(MyArray, Index(usize)(...))`
   got plain C name `index` which collides with POSIX `index()` from `<strings.h>`.

The executable-mode plain name assignment was reverted. Only library mode retains
plain C name assignment (with collision detection). For WASM executables, an
alternative approach using `__attribute__((export_name("...")))` or explicit
`-sEXPORTED_FUNCTIONS` flags should be used instead.

Library mode also gained:

- `isTopLevelExport` parameter to prevent trait impl methods from getting plain names
- Collision detection: before assigning a plain name, check if any existing function
  already has that name
