# Codegen: Forward Declaration Return Type Override (effect escape context)

**Status:** Fixed in `src/codegen/functions/declarations.ts`

## Problem

When a function with a concrete return type (e.g., `unit` → `void`) is called with an
algebraic-effect handler that uses `escape bool`, the evaluator re-evaluates the function body
in that call context, mutating the AST node's `expr.$.type` to `bool`. Because the codegen's
`generateFunctionDeclaration` then unconditionally overrode the forward declaration's return type
with `functionBody.$.type`, the forward declaration used `bool` while the function definition
used `void`, producing a C compiler error:

```
error: conflicting types for 'fn_...throw_..._error_...'
  note: previous declaration is here
```

## Minimal repro

```rust
do_throw :: (fn(msg : String, using(exn : Exception)) -> unit)({
  exn.throw(dyn msg);
});

check_throws :: (fn(msg : String) -> bool)({
  given(exn) := Exception(throw: ((err) -> { escape true; }));
  do_throw(msg, using(exn));
  false
});

main :: (fn() -> unit)({
  result := check_throws("hello");
  // ...
});
export main;
```

`do_throw` returns `unit`, but calling it with an `escape true` handler causes `do_throw`'s
body AST to be annotated with `bool`. The forward declaration then gets `bool`, conflicting with
the definition's `void`.

## Root cause

In `src/codegen/functions/declarations.ts`, `generateFunctionDeclaration` had:

```typescript
// Unconditionally applied override
if (
  !overrideReturnType &&
  functionBody &&
  functionBody.$?.type &&
  !typeImplementsFuture(functionType.return.type)
) {
  const sig = getTypeString(functionType.return.type, context);
  const body = getTypeString(functionBody.$.type, context);
  if (sig !== body) {
    overrideReturnType = body; // BUG: uses bool from escape mutation
  }
}
```

This override was intended for _generic_ functions where the signature has `SomeType` but the
body's concrete type is known. Applying it unconditionally also overrides concrete return types
that were mutated by effect escape analysis.

## Fix

Guard the override with a `SomeType` check so it only fires when the signature's return type is
actually generic:

```typescript
if (
  !overrideReturnType &&
  functionBody &&
  functionBody.$?.type &&
  !typeImplementsFuture(functionType.return.type) &&
  (isSomeType(functionType.return.type) ||
    typeContainsSomeType(functionType.return.type))
) {
  // ...
}
```

## Files changed

- `src/codegen/functions/declarations.ts` — added `isSomeType || typeContainsSomeType` guard

## Discovered during

Phase 2v bootstrapping (`yo-self/evaluator/exprs/assignment.yo`): the `assignment.test.yo`
test file has `cf_error_throws` which calls `throw_rhs_contains_control_flow_expression_error`
(a `unit`-returning function) with a `bool`-escape handler, triggering this bug.
