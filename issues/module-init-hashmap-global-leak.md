# A `HashMap` allocated in `__yo_main_module_init` is leaked (488 B) — TS compiler

**Found 2026-08-05** from CI run 31011003610, job `Compiler internal tests`, **TS arm**
(the ground-truth compiler — this is not a yo-self porting bug). It is the leak the job
now bails on, after
`issues/fixed/ref-enum-unit-variant-inline-construction-leak.md` fixed the previous one:
the TS arm went from dying at 75 tests to reaching **234 passed / 1 failed of 235**.

## Symptom

`tests/internal/evaluator_index.test.yo`, test
`has_comment_attribute: returns false for empty list`:

```
==4251==ERROR: LeakSanitizer: detected memory leaks

Direct leak of 88 byte(s) in 1 object(s) allocated from:
    #1 __yo_new___yo_struct_yo3fa6ab65_id_2996
    #2 fn_…_id_217__alloc_with_capacity_specialized_K_String_V_bool_Self_HashMap_u40_String_u44__u32_bool_u41__
    #3 fn_…_id_220_new_specialized_K_String_V_bool_Self_HashMap_u40_String_u44__u32_bool_u41__
    #4 __yo_main_module_init
    #5 __yo_main_thread_entry

Indirect leak of 384 byte(s) in 1 object(s)   (the bucket array, same stack)
Indirect leak of 16 byte(s) in 1 object(s)    (same stack)

SUMMARY: AddressSanitizer: 488 byte(s) leaked in 3 allocation(s).
```

So: a `HashMap(String, bool)` constructed during module initialization, plus the two
allocations it owns.

## Why this is a REAL leak and not immortal-by-design

The obvious reading — "module-level globals are never dropped, so of course LSan reports
them" — is **wrong**, and it is worth writing down why, because it is a tempting
false conclusion.

1. `src/env.ts:2284` does say `if (variable.isModuleLevel) return false;`, so module-level
   variables genuinely never get a scope-end `___drop`. That part is by design.
2. **But LeakSanitizer only reports allocations that are unreachable from a root**, and it
   scans C globals as roots. A module-level variable is emitted as a C static:

   ```c
   static __yo_struct_yo74961700_id_1694* g_reg; // module-level mutable variable
   …
   g_reg = _yo7338471b_temp_42159;               // inside __yo_main_module_init
   ```

   (verified locally: `./yo-cli compile … --target aarch64-linux-gnu --emit-c` on a
   two-line program with a module-level `HashMap(String, bool)` global.)

   A live pointer in a C global is reachable, so LSan would **not** report it.

Therefore the reported allocation is one whose pointer is **no longer in any root at
exit** — something allocated during module init and then orphaned.

## Hypothesis TESTED AND REFUTED: diamond-import double init

The obvious first guess was that a module reachable by two import paths gets its init run
twice, orphaning the first allocation. **Measured and false.** A minimal diamond
(`a.yo` and `b.yo` both import `c.yo`, which holds an RC module global; `main.yo` imports
both), emitted for `aarch64-linux-gnu`, produces exactly one of each:

```c
static __yo_struct_yo74961700_id_1694* g_reg; // module-level mutable variable   (1 decl)
…
static void __yo_main_module_init(void) {      // spans 4 lines
  g_reg = _yo939308e7_temp_42159;              // 1 assignment, 1 HashMap.new() call
}
```

So whatever orphans the pointer is not plain import-graph duplication. Kept here so the
next person does not re-test it.

(Incidental language fact learned: a runtime module-level variable **cannot be exported** —
`Variable "g_reg" is not a compile-time variable and cannot be exported.`)

## Remaining hypothesis: a module's init runs more than once for another reason

`yo-self/function_value.yo` declares four such globals with initializers:

```rust
(g_control_fn_registry : HashMap(String, bool)) = HashMap(String, bool).new();          // :30
(g_closure_fn_registry : HashMap(String, bool)) = HashMap(String, bool).new();          // :58
(g_effect_record_member_registry : HashMap(String, bool)) = HashMap(String, bool).new(); // :200
(g_io_async_sm_closure_registry : HashMap(String, bool)) = HashMap(String, bool).new();  // :216
```

`tests/internal/evaluator_index.test.yo` imports `../evaluator/index.yo`, which reaches
`function_value.yo`. If a module reachable by more than one import path has its init
emitted or executed twice, the first allocation is overwritten and orphaned — which
matches the evidence exactly: **one** leaked object, not four, and only in a batch whose
import graph is wide.

Note the shape is adjacent to `issues/fixed/yo-self-second-batch-in-process-ftt.md`
(a second compile in one process reusing cached module state) — the same "module
initialized more than once" family, on the emitted-program side rather than the
compiler side.

## Next experiment (the one to run first)

Get the ACTUAL batch and read its C — the leak should be visible as "two allocations, one
surviving pointer" without needing LSan or Linux:

1. `src/test-runner.ts:441` names the batch `.yo_test_batch_${uniqueId}` and `:550` deletes
   it unless `keepGeneratedFiles` is set. Run the TS runner on
   `tests/internal/evaluator_index.test.yo` with that flag on to keep the batch `.yo`.
2. Emit its C for Linux: `./yo-cli compile <batch>.yo --target aarch64-linux-gnu --emit-c
--skip-c-compiler --release`.
3. In `__yo_main_module_init`, count `HashMap(String,bool)` `new`/`_alloc_with_capacity`
   calls against assignments to `g_*` globals. A count mismatch localizes the orphan
   immediately; equal counts would mean the pointer is lost somewhere else and the search
   moves to whatever else module init does with it.

Also worth ruling in/out: whether the batch harness re-initializes modules per test
(each test runs as its own process with `YO_TEST_INDEX`, so it should not), and whether a
module-level initializer that is itself a _comptime-folded_ value gets both a comptime
materialization and a runtime one.

## Impact on CI

The `compiler-internal-tests` job runs with `--bail`, so it stops at the first leak. This
is the second leak found by that job, and it is in the TS arm, so it blocks the job for
both compilers. Until it is fixed the job cannot go green, which is why
`continue-on-error: true` is still on it.

The job's self-hosted differential arm (which runs with `if: always()`) reported
**826/826** on the same commit, matching a local macOS run — so this is specifically a
leak-detection failure, not a functional one.
