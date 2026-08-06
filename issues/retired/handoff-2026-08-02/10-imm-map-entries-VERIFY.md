VERDICT: SOUND-WITH-CORRECTIONS

The root is correct and I confirmed it with a discriminating experiment the report did not run. But three of its evidentiary gates are hollow or fabricated-by-duplication, and its own artifacts contain a patch-induced regression it missed.

## Verified (with measurement)

**(a) Repro reproduces.** `scratchpad/t2/v1_empty.yo` and `entries.yo`: rc=134, `get_enum_variant_c_name: no C type name found for enum <enum:enum_yo_id_8100>`, marker count 2 — on `/tmp/sh172` **and** on `/tmp/vhead`, a binary I built myself from current HEAD `4c9113f0a` (md5 differs from sh172, same behaviour). TS `./yo-cli`: rc=0. `/tmp/sclean`: rc=0, and the produced binaries **run** rc=0 (so `es.len()==2` actually holds).

**(b) Root CONFIRMED, not a correlate.** I split the patch and built two half-patch binaries:

- `/tmp/v_structonly` (`resolve_struct_shell` only) → **rc=0, fixed**
- `/tmp/v_enumonly` (`resolve_enum_shell` only) → **rc=134, unchanged**

The claimed lever (0-field **struct** shell of `ListNode`) is the actual lever; the enum half is inert for this bug. Both resolvers early-return unless the type has 0 fields/0 variants (`creators.yo:579-585`, `:534-540`), so the patch is a no-op on non-shells.

**(c) TS references are accurate.** `src/codegen/exprs/drop-dup.ts` `generateDropCodeForValue` recurses only for arrays/tuples; structs/enums go through `getDropFunctionForType` and `return ""` — no inline walk, so it can never reach `getEnumVariantCName`. `src/types/utils.ts:813` `getAllSomeTypes` walks `fields`/`variants` with no shell resolution (TS has no shells). `type_key.yo:86,255` (in `_type_key_at`) and `:505,535` (in `_stable_identity_at`) do resolve first. `creators.yo:559-568` says what is quoted.

**Stronger precedent the report missed:** `yo-self/types/utils.yo` `_type_contains_rc_inner` already does `ty := resolve_enum_shell(resolve_struct_shell(ty_in));`, calling itself the "fifth shell-consumption site" and documenting a real json value-loss bug from this exact class. The patch is the sixth, same shape, same file.

**(d) Anchors.** `grep -c '_collect_some_types_into :: ('` = 1 in the file and 1 in all of `yo-self/`; `'    ty : TypeValue,'` = 1.

**(e) Patch parses and type-checks, and my check has teeth.** I re-applied it independently to `…/scratchpad/imm-map-entries-v/ypatch`. `./yo-cli fmt --check` rc=0. `./yo-cli check` = **295/305, identical to HEAD's 295/305**. Teeth: injecting an arity error gave rc=1 + FAILED (`Too many arguments`); restoring gave rc=0.

**(g) No regression across 10 test files** (HEAD vs patched, sequential, batch artifacts cleared between runs, all `0 failed`, 0 transpile markers): imm_map 21, array 12, for_macro_borrow 13, closure_capture_rc_leak 7, imm_list 16, imm_set 19, imm_vec 47, imm_threading 30, recursive_enum 4, ref_enum 11 — **identical both sides**.

**Blast radius is far smaller than §6 claims.** 7/7 working programs (`scratchpad/w5/per/{eq,filter,keys,mapvalues,merge,remove,values}.yo`) emit **byte-identical C** under HEAD vs patch (`diff` = 0 lines). Only the target changes. "One hot predicate changed behaviour globally" is not what the measurement shows.

## Refuted (with counter-measurement)

1. **"`check ./yo-self` → 305/305; docs' 295/305 is stale."** False. `./yo-cli check ./yo-self` = **295/305, rc=1, 10 FAILED** (root: `yo-self/evaluator/eval.yo:4461`, `No matching call found: ((v.value).get)(usize(0))`; 9 cascading circular-import failures). The report's 305/305 came from the **self-hosted** binary: `/tmp/vhead check ./yo-self` reproduces `scratchpad/t2/head_check_self.log` **byte-identically**. That gate is hollow, and 295/305 is current, not stale. Its "0 `error in`" metric has no teeth here — `check` prints `FAILED`, never `error in`.

2. **The check gate's PATCH column was never measured.** `head_check_self.log` and `clean_check_self.log` are the same file (md5 `3e796f49…` both), and both contain relative `yo-self/…` paths, not `/tmp/yclean/…`. My independent run agrees with the conclusion (no regression), but the report's evidence for it does not exist.

3. **"`imm_map.test.yo` does NOT flip" is a vacuous gate for this bug.** `tests/imm_map.test.yo:110-123` ("Map keys, values, entries") calls `m.entries()` at line 114 — the exact aborting construct. I copied the file and injected `assert(false, "TEETH-PROBE-entries-arm")` after line 117: TS = **20 passed, 1 failed** (`✗ Map keys, values, entries`, SIGABRT); `/tmp/vhead` and `/tmp/sclean` both = **21 passed, `✓` on that arm**. The arm is hollow before and after; the patch does not un-hollow it. So "does not flip" carries no information about this defect.

4. **"`A_fn_ct.yo` — self rc=139 (SIGSEGV)."** False: rc=1, a C compile error. The report's own `scratchpad/t2/A_fn_ct.log` ends `3 errors generated / C compiler failed (exit 256)`.

5. **§3's panic-site mechanism is wrong.** `yo-self/codegen/exprs/drop_dup.yo:270` — `is_enum_type(concrete_type) =>` goes **straight** to the inline per-variant walk and never calls `get_drop_function_for_type`; only the struct arm at `:366` does the `.Some/.None` match. The inline enum walk is deliberate and unconditional (its own comment says registering a `___drop` method "mis-lowers"). It is not a `.None` fallback.

## What the report misses — a patch-induced defect in its own artifact

`scratchpad/t2/A_fn_ct.yo`, reproduced on my builds:

- HEAD (`/tmp/vhead`): 3 errors — the `size_t`/undeclared-identifier cluster at line ~1660.
- PATCH (`/tmp/sclean`): those **same 3, plus a new 4th** at line 1877:
  `error: initializing '__yo_t9_tag' with an expression of incompatible type '__yo_t22'`
  on `return (__yo_t8){ ._head = (__yo_t22){ .tag = __YO_T22_NONE }, ._len = 0ULL };`

A whole enum struct is emitted where the enum **tag** field is expected. This is the "more-resolved SomeT reaches a different emitter" hazard, realized. The report produced this log (`scratchpad/t2/A_fn_ct_clean.log`) and read it as "still open, unchanged". Here clang caught it; the same shape behind a cast or union is a silent miscompile.

Also unmeasured: drop-path correctness. rc=0 proves it runs, not that it does not leak or double-drop, and ASan is unusable on this box.

## Corrected recommendation: LAND PAIRED, not alone

1. Root-cause the new `__yo_t9_tag`/`__yo_t22` mis-emission on `A_fn_ct.yo` **before** landing — it is a patch-induced signature currently visible only because that file already fails.
2. Re-state the check gate honestly: `./yo-cli check` (TS), 295/305 on both sides. Drop the 305/305 and the `error in` metric.
3. Run the 186-file sweep (§7's own recommendation) — still right, but score arms against TS, since `imm_map` proves a green file can be vacuous.
4. Add the 8-line `v1_empty.yo` as a real regression test. `imm_map.test.yo`'s entries arm is hollow and will not catch a re-break.
5. Optionally note that only `resolve_struct_shell` is load-bearing (measured); keeping both matches `_type_contains_rc_inner`'s precedent.

Artifacts (all mine, tree untouched — `git diff HEAD -- yo-self src std tests` = only the pre-existing `src/tests/fixme.yo`): `/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/78b1efdd-c79e-4862-b659-aee64c319621/scratchpad/imm-map-entries-v/` (logs, `ypatch/`, `y_structonly/`, `y_enumonly/`, `tp/immmap_probe.test.yo`, `cdiff/`); binaries `/tmp/vhead`, `/tmp/v_structonly`, `/tmp/v_enumonly`.
