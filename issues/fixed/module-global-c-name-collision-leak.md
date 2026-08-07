# Two modules declaring the same global name silently share one C variable (FIXED 2026-08-05)

**Found 2026-08-05** from CI run 31011003610, job `Compiler internal tests`, **TS arm**
(the ground-truth compiler). It is the leak that job bailed on after
`issues/fixed/ref-enum-unit-variant-inline-construction-leak.md` fixed the previous one —
the TS arm went from dying at 75 tests to **234 passed / 1 failed of 235**.

The leak was the visible symptom. The actual bug is much worse: **two distinct
module-level globals with the same name alias the same C variable**, so two modules that
believe they own separate state silently share it.

## Symptom

`tests/internal/evaluator_index.test.yo`, test
`has_comment_attribute: returns false for empty list`:

```
==4251==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 88 byte(s) in 1 object(s) allocated from:
    #1 __yo_new___yo_struct_yo3fa6ab65_id_2996
    #2 fn_…_alloc_with_capacity_specialized_K_String_V_bool_Self_HashMap_u40_String_u44__u32_bool_u41__
    #3 fn_…_new_specialized_K_String_V_bool_Self_HashMap_u40_String_u44__u32_bool_u41__
    #4 __yo_main_module_init
Indirect leak of 384 byte(s) …   (bucket array)
Indirect leak of 16 byte(s) …
SUMMARY: AddressSanitizer: 488 byte(s) leaked in 3 allocation(s).
```

## Root cause

Module-level globals are emitted with their **plain Yo name** as the C identifier, not
namespaced per module:

```c
static __yo_struct_yo74961700_id_2996* g_control_fn_registry; // module-level mutable variable
```

Two different yo-self files each declared a global with that exact name:

| file                                                           | line |
| -------------------------------------------------------------- | ---- |
| `yo-self/function_value.yo`                                    | 30   |
| `yo-self/evaluator/types/control_fn_registry.yo` (now deleted) | 15   |

They were **exact duplicates** — same global, same `mark_as_control_fn` and
`is_control_fn` bodies, both claiming to mirror `src/function-value.ts`. So
`__yo_main_module_init` allocated two HashMaps and assigned both to the one C variable;
whichever ran last won and the other 488 bytes were orphaned.

Localized by counting allocations against assignments in the emitted batch C:

```
HashMap(String,bool) allocs in __yo_main_module_init: 7
  _yoebec35a0_temp_275987 → g_control_fn_registry            <- function_value.yo
  _yoebec35a0_temp_276390 → g_closure_fn_registry
  _yoebec35a0_temp_277341 → g_effect_record_member_registry
  _yoebec35a0_temp_277352 → g_io_async_sm_closure_registry
  _yo67df6aba_temp_290791 → _currently_registering_concrete_impls
  _yoae7de946_temp_305093 → g_macro_return_is_unquote
  _yod0ea2f06_temp_345114 → g_control_fn_registry            <- the DUPLICATE module
```

Two writes to one global, from two different modules (note the differing `_yoXXXXXXXX`
module prefixes on the temps).

## The part that matters more than the leak

The two aliased registries were being used by _different_ halves of the compiler:

- **writer**: `yo-self/evaluator/calls/helper.yo:3641,3904` call `mark_as_control_fn`,
  imported from `function_value.yo`;
- **reader A**: `codegen/types/collection.yo`, `codegen/functions/collection.yo`,
  `codegen/exprs/other_fn_call.yo` import `is_control_fn` from `function_value.yo`;
- **reader B**: `evaluator/calls/function.yo:91` imported `is_control_fn` from
  `control_fn_registry.yo`.

Reader B saw the writer's marks **only because the C names collided**. Had module globals
been namespaced correctly — which is what a reader would assume — reader B would have
observed a permanently empty registry, and the self-hosted compiler's control-function
(`unwind`) handling would have silently mis-answered. The aliasing bug was load-bearing.

## Fix

Consolidate to one registry:

- deleted `yo-self/evaluator/types/control_fn_registry.yo` (a pure duplicate; nothing else
  imported it, and no test referenced it);
- repointed its single importer, `yo-self/evaluator/calls/function.yo`, to take
  `is_control_fn` from `function_value.yo` — a file it _already_ imported, so no new
  import edge and no cycle risk.

## Verification

Emitted batch C for `tests/internal/evaluator_index.test.yo`, target `aarch64-linux-gnu`:

| measure                                                       | before | after |
| ------------------------------------------------------------- | ------ | ----- |
| `HashMap(String,bool)` allocations in `__yo_main_module_init` | 7      | **6** |
| assignments to `g_control_fn_registry`                        | 2      | **1** |

Tree-wide audit of every module-level global (`find yo-self -name '*.yo'`, one regex per
declaration): **181 globals, 181 distinct names, 0 collisions.** So this was the only
instance.

`check ./yo-self` 237/237 (one file fewer, by deletion).

## Still open: the compiler should not allow this

The underlying codegen behaviour is unchanged and remains a soundness hole — see
`issues/module-global-c-names-are-not-namespaced.md`. Nothing prevents the next duplicate
name from silently aliasing again, in user code as much as in `yo-self/`.

## Note on a tempting wrong diagnosis

"Module globals are never dropped (`src/env.ts:2284` skips `isModuleLevel`), so of course
LSan reports them" is **wrong**, and believing it would have closed this as
works-as-intended. LeakSanitizer only reports allocations unreachable from a root, and it
scans C globals as roots — a live module global is reachable and is _not_ reported. A
reported module-init allocation therefore always means the pointer was genuinely orphaned.
