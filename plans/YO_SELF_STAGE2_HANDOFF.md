# yo-self bootstrap — handoff

_Rewritten 2026-08-02 (end of day, `4047555d8`). Completed work was deleted,
not archived: per-round narratives live in `git log` of this file and in
`issues/*.md`. This document is only (1) where the campaign stands, (2) what
to do next, (3) how to measure honestly, and (4) the rules that must not be
re-learned._

**Goal:** make the self-hosted compiler (`yo-self/`) build and run `./tests`
as correctly as the TypeScript compiler (`src/`, the GROUND TRUTH).

---

## 1. Where the campaign stands

**Honest score: 181 GREEN / 4 HOLLOW / 0 RED of 185 test files** (2026-08-03,
after the closure-F round; hollow: async_await, basic, fn,
iterator_combinators). The 2026-08-02 evening sweep measured 180/4/1.

**Day's flips:** `prelude` HOLLOW→GREEN (4/4, both arms fixed);
`imm_map` HOLLOW→GREEN **with teeth** (injected `assert(false)` in the
entries arm → 20p/1f, matching TS); `iter_filter_closure` HOLLOW→honest RED;
`comptime` arm 0's negative-number block went vacuous→really-asserting.
Eleven fix commits: `a1bd4e355..4047555d8` — each message carries its
measurements.

| remaining file                  | one-line status                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `iter_filter_closure`           | **GREEN 2026-08-03** — closure-`F` identity split SOLVED (§3.1)                                  |
| `iterator_combinators` (HOLLOW) | 16/19 arms real; arms 16–18 = chained-combinator assoc-binding loss (§3.1)                       |
| `fn`                            | arms 9/11L1/12/13 fixed; arm 11 LAYER 2 + arm 14 remain, both need CODEGEN pairs (§3.2)          |
| `basic`                         | arm 12: A2 LANDED 2026-08-03 (g4_min miscompile fixed); A1 reroute stays VETOED (§3.3)           |
| `async_await`                   | arm 65: binding layer FIXED 2026-08-03; next = the shared-wrapper-cell io.await poisoning (§3.4) |

Green baselines every change must preserve:

| gate                    | baseline                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| honest sweep            | **181 GREEN / 4 HOLLOW / 0 RED** as of 2026-08-03 (`iter_filter_closure` flipped GREEN; hollow: async_await, basic, fn, iterator_combinators) |
| corpus diff-test        | **PASS 153 / DIFF 0 / SELF-FAIL 1** (154 total incl. the two new iter closure files; `closure_impl_fn_capture.yo` is the known one)           |
| `check ./std`           | **153/153**                                                                                                                                   |
| `check ./yo-self`       | **295/305** (10 pre-existing: `evaluator/eval.yo` + 9 cascading circular-import)                                                              |
| canaries                | `array` 12, `for_macro_borrow` 13, `closure_capture_rc_leak` 7 — all rc=0, 0 markers                                                          |
| stage2 emit             | rc=0, **hollow=0** (`YO_MAIN_STACK_MB=4096 <bin> compile yo-self/main.yo --release --emit-c --skip-c-compiler`)                               |
| stage2 clang / fixpoint | **BROKEN — 4 PRE-EXISTING dyn-capture cast errors** (see below). Do NOT treat as your regression                                              |

**The fixpoint gate's recorded FIXPOINT_HOLDS was STALE.** Measured with the
`784b72ded` baseline binary on the `784b72ded` tree: stage-2 emit SIGBUS'd
(unbounded `get_type_string` on a SomeT-resolution cycle). The cycle guard
landed in `4047555d8` fixed the crash; clang then surfaces exactly **4**
`operand of type '__yo_tN' where arithmetic or pointer type is required`
errors at `is_yo_dyn_Fn_…` call sites — identical at THREE tree states
(current, `784b72ded`, `10bca26bc`), i.e. long-pre-existing and previously
masked by the crash. Full analysis + fix directions:
`issues/yo-self-stage2-get-type-string-cycle.md`. Until that is repaired,
gate stage-2 on **emit rc=0 + hollow=0 + clang error count == 4 (unchanged)**.

`sys/bufio` and `thread` are FLAKY on this machine (intermittent SIGSEGV with
a ZERO-byte log — the phantom-kill signature). Re-run before believing either.

---

## 2. Start here

1. Read **§6 (THE METHOD)** and **§4's measurement rules** below — unchanged
   and still what the round-to-round cost depends on.
2. Build a binary (~2.5 min) and reproduce ONE file's score before changing
   anything:
   ```bash
   bun run build
   ./yo-cli compile yo-self/main.yo --release -o /tmp/s1
   BIN=/tmp/s1 T=tests/iterator_combinators.test.yo TAG=x bash scratchpad/measure_one.sh
   ```
3. The open roots, in value order: iterator_combinators arms 16-18
   (§3.1 remainder — the chained-combinator assoc-binding loss), the
   io.await shared-wrapper poisoning (§3.4), fn arm 11's CTFE executor gap
   (§3.2), and the stage-2 dyn residual (§3.5 — the fixpoint blocker).

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

**Remaining (one root):** arms 16–18 — 3-deep chained combinators calling a
bare-`I` blanket method (`skip(20).take(15).count()`): repeat full trait
checks of the same nested record lose the `Item := A` binding after the
first success registers state — `issues/yo-self-chained-combinator-assoc-binding.md`
has the measured mechanism and the suggested fix direction.
Corpus gained `iter_filter_multi_closure.yo` + `iter_map_closure.yo` (154).

### 3.2 `fn` — ONE arm left (arm 14)

- **Arm 11 layer 2:** the `${func_id}_comptime` FuncVal mint LANDED
  2026-08-03, paired with `mark_fn_unemittable` (the codegen pair the
  2026-08-02 attempt lacked — comptime calls fold at CTFE so no C call
  site can exist; suppressing emission removes the undeclared-identifier
  regression). Arm 11 still hollows on its NEXT layer: the CALL
  `result :: comptime_factorial(12)` reports "Expected compile-time value
  … Got runtime value" — the CTFE-execution route doesn't execute the
  minted comptime version's body (probe-verified 2026-08-03; the mint +
  registered comptime type are in place, the executor is the gap).
- **Arm 14:** patch D (the `_()` reroute widening for expected Func types)
  remains vetoed-unless-paired with the forward-referenced-comptime-fn
  codegen fix (`use of undeclared identifier 'is_odd'`) — see
  `issues/handoff-2026-08-02/08-basic12-async65-VERIFY.md` (its file name
  is swapped with 06 — 08 verifies the fn-arms report).

### 3.3 `basic` arm 12

Two stacked roots (`issues/handoff-2026-08-02/07` + `06`, note the name
swap): **A2 (the `_stable_identity_at` Tuple arm) LANDED 2026-08-03** —
its stage-2 control passed post-cycle-guard (emit rc=0, hollow=0, clang
errors == 4 unchanged) and `scratchpad/t5/A_g4_min.yo` (the tuple
layout-aliasing MISCOMPILE) now compiles and runs. Arm 12 itself still
hollows on the OTHER stacked root: A1 (the `_()` reroute for NAMED expected
structs) remains REFUTED as land-able by its adversarial verifier.

### 3.4 `async_await` arm 65

The evaluator layer was fixed in `e8517dd43`; TWO MORE layers were fixed
2026-08-03 in types/compatibility.yo (Future effect matching by TYPE not
label; `_wrapper_carrier_args_concrete` gates on top-level SomeT-ness after
cell resolution) — the `(task : Impl(Future(i32, Ctx)))` BINDING now passes.
The arm still hollows on the layer after that: `io.await(task, ctx)`'s
`fut` param resolves to the CLOSURE's Fn type through a poisoned shared
wrapper cell — fully diagnosed with fix directions in
`issues/yo-self-io-await-shared-wrapper-poisoning.md` (the previously
recorded "io.await dropped at codegen" was this eval throw, swallowed).
Also note yo-self stays more lenient than TS on `B_io_i64.yo` (TS rejects
the mismatched annotation; yo-self accepts) — divergence recorded, not a
regression.

### 3.5 stage-2 dyn-capture residual (the fixpoint blocker)

`issues/yo-self-stage2-get-type-string-cycle.md`. TS emits NO
`is_yo_dyn_*` predicate functions for the same input — the whole family is
a yo-self-only divergence around dyn(Fn) capture structs, and its
resolution cycle is what the `get_type_string` guard now demotes. Fixing
this restores the full fixpoint gate AND is probably upstream of §3.1.

### Other recorded divergences (small, non-blocking)

- `issues/yo-self-no-matching-overload-silent-drop.md` — when EVERY overload
  candidate is rejected, TS hard-errors; yo-self drops the statement.
- `issues/yo-self-ctfe-route-return-type-unresolved.md` — FIXED; kept for
  the soundness-hole postmortem (vacuous comptime_asserts).
- `scratchpad/t2/C2.yo` and `A_fn_ct.yo` — two open imm/list-adjacent
  standalone failures (TS rc=0), unchanged by the shell fix.

---

---

## 4. How to measure honestly

**Never quote a bare "N passing".** 33 files were once counted green while
running nothing (`issues/yo-self-hollow-test-batch-main.md`).

Hollow check — the only definition that counts:

```bash
rm -f <dir>/.yo_selftest_batch_*
YO_KEEP_BATCH=1 /tmp/s1 test <file> --parallel 1
sed -n '/^void __yo_user_main() {/,/^}/p' <dir>/.yo_selftest_batch_1.bin.c \
  | grep -c 'Failed to transpile'
```

| tool                           | what                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `scratchpad/hollow_sweep69.sh` | honest score, all 185 files, resumable. **~40 min**                       |
| `scratchpad/measure_one.sh`    | one file, same rules                                                      |
| `scratchpad/hollow8.sh`        | the 7 hollows + the RED slot + 3 canaries, ~13 min                        |
| `scratchpad/subset_arms.py`    | rebuild a `.test.yo` with only chosen arms — the ONLY way to blame an arm |
| `scratchpad/swallow_sweep.sh`  | recover the SWALLOWED def-time error per file                             |

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
S1=/tmp/s1 P=x bash scratchpad/gates_fast.sh               # TIER 1, ~12 min
BIN=/tmp/s1 TAG=x bash scratchpad/hollow8.sh               # the 7 + canaries, ~13 min
BIN=/tmp/s1 OUT=/tmp/hs bash scratchpad/hollow_sweep69.sh  # honest score, ~40 min
```

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
   instrumentation); use `scratchpad/guardmalloc_corpus.sh`.
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
| `issues/handoff-2026-08-02/`                         | the ten reports behind the morning's §3 — read each `-VERIFY` before its `-scope`; 06↔08 SWAPPED |
| `issues/yo-self-hollow-root-cause-map.md`            | per-file evidence base + the noise table + every measured dead end                                |
| `issues/yo-self-no-matching-overload-silent-drop.md` | zero-surviving-overload-candidates drops the statement (TS hard-errors)                           |
| `issues/yo-self-stub-inventory.md`                   | 311 unported/divergent findings, each with a TS file:line                                         |
| `tests/codegen-bootstrap/`                           | the 152-file differential corpus (add a regression test per fix)                                  |
| `scratchpad/apply_*.py`                              | landed and reverted patch scripts, each with its evidence in the docstring                        |
| agent auto-memory (outside the repo)                 | `MEMORY.md` indexes distilled lessons — recall before re-deriving                                 |

`tmp/` is a git-ignored scratch dir with stale `*.test.yo` files; a bare
`./yo-cli test` sweeps them up and they all fail. Always pass an explicit path.
