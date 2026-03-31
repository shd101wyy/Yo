# Chained method call on get_ptr result generates duplicate variable definition

## Status: RESOLVED

## Summary

When chaining a field access through a `get_ptr()` result and then using the result in a `match`, the codegen emits the `get_ptr` call twice with the same variable name, causing a C "redefinition" compilation error.

## Root Cause

The begin block codegen calls `generateExpr` on the last argument twice — once in the main loop (line 66) and again for deferred dup handling (line 95). The second call clears the top-level `variableName` to get raw code, but sub-expressions (like `get_ptr`) still have their `variableName` set and emit duplicate declarations.

## Fix

Added `declaredTempVars` set to `FunctionGenerationContext`. Before emitting a temp variable declaration in `other-fn-call.ts`, the codegen checks if the var was already declared and skips the emission if so.
