VERDICT: SOUND-WITH-CORRECTIONS on the facts, REFUTED on the causal conclusion (§6/§7) — the report's "load-bearing fix is C/D (`__impl_fn`)" is wrong, and its "necessary" delta A/B is a measured canary-killer.

## Verified (every fact I could re-measure held)

| Claim                                                                                   | My measurement                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| repro6 rc: TS 0 / HEAD 1                                                                | `./yo-cli` rc=0, binary rc=0; `/tmp/sh172` rc=1, **identical** first error `r6_sh172.c:1376:11: initializing '__yo_t3' … with … '__yo_t2'`                                                                                                                                                                                                                                 |
| `/tmp/sh172` == HEAD                                                                    | rebuilt HEAD myself (`/tmp/vhead`, tree clean vs `4c9113f0a`): byte-different binary, **identical** error/line/struct pairing                                                                                                                                                                                                                                              |
| two IterFilter structs vs TS's one                                                      | HEAD: `<struct:struct_yo_id_2935>` (`__yo_t3`) + `<struct:struct_yo_id_4986>` (`__yo_t2`), identical layouts. TS: one, `__yo_struct_yo1c2129e9_id_47682 // IterFilter(CountIter, __impl_fn(...))`                                                                                                                                                                          |
| both targets HOLLOW                                                                     | `YO_KEEP_BATCH=1` in an isolated dir: `iter_filter_closure` 3 passed / **1 real marker** covering the whole dispatch `match`; `iterator_combinators` 19 passed / **1 real marker**. Vacuous greens, confirmed                                                                                                                                                              |
| recorded root (trait-bound accumulation) refuted                                        | `grep -o "F____Fn[A-Za-z0-9_]*"` → **exactly 1** distinct key, one `Fn(*(A))->bool` bound. Recorded hypothesis is at `issues/retired/yo-self-hollow-root-cause-map.md:3672` and is indeed dead                                                                                                                                                                             |
| 4-row CTFE table                                                                        | re-ran `/tmp/t1probe` myself: rows reproduce **verbatim** (2864 / 2935 / 4984 sc=true hit=false / 4986 sc=true hit=false)                                                                                                                                                                                                                                                  |
| `__DBG_SET expr=57845 sid=struct_yo_id_2935 tyargs=CountIter\|F : (Fn(*(A)) -> bool)\|` | present verbatim in my own probe run                                                                                                                                                                                                                                                                                                                                       |
| TS refs (c)                                                                             | all four exist and say what is claimed: `function.ts:2836-2844` unconditional `evaluateExpression(cloneExpr(functionReturn.typeExpr))`; `helper.ts:2364-2373` unconditional call; `anonymous-function.ts:1206-1213` `__impl_fn` wrapper; `helper.ts:2242-2252` unwrap **only** into `runtimeParameters`; `comptime-fn.ts:129-140` returns `false` on SomeType/non-SomeType |
| yo-self refs                                                                            | `substitution.yo:301` preserves `id`; `function.yo:4773` resolves, never re-evaluates; `_collect_some_types_into` `.Struct` arm (`types/utils.yo:961-978`) walks **field_types only, not type_arguments** — so g1=false is real; `anonymous_function.yo:1755-1776` and `helper.yo:2374-2382` hazard notes verbatim                                                         |
| anchors (d)                                                                             | A/B/C/D all `grep -Fc == 1` at lines 2129 / 2165 / 1763 / 2092                                                                                                                                                                                                                                                                                                             |

## Refuted (counter-measurements)

**1. The closure `F` identity is NOT load-bearing — killing it does not fix the family.**

- `v1_namedfn.yo` (repro6 with a top-level `gt2 :: fn(x : *(i32)) -> bool` instead of a closure): no capture struct, **3** CTFE rows not 4, **one** struct id `4984`, no `__impl_fn` anywhere in TS's success path. TS rc=0. HEAD **still rc=1**: `// Failed to transpile (filtered.next)()`.
- `/tmp/t1probe5` (their candidate 1+2) on that file: emitted C contains a **single** struct `4962` — and it still fails identically.

**2. It isn't even about closures, `filter`, or generic-method return types.** Two new minimal repros, both TS-green:

- `v4_take.yo` — `iter.take(usize(2)).next()`. HEAD rc=0 but **3 real markers**: the entire `main` body is swallowed (HOLLOW). No closure, no `F`. `IterTake(CountIter)` is never minted through the CTFE memo at all.
- `v5_direct.yo` (**the tightest repro I found**, reproduces on `/tmp/sh172` and fresh `/tmp/vhead`): user-defined `MyWrap :: fn(comptime(I) : Type) -> comptime(Type)(struct(_inner : I))` + `impl(generic(I, A), where(I <: Iterator(Item := A)), MyWrap(I), Iterator(...))`, instance built **directly** (`MyWrap(CountIter)(_inner : iter)`), then `w.next()` → `// Failed to transpile (w.next)()`. No closure, no generic method, no split (one struct id).
- Control `v8_mono.yo`: same file with the impl written **monomorphically** on `MyWrap(CountIter)` → HEAD rc=0, **0 markers**, binary runs. So the discriminator is _generic/where-clause impl over a comptime-constructed struct_, not `F`.

**3. §7's blast-radius claim for A/B is wrong, and it is exactly the masking hazard you warned about.** The report gates A/B only on self-build wall time. I ran the three named canaries in isolated dirs (no batch-artifact collisions):

| binary                             | array                      | for_macro_borrow           | closure_capture_rc_leak   |
| ---------------------------------- | -------------------------- | -------------------------- | ------------------------- |
| `/tmp/sh172` (HEAD)                | rc=0, 12 passed, 0 markers | rc=0, 13 passed, 0 markers | rc=0, 7 passed, 0 markers |
| `/tmp/t1probe3` (cand 1 only)      | rc=0, 12 passed, 0 markers | rc=0, 13 passed, 0 markers | rc=0, 7 passed, 0 markers |
| `/tmp/t1probe5` (cand 1 + **A/B**) | **rc=1, 12 C errors**      | **rc=1, 12 C errors**      | **rc=1, 4 C errors**      |

First error: `call to undeclared function 'yo_id_3196'` — removing the SomeT-free acceptance filter unmasks era-mismatched ids as undeclared functions. Attribution is clean: candidate 1 alone is canary-neutral; **A/B is the regressor**.

**4. Methodology correction.** "`./yo-cli check` clean = 0 `error in` lines" is not a valid gate here: `check ./yo-self` at HEAD emits **zero** `error in` lines while printing `— FAILED` for real files (e.g. `yo-self/evaluator/eval.yo:4458` `No matching call found`). Count `FAILED` too. Teeth proven on a copy (`ys3`): HEAD `types/utils.yo` → rc=0 `evaluator OK`; with an injected parse error → rc=1 FAILED; with an injected type error (`acc` → `usize(0)`) → rc=1 FAILED.

## What the report missed

- It never varied the closure. One 30-second experiment (named fn) falsifies its conclusion.
- It never ran a canary on the delta it calls "necessary", and A/B turns 32 green tests into hard C-compile failures.
- `iterator_combinators`' 19 arms include `take`/`skip`/`enumerate`/`zip` — none closure-shaped — so even a perfect `__impl_fn` port cannot flip that file.
- The root it describes is largely the already-recorded era-split root (`issues/retired/yo-self-hollow-root-cause-map.md`, 2026-07-31 + the 2026-07-30 imm_sorted_map ROOT CAUSE: "substitution keeps def-era ids; TS re-evaluates type exprs through the ctor memo"), plus `issues/repros/comptime-ctor-memo-split-map-insert.yo`. It reads as a rediscovery framed as new.

## Recommendation

**Do not land anything from this report** — there is no patch, candidate 1 flips nothing, and candidate 2 (A/B) must not land in any form: measured −32 tests across all three canaries. Delete "port `__impl_fn`" as the next step; it is refuted as the load-bearing fix (it would at most remove the second C error in the closure case, leaving `next` swallowed).

**The actual root** is one step earlier than the report's: a **generic/where-clause impl whose Self is a comptime-constructed struct (`MyWrap(I)`) never binds to the call-era instance (`MyWrap(CountIter)`)**, so the trait method fails to specialize and is swallowed. The def-era/call-era id split (report §3 component ii, `substitution.yo:301` + `get_all_some_types` not walking `type_arguments`) is the mechanism; the closure-`F` memo miss (component i) is a _second, additional_ divergence that only adds the `__yo_t3`/`__yo_t2` error on top.

Land-worthy next step: take `v5_direct.yo` (33 lines, TS-green, HEAD-red on both binaries, at `/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/78b1efdd-c79e-4862-b659-aee64c319621/scratchpad/trait-app-memo-v/v5_direct.yo`, with the `v8_mono.yo` monomorphic control beside it) into `issues/repros/`, and drive the impl-Self era fix from there — with the three canaries as a gate on every probe build, not self-build wall time.

Artifacts: `/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/78b1efdd-c79e-4862-b659-aee64c319621/scratchpad/trait-app-memo-v/` (`v1_namedfn.yo`, `v4_take.yo`, `v5_direct.yo`, `v8_mono.yo`, `can_summary.txt`, `can_summary3.txt`, `can_*_*.log`, `tooth_*.log`). Fresh HEAD binary: `/tmp/vhead`.
