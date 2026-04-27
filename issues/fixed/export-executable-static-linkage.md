# Export in executable mode produces static functions

## Status: Fixed

## Description

When compiling an executable (non-library), `export fn_name;` had no effect on
the generated C function name. All exported functions (except `main`) got mangled
names like `fn_yoXXX_id_N_my_api`, making them invisible to external tooling
like Emscripten's `-sEXPORTED_FUNCTIONS`.

## Root Cause

In `src/codegen/functions/collection.ts`, `collectRequiredFunctions` only
assigned plain C names when `context.isLibrary` was true. The executable mode
used hashed names for everything.

## Fix (commit d447f8fd)

Added `exportedLabels` set to `ModuleValue` that tracks labels from explicit
`export` statements. In executable mode, only functions whose labels are in this
set get plain C names. This avoids POSIX collisions (e.g., trait impl `index`
vs POSIX `index()`) while ensuring WASM exports work.

### How it works

1. **Evaluator** (`anonymous-module.ts`): When processing `export foo, bar;`,
   adds `"foo"` and `"bar"` to `moduleValue.exportedLabels`.
2. **Codegen** (`collection.ts`): In executable mode, checks
   `moduleValue.exportedLabels?.has(label)` before assigning a plain C name.
   Functions not in the export list keep their hashed/mangled names.

### Library mode (unchanged)

Library mode uses `isFromCurrentModule` + collision detection for ALL module
fields (not just explicitly exported ones). This is correct because library
mode needs all user-defined functions to have plain names for `extern "Yo"`
cross-module linking.
