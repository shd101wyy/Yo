# yo-self: TypeValue variant fields too narrow for several evaluator stubs

> **Status (Phase 2aq):** `TraitT` portion of this issue is **resolved** —
> `id` and `is_concrete` fields were added in Phase 2aq, and
> `evaluator/types/concrete_trait.yo` is now ported. The remaining
> variants (`Union`, `DynT`, `ModuleT`) and the field on `FunctionValue`
> for `derive_rule` are still pending. Cascade was much smaller than
> the initial estimate (6 sites vs ~30+ feared).

## Summary

**Correction (post initial draft):** `yo-self/types/type.yo` already defines
all the TypeValue variants needed — `TraitT`, `DynT`, `Union`, `ModuleT`,
`FnTraitT`, `FutureTraitT`. The blocker is **field-level**, not
**variant-level**: the variants exist but lack the fields the unported
evaluators need to set or read.

Examples:

- `TraitT(name, assoc_type_names, field_labels, field_types)` has no `id`
  field, no `is_concrete` field, no `derive_rule` field, no
  `defined_in_module_path` field.
- `Union(name, field_labels, field_types)` has no `id`, no
  `defined_in_module_path`, no auto-derive flags.
- `DynT` has trait-constraint lists but no field for negative-trait
  resolution metadata used by `downcast`.
- `FunctionValue` (FuncVal) has no mutable `derive_rule` slot.

Adding any of these fields cascades through ~30+ pattern match sites per
variant, across roughly:

- `yo-self/types/string.yo`, `equality.yo`, `compatibility.yo`,
  `type_of_type.yo`, `hierarchy.yo`, `substitution.yo`
- `yo-self/evaluator/types/field.yo`,
  `yo-self/evaluator/exprs/property_access.yo`,
  `yo-self/evaluator/exprs/subtype_of.yo`
- `yo-self/evaluator/effects/effect_analysis.yo`,
  `yo-self/evaluator/async/await_analysis.yo`

## Affected stubs

| File                                        | TS LOC | Reason blocked                                                                          |
| ------------------------------------------- | -----: | --------------------------------------------------------------------------------------- |
| `yo-self/evaluator/types/concrete_trait.yo` |     89 | needs `id` + `is_concrete` field on `TraitT`                                            |
| `yo-self/evaluator/types/dyn.yo`            |    177 | needs trait-collection logic; `DynT` exists but `is_trait_type` helper missing          |
| `yo-self/evaluator/types/fn_trait.yo`       |    143 | depends on `evaluate_function_parameters` from `function.ts` (~2900 LOC)                |
| `yo-self/evaluator/types/future_trait.yo`   |    288 | needs additional fields on `FutureTraitT`                                               |
| `yo-self/evaluator/types/trait.yo`          |   1140 | core trait infra: needs `id` / sub-trait edges / many fields on `TraitT`                |
| `yo-self/evaluator/types/union.yo`          |    135 | needs `id` + `defined_in_module_path` on `Union`; `auto_derive_*` helpers               |
| `yo-self/evaluator/types/module.yo`         |    647 | needs `is_implemented` + `defined_in_module_path` on `ModuleT`, `evaluate_module_field` |
| `yo-self/evaluator/builtins/derive_rule.yo` |    105 | needs mutable `derive_rule` field on `FunctionValue` and `TraitT`                       |
| `yo-self/evaluator/builtins/downcast.yo`    |    114 | needs `is_dyn_type` + `create_option_type` (rc_fns infra)                               |
| `yo-self/evaluator/values/impl.yo`          |   3374 | needs trait/module infra to evaluate `impl(...)` blocks                                 |

## Proposed approach (when tackled)

Each new field added to a TypeValue variant (especially `TraitT`) cascades
through every pattern match site. To keep the cascade tractable:

1. **Pick one variant at a time.** Start with `TraitT` since the most-blocked
   stubs (`concrete_trait`, `derive_rule`, parts of `trait.yo`) all need
   fields on it.
2. **Add the minimum useful field set** for that variant. For `TraitT`, that
   is at least `id : String` and `is_concrete : Option(Box(Self))`.
3. **Cascade-update**: `string.yo` / `equality.yo` / `compatibility.yo` /
   `type_of_type.yo` / `hierarchy.yo` / `substitution.yo` plus the
   evaluator pattern-match sites listed above. Use the existing handling
   of similar variants as a template; placeholder branches are OK
   provided they preserve behavior.
4. **Land the smallest dependent port** (`concrete_trait.yo`, 89 LOC) in
   the same change, so the variant extension is exercised end-to-end.
5. **Run the full yo-self suite** (~11 min) and confirm 930/930 still pass.
6. Repeat for `Union`, then `DynT`, then `ModuleT`. Defer the
   multi-thousand-line `trait.yo` / `module.yo` / `impl.yo` to dedicated
   phases — they pull in significantly more semantics.

## Why we are documenting this now

While picking the next port target after Phase 2ap (tuple value), every
small remaining stub turned out to be blocked on this same axis. Rather
than start a multi-file infrastructure cascade in a single autonomous
session, this is recorded as a known blocker so the next session can plan
the trait/union/dyn/module variant addition holistically.
