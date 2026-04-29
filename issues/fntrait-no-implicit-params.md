# Issue: FnTraitT has no `implicit_params` field in yo-self

## Summary

`FnTraitT` in `yo-self/types/type.yo` does not carry implicit (using/effect) parameter information, unlike the TypeScript source `FnTraitT.callType.implicitParameters`. This causes the `isTransitiveEffectCall` closure/Impl path in `effect_analysis.yo` to always return `None`.

## Affected file

`yo-self/evaluator/effects/effect_analysis.yo` — `is_transitive_effect_call_`, the "Path 2: Impl(Fn) / Dyn(Fn) types via FnTraitT" section.

## TypeScript source reference

In `src/evaluator/effects/effect-analysis.ts`:

```typescript
function isTransitiveEffectCall(expr, effectParameterName) {
  // ...
  // Path 2: Impl(Fn) / Dyn(Fn) via FnTrait extraction
  const fnTrait = extractFnTraitFromType(funcType);
  if (fnTrait) {
    const implicitParams = fnTrait.callType.implicitParameters ?? [];
    for (const { label, type, isEffectRowSpread } of implicitParams) {
      // ... matching logic
    }
  }
}
```

`extractFnTraitFromType` returns a `FnTraitType` that has `callType.implicitParameters : ImplicitParam[]`. The yo-self `FnTraitT` variant currently stores only:

- `forall_labels / forall_types`
- `call_labels / call_types`
- `call_is_infix`
- `call_result`

There is no `implicit_params` or `using_params` field.

## Impact

- Closures typed as `Impl(Fn(..., using(raise : Raise)) -> T)` are **not** detected as transitive effect calls.
- `is_transitive_effect_call_` "Path 2" always returns `Option(bool).None`.
- This causes the self-hosted evaluator/codegen to miss some transitive effect calls in functions that accept callbacks with effect parameters.

## Workaround

The "Path 1: Direct FunctionType" path in `is_transitive_effect_call_` still works for regular function types with `using` params. Most code is covered by this path. Only Impl/Dyn closure types passed as callbacks are affected.

## Fix

Add `implicit_labels : ArrayList(String)` and `implicit_types : ArrayList(TypeValue)` and `implicit_spreads : ArrayList(bool)` fields to the `FnTraitT` variant in `yo-self/types/type.yo`, and populate them from the `callType.implicitParameters` during parsing. Update all construction sites of `FnTraitT` to include these new fields.
