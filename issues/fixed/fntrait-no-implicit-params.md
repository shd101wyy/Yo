# Issue: FnTraitT has no `implicit_params` field in yo-self

## Status: FIXED

This issue has been resolved. `FnTraitT` in `yo-self/types/type.yo` now carries three new fields:

- `implicit_labels  : ArrayList(String)`
- `implicit_types   : ArrayList(Self)`
- `implicit_spreads : ArrayList(bool)`

These are populated by `evaluate_fn_trait_type` (in `yo-self/evaluator/types/fn_trait.yo`) from `params_result.implicit_params`, and `is_transitive_effect_call_` Path 2 in `effect_analysis.yo` now checks them correctly.

---

## Original issue (for reference)

`FnTraitT` in `yo-self/types/type.yo` did not carry implicit (using/effect) parameter information, unlike the TypeScript source `FnTraitT.callType.implicitParameters`. This caused the `isTransitiveEffectCall` closure/Impl path in `effect_analysis.yo` to always return `None`.
