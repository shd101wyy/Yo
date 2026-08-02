VERDICT: SOUND-WITH-CORRECTIONS on the roots — **REFUTED on the stage-2 attribution and on the landing recommendation.**

## Verified (with measurement)

**(a) Repros reproduce.** `A_nom1`: sh172 rc=1 with the exact claimed marker `void _file____User_temp_1841 = // Failed to transpile (y.x) == 5;`; `./yo-cli` rc=0. `A_g4_min`: sh172 rc=1, `./yo-cli` rc=0.

**(c) Every TS reference exists and says what is claimed** — `function.ts:445-466` (`_` reroute, `isSomeType` the only exemption), `creators.ts:698-706` + `:723` (tuple id from field-type ids; `struct_${randomId}`), `collection.ts:351` (`if (context.types[type.id]) return;`), `helper.ts:1550-1607` (adopt), `helper.ts:1313+` (io_async pre-bind), `compatibility.ts:916` (`getValueOfSomeTypeFromEnv`), `compatibility.ts:676-796`.

**(e) Patch parses, type-checks, and my check has teeth.** `fmt --check` rc=0. `./yo-cli check` on a copy of `p2` = 295/305 with a **byte-identical failure set** to a pristine `yo-self` copy (10 pre-existing, all downstream of `evaluator/eval.yo`). Teeth: injecting `(sti_i : usize) = i32(0)` into the A2 arm made check FAIL at that exact line.

**(g) Canaries clean, including the report's own named blind spot.** HEAD vs P2, identical, 0 markers: array 12/12, for_macro_borrow 13/13, closure_capture_rc_leak 7/7, **imm_map 21/21, imm_sorted_map 17/17, generic_impl_trait_default_ne 1/1**.

**Section B is accurate.** TS rejects `B_io_i64` with the caret on the closure (7:58) → TS binds `T`; yo-self prints `Given: Impl : (Future[Future](T) E : E)` byte-identically for i32 and i64 → `T`/`E` unbound. B_w1's HEAD root confirmed via `/tmp/t5probe`: `Incompatible types: Expected: Impl : (ToString) / Given: Impl : (ToString)` at `B_w1.yo:7:4`. **A2 is separable** — an A2-only binary (`/tmp/va2`) fixes `A_g4_min` rc=0 with no A1.

## Refuted (with counter-measurement)

**1. The stage-2 crash is not A1's.** The report calls the crashing tree "A1+A2" and concludes "there is a third defect in that chain," recommending an A1-vs-A2 bisect. But `p2` is **A1+A2+B1**, and B1 was never a candidate. I reproduced rc=138 independently (real 2376s). Crash report `t5p2-2026-08-02-111130.ips`: SIGBUS / `KERN_PROTECTION_FAILURE` on the **Stack Guard** page, 128 MB thread stack, backtrace dominated by `fn_yo7d8efce2_id_23__compat_impl` self-recursing at one call offset, entered from **`_find_specialization_cache` → `create_specialized_function_inline`**. `_compat_impl`'s frame is `0x60+0x1b0` = 528 B and **identical** in HEAD and P2 → 128 MB ≈ 250k frames = _unbounded_ recursion, not depth. Attribution is direct: `_compat_impl` is 14808 bytes in `sh172` **and** in `va2` (A2-only), 15760 in `t5p2` — B1 is the only patch that touches it, converting the SomeT-vs-SomeT leaf into a recursive trait-subset walk, while yo-self's cycle guard pushes `vkey` only in the struct/enum/union arms (`compatibility.yo:566/697/753`), never the SomeT arm. **A1 appears in neither backtrace.**

**2. A2 alone also fails stage-2** — the experiment the report left open. `/tmp/va2 compile pa2/main.yo --release` → rc=138 at 893s. `va2-2026-08-02-113524.ips` says verbatim _"Thread stack size exceeded due to excessive recursion"_, 7× `get_type_string` self-recursion under `generate_function_prototype`. Caveat: the identical signature appears in a HEAD `sh172` crash at 08:27 today, so this may be pre-existing rather than A2-induced — unsettled (my HEAD control ran 59 min clean, then the harness killed it; the report's did the same at 55 min).

**3. Anchor correction.** Bare `_ => type_to_string(t)` in `type_key.yo` is **3**, not 2 (lines 444, 497, 579). The adopt anchor is `helper.yo:5256`, not 5255, and a second `evaluate_function_return_type_again` call sits at 5241.

## What the report misses

- **Its own blast-radius risk was realized, not "not observed."** §6B says the specialization-cache merge risk was unobserved; the P2 stage-2 backtrace enters `_compat_impl` _from `_find_specialization_cache`_.
- **B1 has zero measured payoff.** Its only flip is `B_w1.yo`, a repro authored for the report. basic 33/33 and async_await 116/116 are unchanged, and arm 65 stays hollow — yet B1 is the one patch whose function is in the crash.
- **The direction hazard is understated.** `are_types_compatible(actual, expected)`, but `assignment.yo:958` passes `(variable.ty, rhs_type)` = (TS-expected, TS-given) — inverted vs `helper.yo:5256`. This inverts the negative-trait check and the subset direction, not just constraint-list length. Two discriminators I built (`dir1`, `dir2`) were decided by unrelated rules, so this stays source-grounded, unmeasured.
- **The port drops `getEffectiveRequiredTraitTypes`** (env + scoped where-constraints) for the raw `required_trait_types` field — the likely reason recursion doesn't bottom out.
- **A2 cannot claim TS parity**: `stable_type_identity` has no TS counterpart (3 refs, all yo-self). It is a Gap-3/Gap-6 workaround, and its own doc comment warns the depth cap exists because the memoized instantiation chain is infinite — i.e. the alias A2 removes was **masking** work, exactly the failure mode you flagged, and the A2-only stage-2 then dies in `get_type_string`.

## Recommendation

**Do not land as a bundle.**

- **A1 — do not land.** A straight revert of a deliberate, documented scope narrowing (`issues/yo-self-anon-struct-literal-expected-type-ctor.md` § "Scope narrowing") whose stage-2 SIGSEGV is on record, with no new evidence the second-order codegen gap is closed.
- **A2 — do not land yet.** Separable and it does fix `A_g4_min` alone, but A2-only stage-2 SIGBUSes. Gate: run a HEAD stage-2 control to solo completion. If HEAD completes and A2 doesn't, A2 must land paired with a depth cap / cycle guard in `get_type_string`.
- **B1 — do not land.** No measured payoff; its function is the one self-recursing in the crash. Revisiting needs (i) a cycle guard covering the SomeT arm, (ii) `getEffectiveRequiredTraitTypes`, (iii) a direction audit of `assignment.yo:958`.
- **B2** remains arm 65's real root; the report's localization is verified and its "no patch" stance is correct.

**Cheapest next measurement, and do this before treating any of these as compiler defects:** the crash reports show a **128 MB** worker stack, but `src/codegen/functions/generation.ts:1047` sets `__yo_main_stack = 1 GiB` and `YO_MAIN_STACK_MB` was unset. If the 1 GiB request is silently landing at 128 MB, re-run both stage-2 builds with `YO_MAIN_STACK_MB=4096` — that separates "unbounded recursion" from "deep but bounded" in one run each. Note all my timings ran on a contended 16 GiB box (swap 13.8/14 GB used, a 3 GB `/tmp/sclean` from another session); wall clocks are inflated, though stack-guard overflows are workload-deterministic and not explained by contention.

Artifacts: `/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/78b1efdd-c79e-4862-b659-aee64c319621/scratchpad/basic-async-v/` (logs, `pa2` A2-only tree, `pcopy`/`bcopy` check controls); binary `/tmp/va2` (A2-only). Working tree untouched apart from the pre-existing `src/tests/fixme.yo`.
