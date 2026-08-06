**VERDICT: SOUND-WITH-CORRECTIONS**

The five roots are real and every per-arm measurement reproduces exactly. Two of the report's _landing_ claims do not survive.

## Verified (my own measurements, isolated dirs to dodge the concurrent `yo-cli` runs)

- **(a) Repro is exact.** All 24 arms, `/tmp/sh172`: exactly **5 hollow (9,11,12,13,14)**, 19 `hollow=0`. Under `/tmp/t3all`: 9,12,13 → `hollow=0`; 11 → still `hollow=1`; 14 → `hollow=0` but **rc=1**, `use of undeclared identifier 'is_odd'` at `.bin.c:2252` — the exact line cited. TS on arm 14 = rc=0, 1 passed. `a14.test.yo` is a byte-identical extraction of `fn.test.yo:625-644`.
- **(c) All TS refs verbatim.** `ctfe-analysis.ts:183-188` (`type: comptimeFunctionType`, `value: comptimeFunctionValue, // Use the compile-time function value for recur`); `helper.ts:1752` (`let returnValue: Value | undefined;` assigned only under `if (functionType.return.isCompileTimeOnly)`); `initialization-assignment.ts:325` (`if (!rhsValue && effectiveIsCompileTimeOnly)`); `function.ts:447-467`, `553-587`, `1827-1834`. Also confirmed A's root independently: `recur.ts:37-38` reads `.type`, and `yo-self/evaluator/exprs/recur.yo:122-133` hard-errors on `.None` — so the NOTE comment patch A deletes ("does not read func_type") is **factually false**.
- **(d) Anchors unique.** Verified by an assertion-based applier requiring `count==1` at all 11 edit sites. _Correction:_ anchor C as literally quoted (`if(successes.len() == usize(0), { return(()); });`) has `grep -c == 0` — the real source spans 3 lines. Cosmetic.
- **(e) Patch parses, type-checks, and my check has teeth.** Rebuilt the 5 patches onto a clean copy (no debug probe): `./yo-cli check` = **295/305**, **identical 10-file FAILED set** to my HEAD baseline. Teeth: injected a wrong-arity call at patch B's own edit site → **rc=1 "Too many arguments for function call"**; restored → rc=0 OK.
- **(g) Canaries clean.** `array` 12 passed, `for_macro_borrow` 13 passed, `closure_capture_rc_leak` 7 passed — `hollow=0`, identical under both binaries.
- **Blast radius reproduced:** `imm_map` rc=0/hollow=1/21 passed → **rc=134**; `comptime` hollow=0 → **hollow=1**.
- **B's attribution upgraded from inferential to proven.** Under `/tmp/t3alldbg`, `comptime.test.yo`'s swallowed error is `Expected compile-time value for "neg_sum"`. That string has **exactly one** throw site (`initialization_assignment.yo:473`), inside the block B widens; HEAD's `.is_none()` gate cannot reach it for a `Some(runtime-only)` rhs. B is necessarily the cause.
- **A corpus test the report never ran** (patch C adds a new hard throw to a hot path): patched binary `check ./std` = 0 errors, identical to HEAD; patched binary `check ./yo-self` = **305/305, 0 FAILED**, identical to HEAD's 305/305. C does not misfire on ~400 files of real code.

## Refuted

1. **"`imm_map` … not created by E."** False where it counts. Measured: `tests/imm_map.test.yo` = rc=0, 21 passed on HEAD → **rc=134 abort** patched. E _does_ create the file-level RED; only the underlying defect is pre-existing (commit `10bca26bc`).
2. **"A, C, D are regression-free and can land now"** — refuted for **D**. Arm 14 goes from a vacuous `1 passed` to a **hard C-compile failure**. It is invisible in the whole-file sweep _only because arm 11 still hollows the batch and masks it_. D therefore plants a latent RED that detonates the moment arm 11 layer 2 is fixed — the identical unmask-a-codegen-defect mode the report cites for `imm_map` and then repeats.
3. **"E can land once the enum abort is fixed"** — under-specified. `issues/retired/yo-self-hollow-root-cause-map.md:3511+` (2026-08-02 CORRECTION) retracts that framing: _"register the missing enum is the wrong fix"_; the instance reaching codegen is genuinely unresolved (raw SomeT ids), "the same disease as the where-clause RED". E's dependency is the unresolved-generic-instantiation family, not a registration patch.
4. **Framing:** the full 5-patch set does not improve `tests/fn.test.yo` **at all** — `rc=0 hollow=1 24 passed` under both binaries. Net effect on `tests/`: **0 gains, 2 losses.**

## Missed

- **No stage-2/fixpoint validation.** D touches the exact gate whose broadening historically caused an s2 SIGSEGV. Mitigating datum I found: `yo-self` and `std` contain **zero** `= _(` / `:: _(` sites and D fires only on an expected `Func` type, so exposure is likely nil — but unmeasured.
- D was never isolated in its own binary (same weakness the report admits for B/E). Doesn't change the recommendation.

## Corrected recommendation

**Land A + C only.** Both have a real, TS-exact root, a unique anchor, a clean 295/305 check, and now zero regression across `tests/` (96), `std`, and `yo-self` (305/305).

- **D: land paired** with the arm-14 forward-reference codegen fix (§3.2) — not alone.
- **B: do not land** — confirmed regression, cause now proven; pair with the operator-receiver comptime-loss fix.
- **E: do not land** until the unresolved-generic-instantiation defect is fixed.

fn.test.yo is not reachable this round, as the report says — and A+C alone move it zero.

Artifacts: `/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/78b1efdd-c79e-4862-b659-aee64c319621/scratchpad/fn-blk10-enum-v/` (`apply.py`, `ys/` clean patched tree, `check_{head,patched}.txt`, `ys_{head,all}.txt`, `std_{head,all}.txt`, `head_results.txt`, `all_results.txt`, `rest_arms.txt`, `cmp_dbg.log`). No file under `yo-self/`, `src/`, `std/`, `tests/` was modified (`git status`: only the pre-existing `M src/tests/fixme.yo`).
