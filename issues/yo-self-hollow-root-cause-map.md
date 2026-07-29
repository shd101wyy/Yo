# yo-self: root-cause map for all 26 HOLLOW test files (2026-07-29)

Measured with a **swallow-diagnostic s1** — a build carrying `eprintln` probes at the three
definition-time swallow sites — swept over every hollow file, then **noise-subtracted against
GREEN files**. Tooling: `scratchpad/swallow_sweep.sh` (+ `scratchpad/capture_markers.sh` for the
REDs). This replaces guesswork: a hollow file's single `Failed to transpile` marker IS the whole
batch dispatch expression, so the marker text says nothing about which arm failed — the swallowed
error does.

## Why this measurement was needed

Batch dispatch is all-or-nothing: any one arm whose definition-time evaluation throws empties the
whole `__yo_user_main`, so every test in the file "passes" vacuously. One bad arm hollows a file
with 100 good tests. The swallowed error names that arm's actual failure.

Probe sites (the three swallows):

| Probe     | Site                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| `__DBG_W` | `yo-self/evaluator/exprs/_expr.yo` catch-all (`note_def_time_swallow`)       |
| `__DBG_F` | `yo-self/evaluator/calls/function_type.yo` `_trial_eval_fn_body` `inner_exn` |
| `__DBG_A` | `yo-self/evaluator/values/anonymous_function.yo` `inner_exn` (two sites)     |

## NOISE — confirmed present in GREEN files, must be subtracted

Do **not** chase these. Baseline taken on `arc`, `imm_string`, `iso`, `iso_api_surface`,
`module_struct_unification` (all GREEN):

| Swallowed message                                                            | Seen in GREEN         |
| ---------------------------------------------------------------------------- | --------------------- |
| `__DBG_A Expected expression value for "__yo_expr_to_string" argument`       | **all 5** — universal |
| `__DBG_F Incompatible types:`                                                | `imm_string` (×2)     |
| `__DBG_F Failed to evaluate right-hand side of assignment: (reversed._head)` | `imm_string`          |
| `__DBG_W use of moved value: \`x\``                                          | `iso`                 |

Two consequences:

- A bare `Incompatible types:` is **not** evidence of a defect on its own — it needs the full
  message body and a per-file check.
- `imm_map` / `imm_set` import `imm_string`, so their `Incompatible types:` and `reversed._head`
  swallows are inherited noise, not their own failure.

Also benign: `__DBG_F` fires for expected errors during a `comptime_expect_error` argument
evaluation (propagate mode). A **quoted** message (e.g. `"Cannot use \`a\` from outer scope"`) is
usually the error a `cee`*wanted*. The unambiguous defect signal in that family is instead`Expected compile error, but the expression was evaluated successfully`—`cee` saw no error.

## Real root causes, grouped by multiplicity

### Shared roots (one fix, several files) — best value

| Root                                                                                                                                                               | Files                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `Expected a label for function parameter, got requires(y != i32(0))` — yo-self does not accept contract clauses in a function parameter list                       | `spec/contracts_phase0`, `spec/pragma_no_contracts`, `spec/pragma_verify` (**3**) |
| `Type mismatch for type member "_f":`                                                                                                                              | `iterator_combinators`, `where_clause_fn_inference` (**2**)                       |
| `Expected compile error, but the expression was evaluated successfully` — a validation TS performs and yo-self does not (one distinct missing validation per file) | `basic`, `closure`, `fn` (×2), `inherent_first_resolution` (**4**)                |

### Unported features (each an explicit yo-self stub)

| File                  | Swallowed error                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| `asm`                 | `evaluate_asm: not yet implemented (Phase 3)`                            |
| `iter_filter_closure` | `evaluate_function_call: TypeVal SomeT callee without FnTrait (Phase 4)` |
| `type_reflection`     | `__yo_type_get_info: unsupported type variant`                           |

### Singletons

| File                        | Swallowed error                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections/linked_list`   | `Type mismatch for type member "value":` + `Expected enum type or primitive type (integer, bool) for match expression, got unit`                                                  |
| `comptime`                  | `Return type mismatch. Expected type "f32", but got "Output".`                                                                                                                    |
| `comptime_option_result`    | `Enum variant "unwrap" not found in enum`                                                                                                                                         |
| `higher_kinded_types`       | `Argument count mismatch: expected 1, got 2`                                                                                                                                      |
| `impl`                      | `All return statements must return the same concrete type for Impl(...)` (×3) + `Type mismatch for parameter "self":`                                                             |
| `option_result_combinators` | `Last expression in "begin" is not evaluated correctly:`                                                                                                                          |
| `imm_map` / `imm_set`       | after noise subtraction: `Cannot unify incompatible types:` (`__DBG_W` ×4 / ×8), `___drop: failed to evaluate the argument expression.`, `Type mismatch for type member "value":` |

### Needs the full message body before it can be classified

`async_await`, `gadts`, `string/string`, `sys/file` (`Incompatible types:`) and `env`, `prelude`
(`Cannot unify incompatible types:`) — the truncated head matches known noise. Re-read the full
multi-line message out of `/tmp/swal/<mangled>.log` before treating any of these as a defect.

## RED files, for completeness (from `scratchpad/capture_markers.sh`)

| Family (first clang error)                                                                                                                                                      | Files                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `call to undeclared function 'yo_id_NNNN'` (inside `__yo_dispose_dispatch`) — shallow-vs-deep `type_contains_some_type`; **fixed** in `yo-self/codegen/functions/collection.yo` | `collections/btree_map`, `collections/ordered_map`, `collections/priority_queue`, `index`, `sync/channel` (**5**)                |
| `passing '__yo_tNN' to parameter of incompatible type`                                                                                                                          | `imm_sorted_map`, `imm_sorted_set`, `imm_threading` (**3**)                                                                      |
| a type lowering to C `void`                                                                                                                                                     | `derive_clone_complex` (`argument may not have 'void' type`), `thread`, `worker` (`variable has incomplete type 'void'`) (**3**) |
| `incompatible integer to pointer conversion`                                                                                                                                    | `closure_capture_rc_leak` (argument), `sync/mutex` (return) (**2**)                                                              |
| `use of undeclared identifier 'fn_yo_id_NNNN'` — `->` with no expected type synthesizes an all-SomeT Func type where TS throws `Expected a function type`                       | `algebraic_effects` (**1**)                                                                                                      |
| `initializing 'void *' with an expression of incompatible type '__yo_tNN'`                                                                                                      | `impl_fn_field_rejection` (**1**)                                                                                                |
| no clang error at all (evaluator/runtime failure)                                                                                                                               | `fs/dir` (**1**)                                                                                                                 |

## Reproducing this measurement

```bash
# 1. diagnostic build (~4 min): copy yo-self, add the three probes, compile
cp -R yo-self /tmp/ydiag2   # then add eprintln at the three sites above
./yo-cli compile /tmp/ydiag2/main.yo --release -o /tmp/s1_swal

# 2. sweep the hollow files, then a GREEN baseline to subtract
BIN=/tmp/s1_swal OUT=/tmp/swal     LIST=/tmp/hollow.txt    scratchpad/swallow_sweep.sh
BIN=/tmp/s1_swal OUT=/tmp/swalbase LIST=/tmp/greenbase.txt scratchpad/swallow_sweep.sh
```

Both sweeps write batch artifacts into each test file's own directory, so they must run
**serially** — never two `test` invocations against one directory.
