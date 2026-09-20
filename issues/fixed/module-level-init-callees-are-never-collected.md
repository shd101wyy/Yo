# A module-level initializer's callees are never collected, so `(g : bool) = f(x).is_some();` emits a `// Failed to transpile` stub that eats the next declaration

**Status: FIXED 2026-09-21** (`collect_module_level_init_functions`,
`src/codegen/functions/collection.yo`, called from `codegen_c.yo` right after
`collect_required_functions`). Pre-existing (the v0.2.38 seed has it); exposed
on develop by #805, whose `(g_node_eval_counting : bool) =
debug_knob(\`YO_SPEC_REPORT\`).is_some();` in `src/expr_info.yo` turned three
`tests/internal` CI shards red (run 35520237279: `pkg_config`,
`suspension_analysis`, `evaluator_utils_is_valid_variable_name` — every batch
importing `expr_info.yo` without another `Option(String).is_some()` user).

## Symptom

```
.yo_selftest_batch_1_0.bin.c:30132:3: error: unexpected type name '__yo_t_14685587097508966273': expected expression
  g_node_eval_counting_m… = // Failed to transpile (debug_knob(("YO_SPEC_REPORT".to_string)()).is_some)();
  __yo_t_14685587097508966273* _file____User_temp_… = yo_id_…();
```

The stub comment swallows the statement's `;` AND the next line, so clang
reports the NEXT declaration. `yo compile --skip-c-compiler` exits 0 — the
marker is an in-band degrade signal, fatal only inside `__yo_user_main`.

Minimal reproducer (`tests/cli-cases/build-run-module-level-init-method-call`):
`knob.yo` exports `knob : String -> Option(String)`; `main.yo` has
`(g_on : bool) = knob(\`ON\`).is_some();` at module level and nothing else
calls `Option(String).is_some()`.

## Root cause (measured with probes, 2026-09-21)

- The evaluator does its job: the method call is resolved and SPECIALIZED,
  and the specialization is recorded in the method-callee side table under
  the call's expr id (`[mc-probe] record id=87308 spec=true`).
- Codegen's `generate_other_function_call` returned `.None` for the same id
  (`[fttmark-dispatch-none] id=87308 value=true rtargs=1`): the dot-method
  dispatch found the recorded FuncVal but `_c_func_name(fid)` had no entry —
  the specialization was never REGISTERED for emission — so the dispatch
  fell through to the generic path, whose `get_expr_info(func_expr)` on the
  callee dot-access (which has no ExprInfo by design) returned the `.None`
  that becomes the stub.
- Why unregistered: `collect_required_functions` walks the module's EXPORTED
  fields and recurses through function bodies. A module-level `(g : T) = rhs`
  is not a field and not a body; its rhs was never visited. The TYPE
  collector had been given exactly this walk earlier ("Collect types from
  module-level mutable variable init expressions", `types/collection.yo`) —
  the function side never got its twin. Any callee used ONLY from an
  initializer was invisible; a method specialization is the common case
  because the same generic method used anywhere else registers the same C
  function and hides the gap (which is why `g_debug_mg =
  cgu_env.get(...).is_some()` and `_g_anon_dbg_swallow` always worked).

## Fix

`collect_module_level_init_functions(context, info)` runs
`find_function_calls_in_expr` over `get_module_level_init_exprs()`, right
after the export walk. Idempotent (`has_function`-guarded), so a callee that
IS reachable elsewhere is registered once.

## Not changed

The `// Failed to transpile` marker stays a comment (the degrade architecture
consumes it, `codegen/exprs/generation.yo`), and a stub inside
`__yo_main_module_init` is still not fatal at emission time — the C compiler
catches it. Making module-init stubs fatal the way `__yo_user_main`'s are is
a separate decision.
