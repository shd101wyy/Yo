# SomeType Specialization of Module Effect Member Not Generated

## Status

Fixed in `src/codegen/functions/collection.ts`.

## Symptom

When a throw-handler lambda like `((err) -> panic("..."))` is used as the `throw` field
of an `Exception(throw: ...)` value, the return type of `panic` is `forall T`. Inside
the enclosing function's body context, `T` is sometimes assigned a fresh
`SomeType(id_NNNN)` rather than being unified with the expected return type.

This causes the codegen to emit a **call** to a specialized C function
`fn_...throw_ResumeType_idsometype_idNNNN_...` but **never generate its definition**,
resulting in a C undeclared-identifier error like:

```
use of undeclared identifier 'fn_yo70489165_id_45_throw_ResumeType_idsometype_yo3e987b18_id_7484_rtparam0_AnyError_iddyn_51ddb77c18'
```

## Root Cause

In `src/codegen/functions/generation.ts` (lines ~393-415), functions whose return type
contains a `SomeType` are **skipped** unless `isModuleEffectMember` is set. The
SomeType(7484) specialization of the throw handler was collected in `context.functions`
(making its `cName` resolvable) but was **not** marked `isModuleEffectMember = true`, so
its C definition was never emitted.

## Fix

In `src/codegen/functions/collection.ts`, inside `collectModuleEffectMembers()`, after
registering the base module-effect-member function, iterate over its
`specializedFunctionCaches` and mark/register each specialization with
`isModuleEffectMember = true`. This ensures all specializations (including
SomeType-returning ones) are generated.

## Files

- `src/codegen/functions/collection.ts` — fix applied here
- `src/codegen/functions/generation.ts` — the skip logic that relies on the flag

## Related

- `issues/throw-handler-lambda-scope-restriction.md` — why `SomeType` appears here
