# yo-self bootstrap — handoff

_Rewritten 2026-08-02. Completed work was deleted, not archived: per-round
narratives live in `git log` of this file and in `issues/*.md`. This document is
only (1) where the campaign stands, (2) what to do next, (3) how to measure
honestly, and (4) the rules that must not be re-learned._

**Goal:** make the self-hosted compiler (`yo-self/`) build and run `./tests` as
correctly as the TypeScript compiler (`src/`, the GROUND TRUTH).

---

## 1. Where the campaign stands

**Honest score: 178 GREEN / 7 HOLLOW / 0 RED of 185 test files.**
Full sweep 2026-08-02, results at `/tmp/sw171/results.txt` (regenerate — `/tmp`
is volatile).

**The RED list is empty.** Every remaining failure is HOLLOW: the file exits 0
while running _nothing_, because the generated batch `main` is a single
`// Failed to transpile` comment and the harness scores every test a pass.

| remaining HOLLOW file                         | one-line status                                                   |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `prelude`                                     | **root found, patch verified — start here (§3.1)**                |
| `imm_map`                                     | **root found, patch verified, but does not flip the file (§3.2)** |
| `iter_filter_closure`, `iterator_combinators` | shared root, twice refuted, now well-localized (§3.3)             |
| `fn`                                          | **five** independent arms, not reachable soon (§3.4)              |
| `basic`, `async_await`                        | one arm each, roots identified (§3.5)                             |

Green baselines every change must preserve:

| gate              | baseline                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| honest sweep      | **178 GREEN / 7 HOLLOW / 0 RED**                                                                       |
| corpus diff-test  | **PASS 148 / DIFF 0 / SELF-FAIL 1** (`closure_impl_fn_capture.yo` is a known pre-existing failure)     |
| `check ./std`     | **153/153**                                                                                            |
| `check ./yo-self` | **295/305** (the 10 failures are pre-existing: `evaluator/eval.yo:4461` + 9 cascading circular-import) |
| canaries          | `array` 12, `for_macro_borrow` 13, `closure_capture_rc_leak` 7 — all rc=0, 0 markers                   |
| stage2 → stage3   | FIXPOINT_HOLDS (byte-identical)                                                                        |

`sys/bufio` and `thread` are FLAKY on this machine (intermittent SIGSEGV with a
ZERO-byte log — the phantom-kill signature). Re-run before believing either.

---

## 2. Start here

1. Read **§5 (THE METHOD)** and **§4's measurement rules**. They are what the
   round-to-round cost of this campaign actually depends on.
2. Build a binary (~2.5 min) and reproduce ONE file's score before changing
   anything:
   ```bash
   bun run build
   ./yo-cli compile yo-self/main.yo --release -o /tmp/s1
   BIN=/tmp/s1 T=tests/prelude.test.yo TAG=x bash scratchpad/measure_one.sh
   ```
3. Take **§3.1 (`prelude`)** — it is the only remaining file with a verified,
   ready-to-apply patch.

**Full evidence for everything in §3 is in `issues/handoff-2026-08-02/`** — ten
reports, each a scope investigation paired with an adversarial verification.
Read the `*-VERIFY.md` **before** acting on its `*-scope.md`: four of the five
verifiers materially corrected or refuted their scope report, and one caught a
patch that would have broken all three canaries.

### Recommended order

| #   | work                                                 | expected outcome                                                     | cost                                         |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| 1   | §3.1 `prelude` assigned-value overload guard         | un-hollows arm 1, exposes a second layer (9 undeclared-fn errors)    | patch is written & verified; 1 build + gates |
| 2   | §3.2 `imm_map` shell resolution                      | fixes a real abort + unblocks §3.4 arm 9; does **not** flip the file | 2-line fix, verified, no regression          |
| 3   | §3.4 arm 9 deep-predicate swap, re-measured after #2 | flips one of `fn`'s five arms                                        | 1 build; **must** re-check `imm_map`         |
| 4   | §3.3 the generic-impl-over-comptime-struct root      | would flip TWO files                                                 | unsolved; hardest and highest value          |
| 5   | §3.5 / rest of §3.4                                  | one arm each                                                         | unscoped                                     |

Items 1–3 are mechanical and independently gated. Item 4 is where the real
design work is: it is the only remaining root worth two files, and both prior
theories about it are dead (§3.3).

---

## 3. The seven remaining files

### 3.1 `prelude` — root found, patch verified. DO THIS FIRST.

`issues/handoff-2026-08-02/03-prelude-arm1-scope.md` + `04-…-VERIFY.md`.

**Root: yo-self never ported overload disambiguation by ASSIGNED VALUE.**
`std/prelude.yo:7639-7647` declares

```rust
try_into : (fn(self : Self, (comptime(_To) : Type) = To) -> Result(To, Self.Error))
```

`= To` is an _assigned_ value, not a default (`?=`). Two impls (`TryInto(i32)`,
`TryInto(i64)`) therefore expose `try_into` overloads whose parameter _types_
are byte-identical; the assigned value is the ONLY discriminator. yo-self has no
such guard (`grep -rn "Value mismatch for parameter" yo-self/` → 0 hits) so both
candidates survive and it takes the first-declared.

TS does it at `src/evaluator/calls/helper.ts:481-497`, whose comment names this
exact case (`TryInto(i32) vs TryInto(i64)`). The value IS already computed in
yo-self (`evaluator/types/function.yo:1226-1258`) but is only used to seed the
def-time binding and then discarded; `FuncParam` has no `assigned_value` field.

**Verified by the verifier, independently re-measured:** markers 1 → 0, `b`
changes from `int32_t` to `int64_t` (matching TS); declaration-order swap flips
the answer with zero type-level change (proving it is selection, not typing);
canary emitted C **byte-identical**; all 17 anchors `count == 1`; check has teeth
(two injected errors both gave rc=1 + FAILED).

**Known follow-on:** arm 1 goes `hollow=1 → hollow=0` but then `rc=1` with nine
`call to undeclared function 'fn_yo_id_…'` errors. That is a _second_ layer, not
a regression — un-hollowing exposes it. Budget for it.

### 3.2 `imm_map` — root found and patch verified, but it does NOT flip the file

`issues/handoff-2026-08-02/09-imm-map-entries-scope.md` + `10-…-VERIFY.md`.

**Root: `_collect_some_types_into` (`yo-self/types/utils.yo:911`) walks
`field_types` / `variant_fields` without resolving struct/enum SHELLS.** This
violates an invariant already recorded in §6 of this document. `_type_contains_rc_inner`
in the same file already does `resolve_enum_shell(resolve_struct_shell(ty))` and
calls itself "the fifth shell-consumption site"; this is the sixth.

Repro: `scratchpad/t2/v1_empty.yo` (8 lines, an EMPTY map suffices) → rc=134
`get_enum_variant_c_name: no C type name found for enum`. TS rc=0.

**The verifier split the patch and measured each half** — the lever is the
0-field **struct** shell of `ListNode`:

| half                        | result            |
| --------------------------- | ----------------- |
| `resolve_struct_shell` only | **rc=0, fixed**   |
| `resolve_enum_shell` only   | rc=134, unchanged |

No regression: 10 test files identical both sides, and 7/7 working programs emit
**byte-identical C**. `check ./yo-self` 295/305 unchanged.

**But it does not flip `imm_map`.** The verifier proved this with a teeth-probe:
injecting `assert(false)` into the `entries` arm shows TS = 20 passed / 1 failed,
while yo-self = 21 passed / `✓` both before AND after the patch. That arm is
hollow for a different reason. Land the fix (it is correct and cheap) but do
**not** count it as a flip, and then find the arm's actual hollow root.

**Do not repeat two dead ends:** this is NOT a registration or lookup-keying gap
(an earlier note blaming `context.types[enumType.id]` vs the structural
`type_key` was measured wrong and retracted), and the type-argument fix landed
in `e40d924f4` does not reach it.

### 3.3 `iter_filter_closure` + `iterator_combinators` — shared root, twice refuted

`issues/handoff-2026-08-02/01-iter-filter-scope.md` + `02-…-VERIFY.md`.

**Two roots are dead. Do not re-derive them:**

1. **Trait-bound accumulation / constrained-`F` is NOT the cause.** The dedup
   landed 2026-08-02 works — the emitted C now shows ONE distinct `F` key where
   it showed three — and `scratchpad/w1/repro6.yo` still fails byte-identically.
2. **The `__impl_fn` closure-identity theory is NOT the cause.** yo-self really
   does pass two different `F`s where TS passes one wrapper
   (`src/evaluator/values/anonymous-function.ts:1206-1213`, unported — see the
   note at `anonymous_function.yo:1763`), but replacing the closure with a
   top-level named fn removes the capture struct _and_ the two-struct split
   entirely, and HEAD still fails.

**The actual discriminator: a GENERIC / WHERE-CLAUSE IMPL OVER A
COMPTIME-CONSTRUCTED STRUCT.** Tightest repro (`v5_direct.yo` — no closure, no
generic method, ONE struct id):

```rust
MyWrap :: (fn(comptime(I) : Type) -> comptime(Type))(struct(_inner : I));
impl(generic(I, A), where(I <: Iterator(Item := A)), MyWrap(I), Iterator(...));
w := MyWrap(CountIter)(_inner : iter);
w.next()          // => `// Failed to transpile (w.next)()`
```

Control `v8_mono.yo` writes the same impl monomorphically on `MyWrap(CountIter)`
→ rc=0, 0 markers, binary runs. A second repro `v4_take.yo`
(`iter.take(usize(2)).next()`) hollows with 3 markers and never mints
`IterTake(CountIter)` through the CTFE memo at all.

> **DANGER — measured canary-killer.** Do NOT ungate `helper.yo:2129` /
> `helper.yo:2165` (the "still contains SomeType" gate and the SomeT-free
> acceptance filter). With them removed, **all three canaries go rc=1** with
> `call to undeclared function 'yo_id_3196'` — removing the acceptance filter
> unmasks era-mismatched ids. This is the third time this session that "the
> change only removes a restriction" proved unsafe in a compiler.

### 3.4 `fn` — five independent arms, not reachable soon

`issues/handoff-2026-08-02/05-fn-five-arms-scope.md` + `06-…-VERIFY.md`.

`tests/fn.test.yo` has **five** hollow arms, not one. Roots harvested with an
un-silenced-swallow probe: baseline noise is 34 `__DBG_F` lines and every hollow
arm had exactly 35 — the 35th is the root.

| arm | root                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| 9   | `Cannot unify: Expected "Tuple(0:T,1:Y)" Given "Tuple(0:i32,1:bool)"` (the shallow-vs-deep predicate, see below) |
| 11  | `recur: missing function type in context`                                                                        |
| 12  | `Expected compile error, but the expression was evaluated successfully`                                          |
| 13  | module-`Call` overloading: `add(4, 5, 6, 7)`                                                                     |
| 14  | mutual recursion: `Expected fn(n:i32)->bool, Given <struct:…>`                                                   |

With all five fixes applied, arms 9/12/13 go clean, 11 is still hollow (second
layer) and 14 is hollow=0 but rc=1 at the codegen layer. **So `fn` needs two
more roots beyond these five.** Treat it as a multi-round project, not a fix.

**Arm 9's fix is known but must be PAIRED.** Swapping
`type_contains_some_type` → `type_contains_some_type_deep` at the two arg-type
gate sites in `evaluator/calls/function.yo` fixes it (yo-self's predicate is
TOP-LEVEL ONLY, `types/utils.yo:856`, "Phase 2 partial port"; TS's recurses,
`src/types/utils.ts:477-568`). Measured consequence: it flips `imm_map` from
HOLLOW to **rc=134 abort**, because it unmasks the §3.2 shell bug. Land §3.2
first, then re-measure this.

### 3.5 `basic` arm 12 and `async_await` arm 65

`issues/handoff-2026-08-02/07-basic12-async65-scope.md` + `08-…-VERIFY.md`.

- **`basic` arm 12** — the "`_` reroute" is a CHAIN of gaps, not one blocker;
  four attempts were rejected and three unmasked defects fixed along the way. A
  16-line repro with no `_` anywhere (`scratchpad/w6/g4_min.yo`) shows two
  sibling blocks each declaring a local `S` and `C :: Tuple(S)`, which yo-self
  collapses to ONE tuple type where TS emits two. Confirm whether that IS arm
  12's root before building on it.
- **`async_await` arm 65** — the recorded root ("T/E never bound from the
  closure") is REFUTED. The return type is _supposed_ to stay generic; the throw
  is the assignment's type-compatibility check rejecting two `Impl(...)`
  SomeTypes **that print identically** (`Expected: Impl : (ToString)` /
  `Given: Impl : (ToString)`). Nothing to do with async, closures, or
  `closure_type.yo`. A 10-line non-async repro is at `scratchpad/w4/w1.yo`.

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
`closure_capture_rc_leak` regressed silently).

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

| path                                       | what                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `issues/handoff-2026-08-02/`               | **the ten reports behind §3** — read each `-VERIFY` before its `-scope`    |
| `issues/yo-self-hollow-root-cause-map.md`  | per-file evidence base + the noise table + every measured dead end         |
| `issues/yo-self-hollow-test-batch-main.md` | the hollow-batch defect itself                                             |
| `issues/yo-self-stub-inventory.md`         | 311 unported/divergent findings, each with a TS file:line                  |
| `tests/codegen-bootstrap/`                 | the 149-file differential corpus (add a regression test per fix)           |
| `scratchpad/apply_*.py`                    | landed and reverted patch scripts, each with its evidence in the docstring |
| agent auto-memory (outside the repo)       | `MEMORY.md` indexes distilled lessons — recall before re-deriving          |

`tmp/` is a git-ignored scratch dir with stale `*.test.yo` files; a bare
`./yo-cli test` sweeps them up and they all fail. Always pass an explicit path.
