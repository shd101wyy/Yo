> **CLOSED (2026-08-06).** The bootstrap campaign this document belongs to is
> complete: the self-hosted compiler passes the full suite, the stage-2/stage-3
> fixpoint holds, and every CI job gates PRs (run 31069479984, commit
> `ac85f6cfc`). Kept as a historical record — do not resume work from this
> file. Umbrella status: `plans/BOOTSTRAPPING.md`. What comes next:
> `plans/SELF_HOSTING_COMPLETION.md`.

# yo-self bootstrap — handoff

_Rewritten 2026-08-02 (end of day, `4047555d8`). Completed work was deleted,
not archived: per-round narratives live in `git log` of this file and in
`issues/*.md`. This document is only (1) where the campaign stands, (2) what
to do next, (3) how to measure honestly, and (4) the rules that must not be
re-learned._

**Goal:** make the self-hosted compiler (`yo-self/`) build and run `./tests`
as correctly as the TypeScript compiler (`src/`, the GROUND TRUTH).

> **Picking up CI work? Read `plans/archive/CI_GATING_HANDOFF.md` first.** Nine of ten CI
> jobs now gate PRs; that doc covers the single remaining blocker on the tenth
> (`compiler-internal-tests`), with the reproducer, three eliminated approaches,
> and the measured gate baselines. This document remains the campaign-wide record.

---

## 1. Where the campaign stands

**Honest score: 185 GREEN / 0 HOLLOW / 0 RED of 185 test files** — verified
by the full sweep at commit `46f614a30` (/tmp/cln*hsweep). The last hollow
(async_await, arms 65/72) flipped 2026-08-03 via the six-part fix chain in
issues/fixed/yo-self-io-await-shared-wrapper-poisoning.md: Future-param
generic-guard exemptions, the real `\_\_yo_future_trait*_`interface struct,
SEMANTIC io-builtin classification (extern-marker propagation, not receiver
names), arg-typed effect-bundle temps, SM-mapped nested capture literals,
and the 3-arg-while step renderer in the SM back-edge. Prior scores:
184/1/0, 183/2/0, 181/4/0 (2026-08-03), 180/4/1 (2026-08-02).
SWEEP HYGIENE: clean`tests/\*\*/.yo_selftest_batch_` before a sweep — a
stale batch from a prior gate run smears phantom hollow markers across the
whole sweep (measured: a corrupted sweep read 156/29 on a tree whose true
score was 181/4/0).

Green baselines every change must preserve:

| gate                   | baseline                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| honest sweep           | **186 GREEN / 0 HOLLOW / 0 RED** as of 2026-08-03 (`65ebcdbb2`; 185 + the new closure_param_forwarding regression file)                           |
| corpus diff-test       | **PASS 155 / DIFF 0 / SELF-FAIL 0 / TS-FAIL 0 / BOTH-FAIL 0** (155 total, re-measured 2026-08-06)                                                 |
| `check ./std`          | **153/153**                                                                                                                                       |
| `check ./yo-self`      | **237/237** (2026-08-06). Was 238 before `control_fn_registry.yo` was deleted as a duplicate; 301 before the tests move. All-green, not regressed |
| canaries               | `array` 12, `for_macro_borrow` 13, `closure_capture_rc_leak` 7 — all rc=0, 0 markers                                                              |
| stage2 emit            | rc=0, **markers=0** (`YO_MAIN_STACK_MB=4096 <bin> compile yo-self/main.yo --release --emit-c --skip-c-compiler`)                                  |
| stage2 clang           | rc=0, **0 errors** (the 4-error dyn-capture cluster fixed in `65ebcdbb2`)                                                                         |
| stage2/stage3 fixpoint | **FIXPOINT_HOLDS** — stage-2 and stage-3 C byte-identical (103.7 MB), verified `65ebcdbb2`                                                        |

### 2026-08-05 — the CI LSan blocker was a payload-free `ref(enum)` variant (`cf7bf1091`)

`MyVal.UnitVal` on a `ref(enum(…))` heap-allocates exactly like
`MyVal.IntVal(v : …)`, but the evaluator folded it to a comptime EnumValue and
never attached an owning temp — and **a value is dropped only if an env
`Variable` owns it** (`getVariablesNeedingDrop`, `src/env.ts:2272`). So every
inline `f(E.UnitVal)` leaked. That is the 96-byte LeakSanitizer failure in the
`Compiler internal tests` job (`tests/internal/context.test.yo:189` passes
`EvalValue.UnitVal` to `create_function_body_evaluation_context`); a standalone
repro of that single test leaks **112 B pre-fix, 0 post-fix**.

Two things worth carrying forward:

1. **The fix needs an evaluator half AND a codegen half.** Attaching the temp
   alone is inert: the `$.value`-first shortcut in `generateExpr` returned a bare
   expression string, and the drop emitters' `declaredCVarNames` gate silently
   skips a drop whose target was never declared. `materializeOwnedRcComptimeValue`
   supplies the declaration.
2. **Gate breadth is load-bearing.** `typeContainsRcType` recurses into variant
   fields, so it is true for a VALUE enum whose other variants carry RC payloads.
   Using it gave `Option(String).None` a temp and a drop despite being a
   zero-allocation compound literal, and took `check ./yo-self` from 238/238 to
   **71/238** via the not-consumed gate. The correct gate is
   `isReferenceEnumType(enumType) && some variant has fields`.

RC leaks are gated with **`rc(x)`**, not a sanitizer: put the allocation in a
helper and read the retained field in the caller — rc == 1 released, rc == 2
leaked. LSan is Linux-only, and macOS `leaks` at `-O2` reports 0 for a real leak
whenever the allocation's result is discarded (LLVM deletes the malloc). Read the
emitted C.

Three adjacent gaps were verified and filed rather than folded in:
`issues/fixed/yo-self-tail-expression-arg-temp-drop-missing.md` (yo-self emitted NO
scope-end drop for an owned RC arg temp in a bare tail-expression fn body —
pre-existing, reproduced on the untouched payload form; FIXED 2026-08-06 by
routing def-time fn-body eval through evaluate_begin_expression),
`issues/ctfe-elided-unit-call-arg-temp-leak.md`, and
`issues/fieldless-ref-enum-simple-enum-collapse.md`.

**Remaining CI blocker:** two Linux-only tier-1 battery failures —
`async_await` runs but fails 1 of 116, `imm_string` produces no summary at all.
Both pass on macOS and there is no local Linux, so `gates_fast.sh` now dumps the
failing gate's log (`04c5927b9`) to get evidence out of CI. `continue-on-error`
stays on the two informational jobs until both are green.

### 2026-08-06 — CI: 4 of 5 informational jobs now GATE PRs

`continue-on-error: true` was dropped from `bootstrap-fixpoint`,
`bootstrap-fixpoint-stage3`, `bootstrap-self-test` and `test-tsan`. Only
`compiler-internal-tests` still carries it.

Three Linux-only failures were root-caused and fixed to get there:

| failure                                 | root cause                                                                                                                                                                                                                                                                                                                                                  | fix                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| tier-1 `imm_string`, no test summary    | `rc()` on an atomic type emitted `atomic_load_explicit((_Atomic size_t*)&header->ref_count)` — a 4-byte field. clang could not inline a misaligned 8-byte atomic and emitted `__atomic_load_8`, undefined at link time on Linux. Also read `type_id`/`borrow_count` into the high bits, so every `rc(self)==1` CoW check in `std/imm/*` silently went false | `_Atomic uint32_t*`, matching `rc-fns.ts:549`       |
| tier-1 `async_await` 115/116            | a sync `io.await` of an RC result emitted a BARE COPY. yo-self's `get_dup_function_for_type` ALWAYS returns `.None` (it synthesizes no `___dup` methods, unlike TS), so TS's dead `else` branch is yo-self's only live path: 0 increments against 3 scope-end decrements                                                                                    | emit the inline dup (`generate_dup_code_for_value`) |
| `compiler-internal-tests` 488-byte leak | `function_value.yo` and `evaluator/types/control_fn_registry.yo` were exact duplicates declaring the same module global `g_control_fn_registry`, and module globals get UNMANGLED C names — both initializers wrote one C variable                                                                                                                          | delete the duplicate, repoint its one importer      |

That last one is worth remembering for its own sake: the aliasing was **load-bearing**.
The evaluator wrote through one copy and the codegen read through the other, so
namespacing module globals correctly — which is what a reader would assume already
happens — would have silently broken control-function (`unwind`) handling. Filed as
`issues/module-global-c-names-are-not-namespaced.md`; tree audit says
`std` 0 globals, `yo-self` 181/181 distinct, `tests` 2/2, so there is no second instance.

**Why `compiler-internal-tests` still carries the flag.** Dropping `--bail` (so one run
reports the whole scorecard instead of one leak per 3-hour run) surfaced 2 failures out of
826 in the TS arm: Linux-x86_64-only SEGVs in yo-self's parser on a multi-line
parenthesized `->` RHS. Pre-existing, and the job had never reached them. The self-hosted
arm of the same job passes all 826. Four hypotheses were eliminated with evidence — stack
exhaustion (49/49 pass locally with `YO_MAIN_STACK_MB=1`), `-masm=intel` (the batch has
zero inline asm), a struct-offset error (the effect record is a single `void* throw` at
offset 0), and a false repro that turned out to be a different leak. **RESOLVED
2026-08-06** — the root cause was the escape path dropping the unwound call's
result temp, not any of those leads; see
`issues/fixed/escape-path-drops-unwound-call-result-temp.md` and the section
"The escape path dropped the unwound call's result temp" below. Note the
"self-hosted arm passes all 826" asymmetry above was MISLEADING: the
self-hosted runner adds no sanitizer, so the two arms were never comparable
on this.

**A local stand-in for Linux LSan** (macOS has none): run the test with
`--keep-generated-files` to keep the ASan batch binary, then
`YO_TEST_INDEX=<i> leaks --atExit -- <binary>` per test. A sweep of all 58
`tests/internal` files found exactly one leak (`macro_helpers`, 96 B,
pre-existing, `issues/fixed/where-constraints-arraylist-96b-leak.md`). Prove such a sweep
non-vacuous before trusting a clean result — reintroducing the module-global collision made
it flag all 18 `evaluator_index` tests.

### `check ./yo-self` reached 305/305 (2026-08-05) — the "circular-import" label was WRONG

The 10 long-standing failures were never 10 problems and had nothing to do with
circular imports. They were **one root**: `EvalResult.value` is a plain `EvalValue`
(`value.yo:915`), but five sites in `evaluator/eval.yo` called `.get(usize(0))` on it,
copying the `Variable.value : ArrayList(EvalValue)` one-element-cell idiom.
`EvalValue` has no `get` and no `Index` impl, and `git log -S` shows the field was
never an `ArrayList` — the sites were wrong when written. Fixed in `9741db482`; see
`issues/fixed/yo-self-evalresult-value-cell-confusion.md`.

Two things hid it for so long:

- `check` stops at a file's FIRST bad definition, so only one of the five was ever
  visible — fixing three revealed two more.
- the code is **unreachable from the compiler build**: `main.yo` imports
  `evaluator/{context,exprs/_expr,values/anonymous_module,exprs/import,module_loader}.yo`
  directly and never `evaluator/index.yo`, the sole importer of `eval.yo`. So the
  self-compile and the fixpoint never touch these functions. `check` — which evaluates
  every definition including never-called ones — was the only gate that could see them.

Knock-on effect on `yo-self/tests`: the four the four macro/reflection files that failed as
"`✗ Module evaluation` / Failed to import module" with **no nested cause**, plus
`evaluator_index`, all import `../evaluator/index.yo` and were failing purely on this
cascade. All five now pass under BOTH compilers.

### `test`-subcommand differential, TS vs the self-hosted binary (2026-08-05)

First time the self-hosted `test` subcommand had ever been run over these trees.
Harness: per-file, strictly sequential, comparing `N passed / M total` + exit code.

| directory                          | files    | PASS        | how verified                                                                                                    |
| ---------------------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `./tests` (fast language suite)    | 186      | **186**     | full sweep, 2,644 individual tests, DIFF 0                                                                      |
| `./tests` (+1 new regression file) | 187      | **187**     | the added file verified individually on both compilers (6/6 each)                                               |
| `tests/internal`                   | 61 -> 58 | **58 / 58** | full sweep re-run AFTER the unary-operator fix; every file identical on both compilers, non-PASS detail: (none) |

The `tests/internal` row is a single clean measurement (`/tmp/re/dt_final/results.tsv`),
and it is the one that had been missing. An earlier version of this table quoted
"57 measured + 1" because the unary-operator codegen fix changes emitted C for EVERY
unary operator, and at that point only the 20-file battery, the 155-file corpus,
`check ./std` and `check ./yo-self` had been re-run — the other 56 files were last
exercised BEFORE the fix. The full re-run closes that gap: **58/58, zero divergences.**

> `tests/internal` was `yo-self/tests` until 2026-08-05; see the note in
> `.github/instructions/testing.instructions.md`.

**RE-VERIFIED after the CTFE nested-fn fix** (same day, `5959c31e9`): `tests/internal`
58/58 identical on both compilers again, non-PASS detail (none)
(`/tmp/re/dt_ctfe3/results.tsv`). That fix touches `calls/function_type.yo` — the
def-time body-eval path — so the whole chain was re-run, not just the repro: battery
20/20 rc=0 hollow=0, corpus PASS 155 DIFF 0, `check ./std` 153/153, FIXPOINT_HOLDS.
Worth knowing WHY the full chain is mandatory there: the first version of that fix
passed its own 5-test regression file and the repro, and was still broken — it leaked a
CTFE context flag that turned `tests/fn.test.yo` HOLLOW. Only the hollow gate saw it.

Getting here took two yo-self fixes, and the `eval_*` trio was retired with its
subject file:

1. **`eval.yo`**: five `.get(usize(0))` calls on `EvalResult.value`, which is a plain
   `EvalValue`, not the one-element cell `Variable.value` is. A source bug TS
   correctly rejected; it was the single root of all 10 `check` failures.
2. **`codegen/exprs/generation.yo`**: a unary trait-dispatched operator applied
   directly to a PARAMETER inside a closure-specialized fn emitted an FTT comment
   INSIDE the enclosing `if (...)`, wrecking the C parse. The lowering was already
   ported (`inline_fns.yo` -> `(!(x))`) but UNREACHABLE: `_operator_inline_name` had
   no `!` entry and only the INFIX gate routed to the inline path. See
   `issues/retired/yo-self-selftest-codegen-divergences.md`; regression coverage in
   `tests/closure_param_unary_operator.test.yo`.
   CAUTION for anyone widening that gate: it must key on the resolved inline name
   being `BF_YO_OP_NOT`. Admitting any 1-arg operator with an inline name diverts
   unary MINUS into `BF_YO_OP_SUB` and emits `(y) - ()` — caught by
   `tests/operator_grouping.test.yo`.

**Run this suite STRICTLY ONE FILE AND ONE COMPILER AT A TIME.** `macro_expansion` alone
needs 6.52 GB; two concurrent children on a 16 GB machine swap, and the swapping trips
the runner's own 600 s evaluator deadline, MANUFACTURING failures that do not reproduce
in isolation. An earlier `--parallel 2` sweep produced several such phantoms and they
were mistaken for real defects.

**The stage-2 dyn-capture cluster is FIXED and the FIXPOINT gate is
RESTORED (`65ebcdbb2`)**: the forwarded-closure spec-cache collision
(def-era void\* spec vs resolved-era concrete capture) was repaired via
spec-arg SomeT-chain resolution, the abstract-vs-concrete cache guard, the
degenerate-capbind guard, and the resolution-aware capture-struct key —
postmortem in `issues/fixed/yo-self-stage2-get-type-string-cycle.md`;
regression coverage in `tests/closure_param_forwarding.test.yo`. The same
change fixed the corpus `closure_impl_fn_capture.yo` SELF-FAIL (154/154).
Gate stage-2 on **emit rc=0 + markers == 0 + clang rc == 0 + FIXPOINT_HOLDS**.

`sys/bufio` and `thread` are FLAKY on this machine (intermittent SIGSEGV with
a ZERO-byte log — the phantom-kill signature). Re-run before believing either.

### The escape path dropped the unwound call's result temp (2026-08-06)

The last two failures in `compiler-internal-tests` (Linux-x86_64 SEGVs in
`tests/internal/parser.test.yo`) were a **TS codegen bug**, mirrored into
yo-self: at an `__yo_effect_escaped` check, the drop sets included the
**result temp of the very call that unwound**. That callee discarded its
continuation instead of returning, so the temp was never assigned and still
held whatever the ABI left in the return registers; `___drop` then
dereferenced it. Fixed by excluding that temp
(`escapedCallResultCName` / `escaped_result`), measured 16 → 0 bad drops of
515 escape-checked call sites in the parser batch's emitted C. See
`issues/fixed/escape-path-drops-unwound-call-result-temp.md`.

Two durable lessons:

- **`tests/internal/parser.test.yo` rebuilds in 11 s** — it imports only
  lexer/token/parser/expr, not the evaluator. It is a fast loop for parser and
  codegen work, unlike the the four macro/reflection files.
- **Do the arithmetic on ASan's `pc`/`sp` across runs before reaching for
  sanitizers.** Constant low bits of `pc` across different ASLR bases, plus a
  constant `pc - sp`, means a _specific stack slot's address is being called_ —
  far narrower than "wild jump". Then grep the named frame for its indirect calls.
- **A macOS-arm64-passes / Linux-x86_64-crashes split is an ABI question early
  on** — but CHECK SIZES before naming a mechanism. x86_64 SysV passes an sret
  pointer in RDI (shifting argument registers) only for MEMORY-class returns,
  i.e. **>16 bytes**; arm64 uses the dedicated X8 and shifts nothing. A struct of
  exactly 16 bytes comes back in RAX:RDX — and both `String`
  (`Option(ArrayList(u8))`) and `ParseResult` are exactly 16 bytes. An sret
  explanation for this bug was drafted and then RETRACTED for that reason; what
  the garbage register actually held was never pinned down, and the fix did not
  need it.
- `___drop`/`___dispose` are `always_inline`, so a bad drop names the **enclosing**
  function in the trace with no drop frame. Absence of a drop frame is not
  evidence that no drop was involved.

Still open and filed: `issues/ctl-handler-void-signature-vs-sret-cast.md` — a
`ctl` handler is emitted `void` while each call site casts it to the surrounding
expression's type. Benign for return types ≤16 bytes (the whole current corpus;
`ParseResult` sits exactly on the 16-byte boundary), an argument-shifting ABI
break above it. `-fsanitize=function` would catch it and is not yet enabled.

### Memory footprint of a self-emit (the open perf debt)

A self-emit holds **~9 GB live** but **touches ~28 GB** (stage-1 binary) /
**~39 GB** (the SELF-BUILT stage-2 binary — measured `peak memory footprint`
38.7 GB, an open asymmetry worth investigating) over the run. macOS hides the
cold pages in its compressor (9.0 GB RSS); Linux pushes them all to swap —
ubuntu CI `time -v` + a `free -m` sampler showed 12 GB RAM + ~19.5 GB swap for
the stage-2 emit, identical under glibc and mimalloc, THP on or off. The gap
is allocation CHURN: pages the evaluator allocates, frees, and never reuses.
On a 16 GB CI runner this swap-thrashed until the runner agent starved
("runner has received a shutdown signal") — the bootstrap-fixpoint jobs now
run each emit in a systemd scope (`MemoryHigh=11G`/`MemoryMax=14G`, nice, THP
off, 32 GB /mnt swapfile, zswap) to stay alive; see
`.github/workflows/test.yml` and `issues/fixed/gc-cleanup-thread-sweep-uaf.md` for
the runner-death history.
Knob measurements (solo runs, mimalloc chain, output byte-identical in all):
`YO_GC_THRESHOLD=0` (cycle collector off) cut wall 660s→426s (−35%) — the
full-heap trial-deletion scans were the overhead, and their cold-page
re-touching is what turned CI swap into thrash. The GC stays ON (product
decision); the same −35% was then recovered WITH the GC on by the
**per-VARIANT GC-registration gate** (2026-08-04): a ref-enum variant whose
fields cannot reach back to the enum has no outgoing RC edge that could close
a cycle, so its instances skip `__yo_gc_register` even when the enum is
cycle-capable. EvalValue.IntLit/StrLit/BoolVal/UnitVal and every TypeValue
primitive leaf — the dominant instance populations — left the tracked set
(static census: 173→139 registering constructors; emit wall 660s→432s with
GC on; cycle_collector/ref_enum/recursive_enum/gc_cleanup_exit all green).
Both compilers carry the gate: TS `generateRefEnumConstructorFunctions`
(per-variant `typeCanFormCyclicRcReference`) and yo-self
`_generate_one_ref_enum_constructor_set` (`_type_refs_back_to_cyclic`).
Rejected knobs: `MIMALLOC_PURGE_DELAY=0` (footprint WORSE, 28.0 GB vs 24.9 —
purged pages recount on reuse); `YO_GC_FULL_PCT=130` (no footprint effect —
churn is mostly untracked allocations).
**Churn campaign round 1 (2026-08-04, `0f982af5d`):** the top churn site was
`clone_env` (deep per-frame variable-list copy) at the four
unification/specialization env builds whose TS ground truth is `pushEnvFrame`
(shallow frame sharing) — replaced with `snapshot_env`: emit wall 432s→402s,
footprint 28.0→22.75 GB. The 27 nullary TypeValue leaf creators now return
interned module-global singletons (measured ~neutral on volume but removes
millions of 176-byte allocations). Combined vs the campaign-start GC-on
baseline: **stage-1 emit 660s→399s (−40%), footprint 28.0→22.5 GB (−20%);
self-built binary emit footprint 38.7→33.1 GB (−14%)**. Profiling notes:
attribute `sample`-profile allocator frames to `fn_yo` ancestors; dispose
chains of Environment/ArrayList graphs dominate what remains.
**Remaining debt: allocation churn — the TS-parity gap.** Same-machine,
same-job comparison (compile yo-self/main.yo → emit C, 2026-08-04):
TS/node **113 s wall, 5.75 GB RSS, 6.05 GB footprint** vs yo-self
**399 s, 8.3 GB RSS, 22.5 GB footprint** — 3.5× wall, 1.45× RSS, 3.7×
touched. V8's footprint ≈ its live set (nursery scavenging absorbs churn);
yo-self pays malloc+RC full price per object.

Constructor census (per-constructor counters injected into the emitted C —
`scripts/bootstrap/instrument_ctors.py`, counts for one self-emit):
**ArrayList(u8) 1.75 B** (string byte-buffer handles), **Token 494 M**,
**ArrayList(EvalValue) 489 M**, **Variable 489 M**, ArrayList(String) 110 M.
~99% of the Variable/Token traffic sits under
`try_to_call_function_with_arguments` (the per-call parameter-binding
trial). NOTE: `synthetic_token` itself is only ~4 M calls (its
`String.from("")` is now interned — `g_synthetic_token_input`, −0.5 GB
RSS); the other ~490 M Token constructions come from a different site —
run a per-SITE census (instrument callers of
`__yo_new___yo_struct_<Token>`) to find it.

Churn campaign rounds 3–5 (2026-08-04, `21fdc9b71`): the four
seen/contains helpers deep-cloned every visited string per probe
(~430 M buffer allocs — now compare in place; NOTE the compact
bool-valued match form MISCOMPILES self-hosted, statement-arm shape
required — issues/yo-self-bool-match-arm-miscompile.md, caught by the
fixpoint gate); synthetic_token now interns Tokens by
(module_path → name) — the census measured ~486 M calls / thousands of
distinct pairs (Tokens are immutable, sharing unobservable).
Round 6 (2026-08-04) found and killed the root of the whole census —
**the per-call capture-env rebuild**. `FuncVal` cannot hold an
`Environment` (env.yo imports value.yo, so the reference would be
circular), so it carries a FLAT capture snapshot
(`cap_names`/`cap_tys`/`cap_vals`) and the call path re-bound EVERY
captured name into a fresh env on EVERY call — and a module-level
function captures its whole module scope, so that is ~660
`add_variable_to_env` calls per function call. Per-call-site counters
in the emitted C (see §"per-site census" below) pinned it exactly:
**452 M of 489 M Variable constructions came from ONE line**
(`helper.yo` Step 4) and 31 M more from the sibling loop in
`evaluate_function_call` — 99% of all binding churn. TS pays O(#frames)
here (`pushEnvFrame(functionType.env)` shares Frame objects).
Fix: `capture_env_for` (env.yo) memoises the built env per FuncVal
instance — keyed by `func_id`, validated by POINTER identity of the
`cap_vals` list (`__yo_ptr_eq`, so a second closure instance of the
same lambda misses and rebuilds) plus module-path equality, bounded at
512 entries — and hands out a `snapshot_env` copy so the caller's
`push_frame` cannot disturb the shared capture frame. Sharing the
capture frame across calls of one closure is exactly TS's aliasing.

**Ledger (all GC ON, every round gated by battery + corpus 155 +
`check ./std` 153 + stage-2/stage-3 FIXPOINT_HOLDS):**

| round                                                                                                   | malloc volume | emit wall   | peak footprint        | self-built binary's own emit |
| ------------------------------------------------------------------------------------------------------- | ------------- | ----------- | --------------------- | ---------------------------- |
| campaign start                                                                                          | 490.8 GiB     | 660 s       | 28.0 GB               | — / 38.7 GB                  |
| r1–r5 (snapshot_env, interning, clone-free probes)                                                      | 375.8 GiB     | 407.7 s     | 20.01 GB              | 407 s / 30.7 GB              |
| **r6** capture-env memo                                                                                 | 159.0 GiB     | 180.0 s     | 13.11 GB              | 132 s / 20.8 GB              |
| **r7** read-only clone sweep                                                                            | 135.7 GiB     | 169.8 s     | 13.11 GB              | 128 s / —                    |
| **r8** intern-key StringBuilder                                                                         | 127.0 GiB     | 163.3 s     | 13.11 GB              | **116.4 s / 18.9 GB**        |
| **r9** comparison clones + usize-keyed arm ranges                                                       | **119.7 GiB** | **157.1 s** | 13.12 GB              | 116.8 s / 18.9 GB            |
| **r11** shared empty value cell + path-collection COW                                                   | **119.2 GiB** | **153.4 s** | **12.76 GB**          | **112.2 s / 18.7 GB**        |
| **r12** evict the capture frames' name indexes                                                          | **119.4 GiB** | 159.5 s     | **12.00 GB**          | 118.4 s / 18.4 GB            |
| **r13+r14** `Variable.id`/`Frame.id`/`Frame.index_key` String → usize (+ the side tables keyed on them) | **118.1 GiB** | **155.9 s** | **11.45 GB**          | **110.9 s / 17.6 GB**        |
| TS reference (same job)                                                                                 | —             | 113 s       | 6.05 GB (5.75 GB RSS) | —                            |

Rows r1–r14 above are **mimalloc** measurements (see the allocator note below).
Round 15 onwards is measured with the shipping default allocator, so it gets its
own ledger — do not compare the two tables directly:

| round (libc allocator)                                     | wall    | peak footprint | `sizeof` changes                    |
| ---------------------------------------------------------- | ------- | -------------- | ----------------------------------- |
| HEAD `2b6aa1db7`                                           | 98.8 s  | 9.99 GB        | ExprInfo 624, Variable 256          |
| **r15** ExprInfo rare-field group + Variable bool grouping | 101.6 s | **9.27 GB**    | ExprInfo **456**, Variable **224**  |
| **r16** Variable rare-field group                          | 98.7 s  | **9.08 GB**    | Variable **192** (VariableRare 104) |
| TS reference (same job)                                    | 113 s   | 6.05 GB        | —                                   |

Cumulative r15+r16: footprint **9.99 -> 9.08 GB (-905 MB)** with wall unchanged
(98.8 -> 98.7 s, still faster than TS's 113 s). Ratio to TS: **1.50x** touched.
The layout diets are now essentially exhausted — everything still inline in
`ExprInfo` and `Variable` is a field that IS set often — so the remainder of the
gap is the `ExprInfoTable` retention lever below, which the live census sizes at
~4.5 of the 6.5 GB accounted heap and which the read-set measurement sizes at
~3.5-4 GB recoverable.

So: **volume −76%, wall −77%, touched memory −54% vs the campaign start**;
against TS it is 1.38× wall for the TS-built stage-1 — and the SELF-BUILT
compiler compiling itself is now FASTER than TS (110.9 s vs 113 s) — with
1.89× touched memory (8.52 GB RSS vs 5.75 GB, i.e. 1.48× live).

Two live-set wins landed after the census: the ONE shared empty
`Variable.value` cell (an empty cell is never written — nothing pushes into a
value cell, a reassignment mints a fresh one, and `&(x)` refuses to build a
`PtrVal` from an empty cell) and the ONE shared empty `ExprInfo.path_collection`
with copy-on-write at the three push sites (`expr_info_paths_for_write` detects
the shared instance by `__yo_ptr_eq`). A third — bounding the never-evicted
`g_frame_indexes`, worth **−1.8 GB** — passed every gate but BROKE the
stage-2/3 fixpoint (type-numbering divergence): reverted and written up in
`issues/yo-self-frame-index-bound-breaks-fixpoint.md`, which also names the
latent bug it points at (frames DO shrink — `comptime_expect_error.yo:213` pops
variables — so a pop-then-push leaves the name index stale with
`indexed_len == n`, and forcing a rebuild changes lookup results).

r12 landed the SAFE half of that idea and CONFIRMED the diagnosis: evicting only
the capture frames' `index_key`s when `capture_env_for` drops its cache (they are
built once by the capture loop and never mutated, so a rebuild is identical)
recovers 0.76 GB with **R12_FIXPOINT_HOLDS**. The remaining ~1 GB the wholesale
clear reached belongs to frames that DO mutate — do not touch those until the
staleness bug in issues/yo-self-frame-index-bound-breaks-fixpoint.md is fixed.

**READ THIS BEFORE QUOTING ANY NUMBER IN THE LEDGER ABOVE: the whole ledger was
measured with `--allocator mimalloc`, which on this machine is BOTH SLOWER AND
FATTER than the shipping default.** A/B on byte-identical input (a pristine HEAD
worktree), same machine, back-to-back, `2b6aa1db7`:

| allocator                                                                           | wall       | max RSS     | peak footprint |
| ----------------------------------------------------------------------------------- | ---------- | ----------- | -------------- |
| **libc (the default — `--allocator` defaults to `libc`, src/codegen/index.ts:192)** | **98.8 s** | **8.32 GB** | **9.99 GB**    |
| mimalloc                                                                            | 150.7 s    | 8.51 GB     | 11.52 GB       |

+53% wall and +15% footprint for mimalloc (sys time 11.9 s vs 2.1 s — page
management). The ledger's "155.9 s / 11.45 GB" row IS this mimalloc run. Against
TS's 113 s / 5.75 GB RSS / 6.05 GB footprint, HEAD under the shipping default is
**already faster than TS (98.8 s) at 1.65× footprint**. Keep using mimalloc only
when you want `MIMALLOC_SHOW_STATS=1` allocation-volume accounting; never quote
its footprint as the product number.

**AND STOP TRACKING `maximum resident set size` ON THIS MACHINE — it is clamped,
not measured.** Six runs of the same job on 16 GB of RAM: 8.17, 8.25, 8.27,
8.32, 8.51 GB RSS — a 4% spread — while their `peak memory footprint` ranged
7.9 → 11.5 GB. That is a system memory-pressure ceiling (macOS evicts to the
compressor), so RSS says nothing about a change that removes 700 MB of live
data. **`peak memory footprint` is the metric that responds**; cross-check real
live data with `scripts/bootstrap/live_census.py`, which accounts for 86% of it.

**Round 15 (layout diets, 2026-08-04):** `sizeof(ExprInfo)` 624 → **440 B** by
moving thirteen rarely-set optional fields behind one `Option(ExprInfoRare)`
(accessor pairs `expr_info_<field>` / `expr_info_set_<field>` in
`yo-self/expr_info.yo`; 78 call sites migrated), and `sizeof(Variable)` 256 →
**224 B** by grouping its ten `bool` flags last so they stop costing 8 B of
alignment padding each (all ten `Variable(...)` sites use named args, so field
order is free). Measured: **100.7 s / 8.25 GB RSS / 9.51 GB footprint** — i.e.
footprint −480 MB but **RSS only −70 MB against the predicted −651 MB**. The
gap is the point: an ExprInfo that sets ANY of the thirteen allocates a 256 B
`ExprInfoRare`, and the census found **1.74 M of 3.35 M live ExprInfos (52%)
did** — 446 MB of rare groups, cancelling most of the win.

A per-setter profile (`scripts/bootstrap/instrument_calls.py --fn` +
`report_calls.py`; the setters are named module-level fns so they appear
directly) found ONE field responsible:

| `expr_info_set_*`                                                                                             | calls in one self-emit |
| ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **origin_type**                                                                                               | **3,073,159**          |
| converted_runtime_type                                                                                        | 222,334                |
| case_executed                                                                                                 | 39,443                 |
| runtime_destructurings                                                                                        | 3,074                  |
| dyn_call_trait_values                                                                                         | 1,066                  |
| async_state_machine_struct_name                                                                               | 28                     |
| primitive_pattern_values                                                                                      | 4                      |
| is_primitive_match                                                                                            | 2                      |
| closure_function_value, consumed_variable_drop_expressions, effect_analysis, await_analysis, async_stack_size | **0**                  |

`_expr_info_rare_for_write` ran 3,339,110 times, so `origin_type` alone is 92%
of it. It is now INLINE again (twelve fields stay boxed) — and because every
access goes through the `expr_info_<field>` / `expr_info_set_<field>` accessor
pair, moving a field across that line is a change to `yo-self/expr_info.yo`
ALONE, with zero call-site churn. **That is the reusable lesson: group only
fields whose MEASURED set-rate is near zero, and always verify with the census
that the group object count is small.** For reference, the same profile gives
`expr_info_table_get` 99,390,558 calls, `expr_info_table_set` 6,558,362 and
`new_expr_info` 5,360,183.

**The footprint stopped moving at 13.1 GB across r7-r9 while volume fell
39 GiB — churn is no longer what sets it.** RSS is 8.5 GB of LIVE data plus
~4.6 GB of touched-then-freed pages. A live-object census (constructions
minus disposals per type, `scripts/bootstrap/live_census.py` +
`sizeof_all.py` + `live_report.py`) accounts for 8.63 GB of retained heap at
exit — i.e. essentially all of RSS:

| retained | live objects | size | type                                                    |
| -------- | ------------ | ---- | ------------------------------------------------------- |
| 2011 MB  | 3.22 M       | 624  | ExprInfo                                                |
| 1924 MB  | **7.29 M**   | 264  | **Variable**                                            |
| 1421 MB  | 17.8 M       | 80   | ArrayList(u8) (String bufs)                             |
| 585 MB   | 7.31 M       | 80   | ArrayList(EvalValue) (value cells, 1:1 with Variable)   |
| 543 MB   | 6.79 M       | 80   | ArrayList(usize)                                        |
| 487 MB   | 4.68 M       | 104  | AstExpr                                                 |
| 359 MB   | 3.20 M       | 112  | Environment                                             |
| 287 MB   | 2.11 M       | 136  | Token                                                   |
| 258 MB   | 3.22 M       | 80   | ArrayList(ArrayList(String)) (ExprInfo.path_collection) |
| 255 MB   | 3.19 M       | 80   | ArrayList(Frame)                                        |

**Read the chain, not the rows: 3.22 M ExprInfos each hold a
`snapshot_env` (3.20 M Environments + 3.19 M frame lists), those pin the
Frames, and the Frames pin 7.29 M Variables — one per binding EVER made,
plus a value cell and id/name Strings each. Nothing the evaluator binds is
ever freed.** `new_expr_info` (expr_info.yo:413) snapshots the env for
EVERY evaluated expression (5.03 M calls, 6.03 M table writes) into a
process-lifetime `HashMap(ExprId, ExprInfo)`, and ~3.5 M of those entries
belong to throwaway clones (`clone_expr_fresh_ids` runs 2.35 M times, ~3.4
per call, for argument/return-type re-evaluation) whose nodes never reach
codegen. THAT is the remaining 2-4 GB, and it is the next arc:

**PRUNE ATTEMPTED AND REJECTED 2026-08-05 — read
`plans/archive/YO_SELF_EXPRINFO_PRUNE.md` before touching this.** Codegen does read only
843,691 of the table's 3,390,355 entries (24.9%), but a per-module env-release
prune that released **3,084,494** of them (91%) bought only **1.13 GB**
(9.08 -> 7.95 GB) at a cost of **+79 s (+80% wall)**, and the variant that
achieved it was incorrect (emitted C differed by 84 KB / 890 k lines; it was
missing the module SOURCE trees as mark roots, and the correct version marks
strictly more while releasing strictly less). **The conclusion is that
`ExprInfo.env` is NOT what pins the 7.4 M live Variables** — the chain in the
census is real but not causal, so find the other Frame holder
(`SpecializedFunctionCache.env`, `g_func_parameters_frame`, `g_capture_envs`,
`g_loading_envs`) with a holder-attributing census BEFORE attempting any further
retention work. The design, the audited mark roots, why
the prune must run DURING evaluation (the peak is at the end of eval, not in
codegen), and why sharing `snapshot_env` is impossible are all in
`plans/archive/YO_SELF_EXPRINFO_PRUNE.md`. That is the whole remaining gap to TS.

- Prune the table before codegen: mark the ids reachable from the final
  program AST + every stored specialization body + the macro-expansion and
  async/effect side tables, then `table.data.remove(id)` the rest
  (`ExprInfoTable` is a `newtype(data : HashMap(ExprId, ExprInfo))`, so the
  removal API already exists). Every root source must be covered — a missed
  root means codegen reads a missing info, so gate on the corpus + fixpoint.
- Or stop recording an env for provably-throwaway re-evaluations (the
  `_trial_eval_*` helpers are only ~10 K calls, so the volume is in the
  ordinary call path's `clone_expr_fresh_ids` sites in helper.yo /
  function.yo — each needs a check that no later reader wants that info,
  because e.g. `runtime_arg_exprs_in_order` DOES hand cloned arg exprs to
  codegen).
- Layout diets, worth ~600 MB each and mechanical: box ExprInfo's 13
  rarely-read Option fields (~84 access sites) 624 → ~432 B; box Variable's
  rare Options (`is_owning_the_same_rc_value_as`, `initialized_at_token`,
  `parameter_alias`, `doc_comment`) 264 → ~176 B.
- NOT viable (checked): deduping the per-annotation `snapshot_env` between
  expressions in the same scope. Several consumers use a recorded env as a
  live evaluation env (`evaluate_expression_raw(dup_expr, ei.env, …)`,
  `env.frames = bi.env.frames` in closure_type.yo:262 / iso.yo:122), so a
  shared snapshot would be mutated under other holders.

Residual wall time is RC traffic: ~15 B `___dup`/`___drop` calls per emit.
Levers there: RC header diet (replace the two per-object fn pointers, 16 of
56 B, with a type-id into static tables) and the Variable/ExprInfo diets
above. Cold-but-real: `_bind_some_type` builds a 22-field Variable to change
2 fields (synthesizer.yo:348 — write `ty`/`value` in place on the
ref-struct); `_build_def_time_body_env` (function_type.yo:317) still
flattens every caller frame where TS shares references
(`keepTopLevelFrameAndComptimeVariablesFromEnv`).

Struct sizes (measured — compile the emitted-C typedef prefix plus a
`sizeof` main, `scripts/bootstrap/sizeof_all.py`): ExprInfo 624 B, Variable
264 B, Token 136 B, TypeValue 176 B, EvalValue 96 B, AstExpr 104 B,
Frame/Environment 112 B (all including the 56 B RC header).

**Per-site census (the technique that found round 6).** Injecting one
counter per _constructor_ only tells you WHICH type churns; to get
WHERE, rewrite each textual call site in the emitted C to
`(__yo_site_n[K]++, fn_name)(...)` and dump the array from a
`__attribute__((destructor))`, keeping a K → (line, enclosing
`fn_yo<mod>_id_N_<name>`) map. Named module-level functions keep their
Yo name in the emitted C, so sites resolve straight back to source.
Instrumenting all 4912 named function definitions the same way gives a
full call-count profile for ~0% wall overhead
(`scripts/bootstrap/instrument_calls.py` + `report_calls.py`). The TS side
has an equivalent built in: `YO_DEBUG_CALL_PROFILE=1` prints
`tryToCallFunctionWithArguments` / `createSpecializedFunctionInline`
counts and per-function breakdowns (helper.ts:736). Reference numbers
for the same job: TS 899,506 tryToCall / 2,591 specializations (92%
cache hits) / 8,344,369 `addVariableToEnv`; yo-self 684,970 tryToCall
(so trial COUNTS were always at parity — only the per-call binding work
diverged).

---

## 2. Start here

1. Read **§6 (THE METHOD)** and **§4's measurement rules** below — unchanged
   and still what the round-to-round cost depends on.
2. Build a binary (~2.5 min) and reproduce ONE file's score before changing
   anything:
   ```bash
   bun run build
   ./yo-cli compile yo-self/main.yo --release -o /tmp/s1
   BIN=/tmp/s1 T=tests/iterator_combinators.test.yo TAG=x bash scripts/bootstrap/measure_one.sh
   ```
3. **No open roots remain.** Everything in §3 is SOLVED and kept only as
   postmortem pointers. The campaign goal state — all tests green, stage-2
   self-compile clean, fixpoint holding — was reached 2026-08-03
   (`65ebcdbb2`).

---

## 3. The remaining roots

### 3.1 closure-`F` identity split — SOLVED 2026-08-03

`iter_filter_closure` is GREEN (3 passed, 0 markers) and
`iterator_combinators` runs 16/19 arms for real (was: entire batch hollow).
The six-part fix stack — `__impl_fn` mint with FRESH-cell (not in-place)
per-call identity, the type_key arg-slot resolution hop, Step-9 per-call
substitution into def-era nominal return records, the bare-SomeT closure
return unify, the codegen closure-call routing (`cc_early_hit`), and the
trait-check recursion-guard re-key — is documented in
`issues/fixed/yo-self-closure-f-identity-split.md` with all the hazards
that were HIT and fixed along the way (dyn/"Impl"/nameless wrapper
exclusions, `->`-handler exclusion, multi-closure last-writer-wins).

**Arms 16/17 FIXED** (`17a8192ae`: durable assoc-type registration at tmgi
success + registry-first forall recovery + the PURE-ID trait-check guard
key — never type_key, which is stateful and poisoned the imm family's cfid
registry). **Remaining (one root): arm 18** — the sibling-method forall
NAME leak (`filter`'s `F` binding leaks through a persistent shared env
frame into `fold`'s param resolution) — the SAME env-frame-sharing leak
that blocks async arm-65 layer 4 (§3.4); measured mechanism in
`issues/yo-self-chained-combinator-assoc-binding.md`.
Corpus gained `iter_filter_multi_closure.yo` + `iter_map_closure.yo` (154).

### 3.2 `fn` — SOLVED (deferred def-eval re-run; 24/24 GREEN)

- **Arm 11: FULLY FIXED** (`acc984cb3`): the `${func_id}_comptime` mint
  paired with `mark_fn_unemittable` + ALL `copy_func_*` side tables, plus
  the CTFE runtime-only-unknown REWRAP in the ct route (under validation
  the body is not executed — TS parity — and the leaked runtime marker
  tripped yo-self's `::` gate where TS's `!rhsValue` gate accepts). NOTE:
  the arm is vacuous at TS-PARITY (a wrong comptime_assert constant passes
  BOTH compilers under validation).
- **Arm 14:** patch D (the `_()` reroute widening for expected Func types)
  remains vetoed-unless-paired with the forward-referenced-comptime-fn
  codegen fix (`use of undeclared identifier 'is_odd'`) — see
  `issues/retired/handoff-2026-08-02/08-basic12-async65-VERIFY.md` (its file name
  is swapped with 06 — 08 verifies the fn-arms report).

### 3.3 `basic` arm 12 — SOLVED (33/33 GREEN)

Two stacked roots (`issues/retired/handoff-2026-08-02/07` + `06`, note the name
swap): **A2 (the `_stable_identity_at` Tuple arm) LANDED 2026-08-03** —
its stage-2 control passed post-cycle-guard (emit rc=0, hollow=0, clang
errors == 4 unchanged) and `scripts/bootstrap/t5/A_g4_min.yo` (the tuple
layout-aliasing MISCOMPILE) now compiles and runs. Arm 12 itself still
hollows on the OTHER stacked root: A1 (the `_()` reroute for NAMED expected
structs) remains REFUTED as land-able by its adversarial verifier.

### 3.4 `async_await` arms 65/72 — SOLVED 2026-08-03 (`46f614a30`; 116/116 GREEN)

Five layers total, four FIXED 2026-08-03: the binding layer
(compatibility.yo — Future effect matching by TYPE not label; top-level
carrier gate; `8bbf90deb`), the poisoned-lineage guard
(`_resolve_some_types_deep` never adopts a bare-Fn resolution for a
Future-required wrapper, but continues into nested substitution), and the
generic-fn-type check defer with the ported `all_paths_unwind`
(`809de09ad`). **Layer 4 (the per-call `E := bundle` binding) was REVERTED
after a stage-2 A/B chain (`d3a5264b3`)** — every variant (global
synthesizer, io-arg-scoped synthesis, even a pure `add_variable_to_env` of
`E`) leaks through SHARED callee-env frames into the Io struct's
member-type renders during the stage-2 self-compile and ABORTS emission
("get_type_string: no C type name found for IoExn"). The env-frame-sharing
leak is the SAME root as iterator_combinators arm 18 (§3.1) and is the
single highest-leverage remaining item — both issue files cross-link it
with the fix direction (call-scoped frames or TS-style per-call forall
freshening, helper.ts:1047). The arm-65 mechanism is PROVEN: the
extraction (`tmp/a65/a65.test.yo`) was GREEN with any layer-4 variant in
place. Also note yo-self stays more lenient than TS on `B_io_i64.yo` —
divergence recorded, not a regression.

**RESOLUTION (2026-08-03, `46f614a30`):** the env-frame-sharing layer-4
variant was replaced by the CELL-ONLY variant (e) E-binding (write the
concrete effect into the per-call FRESHENED future forall's resolution
cell inside `_synthesize_future_traits`) — no env write, no opts write, no
stage-2 abort; stage-2 emit markers dropped 13 -> 0. Arm 72 additionally
needed the future-trait param lowering + semantic io-builtin
classification chain — full six-part write-up in
`issues/fixed/yo-self-io-await-shared-wrapper-poisoning.md`.

### 3.5 stage-2 dyn-capture residual — SOLVED 2026-08-03 (`65ebcdbb2`; FIXPOINT RESTORED)

`issues/yo-self-stage2-get-type-string-cycle.md`. TS emits NO
`is_yo_dyn_*` predicate functions for the same input — the whole family is
a yo-self-only divergence around dyn(Fn) capture structs, and its
resolution cycle is what the `get_type_string` guard now demotes. Fixing
this restores the full fixpoint gate AND is probably upstream of §3.1.

### Other recorded divergences (small, non-blocking)

- `issues/yo-self-no-matching-overload-silent-drop.md` — when EVERY overload
  candidate is rejected, TS hard-errors; yo-self drops the statement.
- `issues/fixed/yo-self-ctfe-route-return-type-unresolved.md` — FIXED; kept for
  the soundness-hole postmortem (vacuous comptime_asserts).
- `scripts/bootstrap/t2/C2.yo` and `A_fn_ct.yo` — two open imm/list-adjacent
  standalone failures (TS rc=0), unchanged by the shell fix.

---

---

## 4. How to measure honestly

**Never quote a bare "N passing".** 33 files were once counted green while
running nothing (`issues/retired/yo-self-hollow-test-batch-main.md`).

**Do not `cmp` two stage-1 `.c` files and conclude something changed.** The
TypeScript compiler gensyms loop/continue labels non-deterministically, so two
builds of an UNCHANGED tree differ in thousands of lines that all look like
`loop_v8gaejzpv:` vs `loop_wf8wtq96q:`. Diff with
`sed -E 's/(loop|continue)_[a-z0-9]+/\1_X/g'` before drawing any conclusion. The
stage-2 ≡ stage-3 fixpoint is unaffected — both sides are emitted by yo-self,
which IS deterministic here — which is exactly why the fixpoint is the gate that
detects real output changes and a stage-1 `cmp` is not.

Hollow check — the only definition that counts:

```bash
rm -f <dir>/.yo_selftest_batch_*
YO_KEEP_BATCH=1 /tmp/s1 test <file> --parallel 1
sed -n '/^void __yo_user_main() {/,/^}/p' <dir>/.yo_selftest_batch_1.bin.c \
  | grep -c 'Failed to transpile'
```

| tool                                  | what                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `scripts/bootstrap/hollow_sweep69.sh` | honest score, all 185 files, resumable. **~40 min**                       |
| `scripts/bootstrap/measure_one.sh`    | one file, same rules                                                      |
| `scripts/bootstrap/hollow8.sh`        | the 7 hollows + the RED slot + 3 canaries, ~13 min                        |
| `scripts/bootstrap/subset_arms.py`    | rebuild a `.test.yo` with only chosen arms — the ONLY way to blame an arm |
| `scripts/bootstrap/swallow_sweep.sh`  | recover the SWALLOWED def-time error per file                             |

Rules that each cost real time to learn:

1. **Score `check` by the trailing `N/M file(s) passed` count.** Two grep rules
   have now false-passed: `tail -1` lands on the prelude's "evaluator OK" line,
   and `grep -c 'error in'` reads **zero** on a broken tree because `check`
   prints `— FAILED`, never `error in`. Verified 2026-08-02.
2. **Reproduce an arm with `subset_arms.py`, keeping the `test(...)` wrapper.**
   Extracting an arm into a plain `main` FALSE-PASSES.
3. **Subtract the NOISE BASELINE.** Any file importing `std/string/string`
   (nearly all, via `std/assert`) swallows exactly one
   `Cannot unify incompatible types: "usize" and "u8"`. It caused two wrong
   attributions. Take a green-file baseline and `comm -23` against it.
4. **Move a failing statement to MODULE level to SEE the swallowed error.**
   Module begin exprs are not wrapped in the def-time swallow, so a 3-second
   `check` replaces a probe build. Biggest single speed-up in the loop.
5. **Count FTT markers UNANCHORED.** A failing sub-expression emits its comment
   MID-LINE (`(bool)(// Failed to transpile …)`), which `grep '^\s*// Failed'`
   reports as zero.
6. **A `::` statement emitting `// Failed to transpile` means its node has NO
   ExprInfo** — the enclosing body eval THREW there. Everything after it loses
   its info too, so the FIRST marker names the real failure.
7. **Never run two `yo-cli test` invocations against the same directory
   concurrently.** The `.yo_selftest_batch_*` artifacts live next to the test
   file and clobber each other; this has produced phantom-hollow readings AND a
   false GREEN. A `hollow=NA` anywhere in a gate means the whole run is
   contaminated, not that one file is bad.

**Building a diagnostic binary.** yo-self swallows evaluator errors in four
places; un-silencing them turns "the file is hollow" into a precise error list.
Use DISTINCT tags — one shared tag cannot tell the sites apart.

| site                                                                 | tag       |
| -------------------------------------------------------------------- | --------- |
| `evaluator/exprs/_expr.yo` `_evaluate_expression_wrapper` catch-all  | `__DBG_W` |
| `evaluator/calls/function_type.yo` `_trial_eval_fn_body` `inner_exn` | `__DBG_F` |
| `evaluator/values/anonymous_function.yo` `inner_exn` (two sites)     | `__DBG_A` |
| `evaluator/builtins/comptime_expect_error.yo` `local_exn`            | `__DBG_C` |

Add `open(import("std/fmt"));` to any file you touch EXCEPT
`evaluator/calls/function.yo`, where `eprintln` is already in scope and the
import collides with `ToString`.

---

## 5. Gates

```bash
bun run build                                              # before any yo-cli work
./yo-cli compile yo-self/main.yo --release -o /tmp/s1      # ~2.5 min
S1=/tmp/s1 P=x bash scripts/bootstrap/gates_fast.sh               # TIER 1, ~12 min
BIN=/tmp/s1 TAG=x bash scripts/bootstrap/hollow8.sh               # the 7 + canaries, ~13 min
BIN=/tmp/s1 OUT=/tmp/hs bash scripts/bootstrap/hollow_sweep69.sh  # honest score, ~40 min
```

`gates_fast.sh` now **exits non-zero** if any gate fails (each failure is echoed
with a `FAIL:` prefix, and a `hollow=NA` battery file — no batch `.c` produced, so
hollowness is unknown — counts as a failure too). That makes it directly usable as
a CI step, which is how the new **`bootstrap-self-test`** job in
`.github/workflows/test.yml` runs it: build stage-1 with the TS compiler, then run
the tier-1 gates through the SELF-HOSTED binary. This closes a real hole — CI ran
`./tests` through the TypeScript compiler and `<bin> compile` in the
bootstrap-fixpoint jobs, but nothing ran **`<bin> test`**, so codegen bugs that
only appear when the self-hosted compiler builds AND RUNS a test binary were
ungated (and `check` cannot see them: it never evaluates function bodies). It is
`continue-on-error: true` at first, per the TSan/bootstrap-fixpoint precedent.
The job deliberately uses the DEFAULT (libc) allocator — mimalloc costs +53% wall
and +15% footprint (measured 2026-08-05); the fixpoint jobs keep mimalloc only
because a self-EMIT is memory-bound on a 16 GB box.

`tests/internal` (was `yo-self/tests`) is now **WIRED INTO CI** as the
`compiler-internal-tests` job — the two reasons it was excluded are both gone as of
2026-08-05:

- **Runtime was overstated.** MEASURED over 58 files at `--parallel 1`: **40.5 min**
  under the TS compiler, **22.2 min** under the self-hosted binary (~2x faster),
  **63 min** for a both-compilers differential. The old "~90 min" figure was
  pessimistic.
- **The `eval_*` trio is gone**, retired with its subject `evaluator/eval.yo`, so
  there is no longer any file that has to be skipped.

The binding constraint is MEMORY, not time: `macro_expansion` alone needs **6.52 GB**.
`ubuntu-latest` has **16 GB** (an earlier draft of this section said ~7 GB, which is
the private-repo runner size and is wrong for this repo — the fixpoint jobs' own
comments and their `free -h` output are the evidence), so 6.52 GB fits without swap
at `--parallel 1`. It must still run **one file and one compiler at a time** —
concurrency does not merely risk OOM, it swaps and trips the runner's own 600 s
evaluator deadline, MANUFACTURING failures that do not reproduce in isolation (that
is how four the four macro/reflection files were misdiagnosed as broken). Note the self-hosted runner
ignores `--parallel` regardless (`main.yo`: "Accepted for CLI compatibility; v1 runs
sequentially").

It IS wired as a DIFFERENTIAL — the job runs all 58 files under the TS compiler
first (ground truth), then builds stage-1 and runs the same 58 under the self-hosted
binary, with `if: always()` on the second step so a run always produces both
scorecards even when the first bailed. A TS-only run would add little over `check`;
comparing the two compilers is what caught the `effect_analysis` codegen divergence.
The fast language suite excludes the directory (`--exclude tests/internal`) on the
clang, emcc and wasm-wasi jobs, so it costs those jobs nothing.

The full sweep is **mandatory** before claiming a flip: the GREEN→HOLLOW
regression class is invisible to the 12-file gate (it bit this campaign once —
`closure_capture_rc_leak` regressed silently), and GREEN→RED bit it again on
2026-08-02 (`env` + `string/rune`, from a re-keyed method type whose param
labels no longer matched its body — caught ONLY by the sweep).

The stage-2 gate is currently **emit rc=0 + hollow=0 + clang error count == 4
(unchanged)** — the byte-identical stage3 fixpoint is unreachable until the
pre-existing dyn-capture residual is repaired (§3.5; run the emit with
`YO_MAIN_STACK_MB=4096`, then
`clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 <stage2.c> -o /dev/null`
and count errors).

Never edit `yo-self/*.yo` while a gate is running: stage2/stage3 read the tree
and a mid-run edit invalidates the fixpoint comparison. Building during a sweep
also causes CPU contention and timeout-induced false REDs. To measure a test
file while a gate runs, copy it to a scratch dir and run it there.

`tests/index.test.yo` is NOT in the TIER-1 battery; run it explicitly whenever
you touch address-of / Index-trait / comptime-place code.

---

## 6. THE METHOD (non-negotiable — proven over ~45 fix rounds)

1. **Faithful port first.** Find the TS behaviour (file:line) and port that
   shape. Where yo-self's model genuinely differs (value semantics vs TS object
   identity), document the divergence AND use the equivalent existing mechanism.
   Being broader OR narrower than TS both break the self-compile. Distrust
   yo-self comments claiming a port was impossible — several were false. If a
   faithful port regresses something, the regression is usually a SECOND missing
   port, not a reason to narrow the first.
2. **"It only removes a restriction" is NEVER a safety argument in a compiler.**
   Removing a rejection unmasks whatever the rejection was hiding. This has now
   bitten three times in one session (the deep predicate → `imm_map` abort; the
   ungated re-eval → wrong adopted types; the A/B ungate → all three canaries).
   Gate it like any other change.
3. **Gate every change; revert on ANY regression — and on zero wins.** An inert
   change is churn that hides the next real signal.
4. **No hollow greens.** rc=0 proves nothing, and STRICT_FIXPOINT does NOT catch
   hollowness (a state once passed every gate while emitting 19 markers, because
   stage2 and stage3 drop the same statements). Prove a gate can FAIL before
   trusting it to pass. ASan is useless here (`yo-cli` silently skips
   instrumentation); use `scripts/bootstrap/guardmalloc_corpus.sh`.
5. **The honest sweep cannot detect WRONG ANSWERS** — they are neither hollow
   nor red. One landed fix this campaign was a silent miscompilation
   (`comptime_add(3, 2)` returned 4) found only by running a standalone repro
   under both compilers. The score is an upper bound on correctness.
6. **Probe before fixing; instrument, don't infer.** Most fix attempts that skip
   this are measured dead ends. One temporary `eprintln` naming the actual
   list/type/value has repeatedly replaced hours of reasoning.
7. **One build must answer the whole question.** Pack every plausible probe into
   a single build with distinct tags. Input-side experiments (crafted `.yo`
   files against an existing binary) cycle in seconds — rebuild only when the
   probe must live inside the compiler.
8. **Never filter a trace on a bare identifier name.** The prelude defines `f`,
   `x`, `m`. Filter on a shape unique to the reproducer.
9. **Anchor scripted edits on UNIQUE context.** Assert `count == 1` in the patch
   script — a condition once landed on the wrong same-text `if`.
10. **Long jobs die on this box.** rc=133/137/138/139 with a ZERO-byte log is a
    phantom kill — retry before believing a crash.
11. `./yo-cli compile` cannot take `*.test.yo` — extract a standalone repro with
    `main` + `export(main)`.

---

## 7. HARD-WON INVARIANTS (violate these and you re-live old sessions)

- **Per-call / per-closure type identity is THE recurring theme** (Gap-6). Do not
  weaken `_freshen_io_builtin_callee`, the call-scoped forall rebinds +
  lineage-identity gate (`types/synthesizer.yo`), the clfid spec-cache keying +
  per-spec SomeT rebuild (`calls/helper.yo`), or receiver-instance `Self`
  adoption (`expr_info.yo`).
- **`SomeT.resolved_concrete` is a SHARED-LINEAGE cell** — per-call resolutions
  must rebuild a FRESH SomeT + cell, never write the shared id last-wins.
- **The shell pattern:** any walker of struct fields / enum variants may get a
  recursive-`Self` SHELL (empty lists) — call
  `resolve_enum_shell(resolve_struct_shell(ty))` first. **§3.2 is the sixth site
  to be bitten by this.** When you write a new type walker, do it up front.
- **`substitute()` preserves the struct/enum id** (`types/substitution.yo:301`)
  and is type-argument-aware, but the map BUILDER is not: a forall occurring
  only as an instantiation ARGUMENT is invisible to `get_all_some_types`, which
  walks FIELDS only. That was the last RED (`e40d924f4`).
- **TS never substitutes into a type — it RE-EVALUATES the type EXPRESSION.**
  There is no TypeApp reduction function in TS at all; reduction is a side
  effect of expression re-evaluation through the memoized comptime constructor.
  Substitution can never APPLY a constructor.
- **`Some(UnknownVal)` ≠ a value.** Every ported TS `if (expr.$.value)` gate
  needs an `is_unknown_val` guard.
- **A runtime call result must be RUNTIME-ONLY** (`_call_result_unknown`). TS has
  no value there at all, and the flag is what makes "Cannot assign runtime
  argument to compile-time parameter" fire.
- **Comptime integers are `i64`, not a bignum.** Range/overflow reasoning must
  treat u64/usize as BIT PATTERNS (a value above `i64::MAX` reads as negative).
- **Type-shape dispatch without a `Pointer` arm** silently no-ops for
  pointer-receiver methods.
- **Chars vs bytes:** `String.len()` is CHARS; byte loops use
  `bytes_len()`/`byte_at()`.
- **Retroactive envs:** ExprInfo envs share mutable Frames — "was X bound here"
  must use the emitter's C block-scope stack, not env lookups.
- **`type_to_string` is bounded by a monotonic visited set.** Do not remove it:
  without it one render reached 6.8 GB RSS and hung six test files for 1800 s.
- Yo syntax: `:=` is immutable (reassign needs `(x : T) = …`); no forward refs;
  no nested match patterns; a single-expression `{ }` parses as a struct literal
  (add a `;`); fn defs are `name :: (fn(...) -> T)({ ... })`; adjacent DIFFERENT
  operators need parentheses; **`if(...)`/`cond(...)` cannot be a call argument
  or appear inside a string interpolation** ("Frame level N has different number
  of values for different cases") — hoist into a local first.
- **The type-parameter binder is `generic(T : Type)`, not `forall`.**
  `forall`/`∀` are reserved and rejected at lex time.
- `./yo-cli fmt` every touched `.yo` before committing; lint-staged reformats
  `.md` on commit.
- rc=139 at `-O0` on deep recursion is stack exhaustion — use `--release` or
  `YO_MAIN_STACK_MB=4096`. `-O0` stays banned.

---

## 8. Key locations

| path                                                 | what                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `issues/yo-self-closure-f-identity-split.md`         | **§3.1's whole context** — repro, TS mechanism, measured dead ends, io_async hazards              |
| `issues/yo-self-stage2-get-type-string-cycle.md`     | **§3.5** — the fixpoint blocker: crash controls, the guard, the 4-error residual                  |
| `issues/retired/handoff-2026-08-02/`                 | the ten reports behind the morning's §3 — read each `-VERIFY` before its `-scope`; 06↔08 SWAPPED |
| `issues/retired/yo-self-hollow-root-cause-map.md`    | per-file evidence base + the noise table + every measured dead end                                |
| `issues/yo-self-no-matching-overload-silent-drop.md` | zero-surviving-overload-candidates drops the statement (TS hard-errors)                           |
| `issues/retired/yo-self-stub-inventory.md`           | 311 unported/divergent findings, each with a TS file:line                                         |
| `tests/codegen-bootstrap/`                           | the 152-file differential corpus (add a regression test per fix)                                  |
| `scripts/bootstrap/apply_*.py`                       | landed and reverted patch scripts, each with its evidence in the docstring                        |
| agent auto-memory (outside the repo)                 | `MEMORY.md` indexes distilled lessons — recall before re-deriving                                 |

`tmp/` is a git-ignored scratch dir with stale `*.test.yo` files; a bare
`./yo-cli test` sweeps them up and they all fail. Always pass an explicit path.
