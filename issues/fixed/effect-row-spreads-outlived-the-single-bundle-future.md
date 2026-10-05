# Effect-row spreads outlived the single-bundle `Future`

**Kind:** design question — an open decision, not a defect. Raised 2026-10-03 by `plans/ASYNC_IO_API_AUDIT.md` (finding F8, phase A5).

## The question

Should the effect-row variable feature — `generic(..., ...(E))` declarations and `...(E)` spreads — be removed, now that `Future(T, E)` takes one bundle struct?

## What exists

- `Future(T, ...(E))` still parses: `src/evaluator/types/future_trait.yo` (about 190 lines) resolves a spread and can expand it into SEVERAL effects.
- Function types accept row variables too: the declaration and spread handling in `src/evaluator/types/function.yo` (around 2948–3282), row unification in `src/evaluator/types/synthesizer.yo` (around 876 and 2063), and `has_effect_in_spread_` in `src/evaluator/effects/effect_analysis.yo`.
- `TypeValue.FutureTraitT` carries an `effect_spreads` list, read in `src/types/{compatibility,creators,intern,string,substitution}.yo`.
- Nothing in `std/`, `src/` or `tests/` writes a spread. The design instructions say "the language does not concatenate effects from multiple type arguments" (`.github/instructions/yo-design.instructions.md`, "Future return types with effects").

## Why it matters

The async codegen reads a future's effect at index 0 only (`_first_future_effect`, `src/codegen/exprs/await.yo`). A spread that expanded into two effects would inject only the first, and the await-site bundle check (`src/evaluator/calls/helper.yo`, Step 7c) runs only when the static type has exactly one effect. So the feature's one reachable use in a `Future` type is unsound, and the rest of it is untested.

## Options

1. **Remove effect rows everywhere.** Delete the spread from `Future`, the row-variable declarations and spreads in function types, the synthesizer's row unification and `effect_spreads` on `FutureTraitT`. One bundle struct is the documented way to carry several effects.
2. **Remove the spread from `Future` only.** Smaller, but it leaves row variables in function types with no async counterpart, which is the split the audit wanted gone.
3. **Keep it and make it sound.** Teach codegen to inject a multi-effect row and the bundle check to compare rows. That builds out a feature nothing uses.

## Recommendation

Option 1. The single-bundle design is settled and documented, AGENTS.md rules out compatibility scaffolding, and nothing in the tree uses rows. It is a pure evaluator change with no seed gate: delete, then `yo check ./src`, `yo check ./std --std-path ./std` and the language suite confirm nothing depended on it.

## Resolution (2026-10-03)

Decided by the user: Yo keeps effect-row polymorphism in its documented, tested form — a `generic(E : Type.Struct)` parameter standing for one effect-bundle struct, taken as `e : E` or inside a callback type `f : (fn(e : E) -> T)` (`docs/en-US/ALGEBRAIC_EFFECTS.md`, "Effect row polymorphism"; `tests/algebraic_effects.test.yo`, `tests/async_await.test.yo`). The older `...(E)` spread syntax is removed. `Future` takes exactly `Future(T)` or `Future(T, E)`, and a spread there is a check error (`src/evaluator/types/future_trait.yo`). A `...(E)` row-variable declaration inside `generic(...)` or a `...(E)` spread among the implicit parameters is now a check error too, naming the `generic(E : Type.Struct)` replacement (`src/evaluator/types/function.yo`).

Removed, all of it machinery only the spread reached:

- the row-variable declaration and spread expansion in `evaluate_function_parameters` (`src/evaluator/types/function.yo`), and `FuncParam.is_effect_row_spread`;
- the synthesizer's spread/row unification: `_expand_effects`, the solved/unsolved spread binding, the "Ambiguous effect row unification" and "Effect row unification failed" errors, the `EffectsRow + EffectsRow` case and `ImplicitEntry` (`src/evaluator/types/synthesizer.yo`); implicit/effect lists are still matched set-wise by type;
- `TypeValue.EffectsRowT`, `t_effects_row`, `TypeTag.TEffectsRow`, `is_effects_row_type`, and their arms in the type printer, interner, substitution, compatibility (`_flatten_effects`), creators, `yo effects` (kind `row`) and `Type.get_info` (`TypeInfo.EffectsRow`, also dropped from the prelude's `TypeInfo` enum and `docs/*/TYPE_REFLECTION.md`);
- `SomeT.is_effects_row` (only the spread built a `true` one), `FnTraitT.implicit_spreads`, `FuncMeta.implicit_spreads`, `FutureTraitT.effect_spreads`, `Variable.is_from_effect_spread` (never set) and `has_effect_in_spread_` (`src/evaluator/effects/effect_analysis.yo`), with the compiler-internal tests that exercised them.

Nothing was kept for `generic(E : Type.Struct)`: that path binds `E` as an ordinary `SomeT` resolved to the bundle struct and never produced or read an effects row, a spread flag or `is_effects_row`. Regression: `tests/async/effect_bundle.test.yo`, "a ...(E) effect-row spread is a check error".
