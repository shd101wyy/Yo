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
