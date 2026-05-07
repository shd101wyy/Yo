# ~~Struct `==` Comparison Fails in Self-Hosted Evaluator~~

## Status: RESOLVED ✅

The struct equality issue was caused by TWO separate bugs that together made
it look like a struct comparison problem:

1. **`Box(size: i32(5))` intercepted by type constructor**: The evaluator's
   `Box(T)` type constructor handler (Phase 5w) matched `Box(size: i32(5))`
   before the struct constructor detection could run, because both have
   `args.len() == 1`. Fixed by adding `is_named_field_arg` check.

2. **`export i32(42)` failed in `evaluate_module_body`**: The module body
   evaluator only handled `export name;` (Atom exports), not `export expr;`
   (FnCall exports). When tests used `export expr;` patterns, the module
   evaluation returned None. Fixed by evaluating FnCall export arguments.

Struct `==` comparison itself works correctly (tested with 2-field structs
in Phase 5az-5ba).

## Fix commits

- `is_named_field_arg` helper in `yo-self/evaluator/eval.yo`
- FnCall export support in `evaluate_module_body`
- Regression tests in `yo-self/tests/eval.test.yo`
