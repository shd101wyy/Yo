# Mixed Positional/Named Match Arm Causes Undeclared Identifiers in C Codegen

## Status: Fixed (workaround applied)

## Summary

When a `match` arm destructures an enum variant using a mix of positional and named fields within the **same** arm, the C codegen emits undeclared identifier errors for the named fields.

## Root Cause

The C codegen generates variable binding code differently depending on whether a pattern uses positional or named syntax. When a pattern mixes both (e.g., `.FnTraitT(base_name, call_param_labels, call_param_types: cpts, call_result)`), the positionally-matched fields are not assigned to variables, but the body code still tries to reference `base_name` and `call_param_labels` — which were never declared.

## Reproduction

```rust
FnTraitT :: enum(
  FnTraitT(base_name : String, call_param_labels : ArrayList(String), call_param_types : ArrayList(TypeValue), call_result : Box(TypeValue))
);

// BROKEN: mixes positional (base_name, call_param_labels) with named (call_param_types: cpts, call_result)
match(ty,
  .FnTraitT(base_name, call_param_labels, call_param_types: cpts, call_result) => {
    // C codegen produces:
    //   _yo_temp = fn_dup(base_name);   <-- ERROR: 'base_name' undeclared
    //   _yo_temp = fn_dup(call_param_labels);  <-- ERROR: 'call_param_labels' undeclared
    base_name
  }
)
```

Resulting C compiler error:

```
error: use of undeclared identifier 'base_name'
error: use of undeclared identifier 'call_param_labels'
error: use of undeclared identifier 'call_result'
```

## Fix Applied

Use **all-named** patterns for multi-field enum variants in match arms:

```rust
// CORRECT: all named fields
match(ty,
  .FnTraitT(base_name: bn, call_param_labels: cpls, call_param_types: cpts, call_result: cr) => {
    bn  // 'bn' is properly declared
  }
)
```

Note: Using **all-positional** patterns also works fine. The issue is specifically the **mix** of the two styles in one arm.

## Files Affected

- `yo-self/types/substitution.yo` — FnTraitT and FutureTraitT match arms were using mixed patterns; fixed to all-named.

## Notes

- Mixing styles **across different arms** is valid (one arm positional, another named).
- The restriction is: **within a single arm**, choose one style consistently.
- The curly-brace shorthand `{field_name}` (sugar for `field_name: field_name`) is always safe.

## Tracking

Discovered during Phase 2f bootstrapping work.
The workaround (all-named patterns) is applied in `substitution.yo`.
A proper fix in the codegen/evaluator would allow mixed patterns.
