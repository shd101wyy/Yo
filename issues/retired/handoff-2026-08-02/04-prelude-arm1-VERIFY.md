VERDICT: SOUND-WITH-CORRECTIONS

## Verified (with measurement)

**(a) Repro reproduces.** But first a control correction: `/tmp/sh172` is **not** current HEAD — `md5(sh172)=77f18d6e…` vs `md5(/tmp/v_base)=7e29da9b…`, sh172 mtime 08:16 vs HEAD `4c9113f0a` committed 08:57. I rebuilt the unpatched tree as `/tmp/v_base` and re-ran everything patch-only.

|                  | markers | `b`                                                          |
| ---------------- | ------- | ------------------------------------------------------------ |
| `./yo-cli` (TS)  | 0       | `int64_t b`                                                  |
| `/tmp/v_base`    | 1       | `int32_t b` + `// Failed to transpile assert(b == i64(10));` |
| `/tmp/v_patched` | **0**   | **`int64_t b`**                                              |

Callee in the base C is literally `yo_id_2628_rtparam0_enum_yo_id_4976_i32_str_ret_i32`. Order-swap (`r4.yo`) → `int64_t b`, 0 markers ⇒ "first-declared wins" confirmed. Per-arm under `v_base`: **a0=0, a1=1, a2=0, a3=1** — exactly as claimed.

**(b) Root is the actual root, not a correlate.** Discriminating experiments: (1) declaration-order swap flips the answer with zero type-level change; (2) inserting _only_ the assigned-value guard flips selection to i64 and changes **nothing else** across 9 test files, `check ./std`, and `check ./yo-self`; (3) canary emitted C is byte-identical.

**(c) All TS references exist and say what is claimed.** `src/evaluator/calls/helper.ts:481-497` verbatim, including the comment `(e.g., TryInto(i32) vs TryInto(i64))`. `definitions.ts:432 assignedValue?: Value`; `function.ts:379,788`; `value.ts:699-705` → `areTypesCompatible(value1, value2, true)`; `helper.ts:401 requireExprNotConsumed(...)` unconditional. `grep -rn "Value mismatch for parameter" yo-self/` = **0**. Argument order in the patch is **correct**: yo-self `are_types_compatible_exact(actual, expected)` = `_compat_impl(actual, expected, true)`, TS is `areTypesCompatible(expected, given, true)` — so `(agv_ty, pav_ty)` is right.

**(d) All 17 anchors `count == 1`** — `apply.py` asserts it per hunk; all 17 printed `ok`.

**(e) Patch parses, type-checks, and my check has teeth.** `fmt --check` rc=0. `./yo-cli check` on patched copy vs pristine copy: **295/305 both, byte-identical FAILED sets** (report's 240/242 was an older snapshot; the 10 failures are pre-existing circular-import ones). Teeth proven twice inside the new block: renamed callee → `Error: Variable "are_types_compatible_exact_NOSUCHFN" not found` rc=1; dropped argument → `Expected: 4 arguments / Got: 3 arguments` rc=1.

**(g) Target fixed, canaries clean.**

- arm 1 in batch form: hollow **1 → 0**, rc **0 → 1**, exactly 9 `error: call to undeclared function 'fn_yo_id_…'`, `grep -c try_into` in the emitted C = **0** — §8 confirmed precisely.
- `tests/array` / `tests/for_macro_borrow` / `tests/closure_capture_rc_leak`: emitted batch C **byte-identical** base vs patched.
- **Closed both gaps the report admitted:** `tests/basic.test.yo` (only `= Impl(Id)` site) base and patched both `rc=0 hollow=1 markers=1 33 passed`, hollow-marker text byte-identical. `check ./yo-self`: **305/305, 0 `error in`, rc=0 under both.**
- Extra masking canary: `tests/imm_map.test.yo` — `hollow=1 markers=1 21 passed` under **both**, no HOLLOW→abort flip. `comptime`/`derive`/`gadts` identical. `check ./std` 153/153 both.
- §7's independent divergence is real: `scratchpad/repro_assume_init_twice.yo` → TS `use of moved value: \`uninit_arr\``, `v_base` `evaluator OK`.

## Corrections (what the report misses)

1. **The guard is only half the TS mechanism.** When _no_ candidate matches, TS hard-errors; patched yo-self silently drops the statement and exits rc=0. New probe `n.try_into(u8).unwrap()` with only i32/i64 impls:

- TS: `Error: No matching call found … Value mismatch for parameter "_To": Expected: i32 / Got: u8`
- `v_base`: compiles, `int32_t b` (silently the **wrong** impl)
- `v_patched`: **rc=0**, `// Failed to transpile b := ((n.try_into)(u8).unwrap)();`
  So the patch converts _silently wrong code_ into _silently missing code_. Same for generic forwarding `n.try_into(T)` inside `fn(comptime(T) : Type, …)`: TS hard-errors, both yo-self binaries say `evaluator OK` (patched then rc=1 on the §8 emission gap). In-tree impact is zero — `try_into` appears only in `std/prelude.yo` and `tests/prelude.test.yo` — but "the guard rejects the wrong candidate" is only true when a right one exists.

2. **Faithfulness nit with a live tail.** The patch inlines the `TypeVal → are_types_compatible_exact` case at the guard instead of fixing `yo-self/evaluator/utils.yo:1447 are_values_equal`, which _is_ the port of `areValuesEqual` and is **missing** the Type/Type branch — it falls through to structural `val1 == val2`. That divergence stays live for its two other callers, `yo-self/evaluator/exprs/match.yo:598` and `yo-self/evaluator/builtins/expr_fns.yo:643`.

3. **Masking direction (f):** patch 1 _adds_ a rejection, so the imm_map-style unmasking mode does not apply. The symmetric hazard (new rejection turning a real green hollow) I hunted and did not find — 9 files + `./std` + `./yo-self` identical.

## Recommendation

**Land patch 1** — but not billed as "the prelude arm-1 fix". Bill it as: _port the `= <value>` assigned-parameter overload filter (helper.ts:481-497)_. It does **not** make `tests/prelude.test.yo` green: arm 1 goes hollow→honest-red rc=1, and the file stays hollow on arm 3. Conditions:

- Redo the A/B against a same-source control before merge (`sh172` is one commit stale; my `/tmp/v_base` / `/tmp/v_patched` pair is the clean one).
- Prefer adding the Type/Type→`are_types_compatible_exact` branch to `are_values_equal` (`yo-self/evaluator/utils.yo:1447`) and having the guard call it — identical behavior here, closes the latent match.yo/expr_fns.yo divergence.
- File the "all candidates rejected ⇒ statement silently dropped instead of TS's hard error" behavior as its own issue; add `n.try_into(u8)` as a regression case.
- **Do not land patch 2** (unresolved `tests/imm_vec` divergence) and do not expect arm 1 to go green until the §8 trait-impl-closure emission gap is fixed — that, not the selection bug, is arm 1's remaining blocker.

Artifacts: `/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/78b1efdd-c79e-4862-b659-aee64c319621/scratchpad/prelude-arm1-v/` (logs, `gate.sh`, `gate2.sh`, `gen/g1.yo`, `gen/g2b.yo`, `arms/a0..a3.test.yo`, `ys_patched/`, `ys_pristine/`); binaries `/tmp/v_base`, `/tmp/v_patched`.
