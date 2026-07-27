# yo-self bootstrap — handoff

_Rewritten 2026-07-26 for handover; updated 2026-07-27 after the validation
batch. Historical detail lives in `git log` of this file and in `issues/*.md`;
nothing below needs re-litigating._

## Where things stand

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61.**
- **#69 (`s2 test ./tests`): 138 GREEN / 28 HOLLOW / 17 RED of 183.**
  Measured 2026-07-27 late (`/tmp/hs_pa`, s1 = `/tmp/pa_s1` from
  `59c5fe1fa`) with walker + bufio phantom-kill flakes corrected by retry
  (raw sweep said 136/28/19; both re-ran clean). vs the morning sweep
  (135/29/19, `/tmp/hs_final`): **`imm_list`** (16), **`imm_vec`** (47)
  flipped hollow → GREEN (the value-generic chain), **`sync/once`** (11)
  flipped RED → GREEN (red cluster 3 — the closure-convention work), and
  `impl` moved RED → rc=0 partial-hollow (the emission degrades). fn's
  markers went 1 → 6 (same hollow verdict — MORE statements now emit, the
  remaining dead ones are individually marked). Earlier that day:
  `module_struct_unification` (10/10) and `atomic_object` (21/21) flipped
  hollow → GREEN.
- **Batch 5 (specialization-mint emission chain, helper.yo) is TIER 2 green
  incl. FIXPOINT** (2026-07-27, `/tmp/t2_b12.log`; the gate-1 walker rc=139
  was a zero-byte-log phantom kill). It resolved the canonical closure repro
  but flipped no battery file by itself — re-sweep after the value-generic
  chain lands.
- **Value-generic chain landed (`6e9866bcb`) — full TIER 2 green incl.
  FIXPOINT** (`/tmp/t2_vg.log`: stage2 hollow=6, stage3 rc=0,
  FIXPOINT_HOLDS) — `generic(N : usize)` misbind fixed (see §3's "NEXT
  LAYER CRACKED"); **imm_list flipped genuinely GREEN in the battery
  (hollow flags 7 → 6)**; expected to flip imm_vec in the next sweep and
  to feed the imm_set/imm_sorted_set REDs.
- **fn-batch chain landed (`59c5fe1fa`, TIER 2 in flight `/tmp/t2_pa.log`;
  TIER 1 green incl. corpus 141/0 + std 153/153 + battery at the new
  6-flag baseline)**: labeled-argument
  peel + VALIDATION on both call routes (TS helper.ts:271-302), HKT partial
  application (`Result(_, i32)` — TS function.ts:580-766), sequential
  default-param env + `undefined`-arg defaults (TS helper.ts:323-344), and
  four degraded-emission guards that keep batch C valid when eval throws
  leave half-registered definitions (tail/return FTT, Dyn wrapper
  resolved-inner gate, skipped-callee call FTT, `_binop` empty-operand
  FTT). Full mechanism + fn/closure per-block killer maps in
  `issues/yo-self-hollow-test-batch-main.md`. bufio flake has a THIRD mode:
  a one-time nondeterministic `duplicate case value` in a state-dispose
  switch (passes on retry).

**Do not quote a bare "N passing" number.** 33 files used to be counted green
while running NOTHING: yo-self emitted the test batch's whole `main` as a
`// Failed to transpile …` comment, so the binary exited 0 and the harness
scored every test a pass. Proven with a deliberate `assert(false)` probe (TS:
"33 passed / 1 failed"; yo-self: "34 passed"). Details + reproducer:
`issues/yo-self-hollow-test-batch-main.md`.

Score honestly with **`scratchpad/hollow_sweep69.sh`** (resumable, 183 files,
~90 min): a file is GREEN only if it exits 0 **and** its batch `main` is not a
comment. Anything else is HOLLOW or RED.

`sys/bufio` and `thread` are FLAKY on this machine — they SIGSEGV
intermittently with a ZERO-byte log (the phantom-kill signature). Re-run before
believing either result; measured 5/6 and 5/5 clean across repeats.

## What to work on, in order

### 1. The hollow cluster (32 files) — biggest and best-mapped

The 32, as of the 2026-07-26 sweep:

```
algebraic_effects  array  asm  async_await  atomic_object  basic  closure
collections/linked_list  comptime  comptime_option_result  env  fn
for_macro_borrow  gadts  higher_kinded_types  imm_list  imm_vec  impl  index
inherent_first_resolution  iter_filter_closure  iterator_combinators
module_struct_unification  option_result_combinators  prelude
spec/contracts_phase0  spec/pragma_no_contracts  spec/pragma_verify
string/string  sys/file  type_reflection  where_clause_fn_inference
```

They hide roughly 950 reported assertions (`string/string` alone claims 251,
`async_await` 116, `algebraic_effects` 72, `collections/linked_list` 69).

Because the generated batch `main` is ONE `match` statement holding every test,
a single evaluation failure anywhere in the file loses that statement's
`ExprInfo` and codegen replaces the whole dispatch with a comment. Fixing one
evaluator failure can flip an entire file; a file stays hollow until its LAST
failure is fixed.

Every one of the 32 has at least one cause captured — this table is a complete
work-list (from a diagnostic s1 printing every swallowed error; 16 messages
common to all 32 are prelude noise and are excluded):

| files | cause                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| **8** | `Incompatible types:` — the closure-forall family (see §3)                                                               |
| **6** | `Expected compile error, but the expression was evaluated successfully:`                                                 |
| **3** | `Expected a label for function parameter, got requires(...)` — contracts                                                 |
| 2     | `Expected enum type or primitive type for match expression, got unit`                                                    |
| 2     | `Cannot unify incompatible types: "usize" and "Type"`                                                                    |
| 2     | `Failed to evaluate right-hand side of assignment: (reversed._head)`                                                     |
| 2     | `Type mismatch for type member "_f":`                                                                                    |
| 1 ea. | 17 singles (asm unimplemented, `_` array length, `for(inout(x))`, `unwind` outside fn, `Variable "printf" not found`, …) |

The `comptime_expect_error` group is the cheapest: each is a missing
VALIDATION (yo-self ACCEPTS what TS rejects) in an otherwise-green file.
`ccd2dc498` (`operator_grouping`) proved the method; the 2026-07-27 batch
`a71032468` worked the six. **Per-file state after the batch:**

| file                        | state                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module_struct_unification` | **FLIPPED GREEN** (10/10) — `module(...)`/`Module` removed from yo-self (the TS Module→Struct unification's missing half)                                                                                                                                                                                                                                                                                 |
| `atomic_object`             | **FLIPPED GREEN** (21/21) — atomic-Send enforcement ported (guarded to CONCRETE fields; see the divergence note in `enforce_atomic_object_send`)                                                                                                                                                                                                                                                          |
| `impl`                      | hollow → RED → rc=0 partial-hollow (6/26). Both targets THROW correctly (Impl-divergent-return check in begin.yo + `v.pick("s")` via the arg-type-check); the C build is restored by the degraded `return (void*)0;` for unresolved-Impl returns (codegen/exprs/return.yo). The batch main still drops a region — same silent-abandonment class as §3                                                     |
| `basic`                     | still hollow. `x = 12` outside a FN BODY now errors (assignment.yo); the WHILE twin is unportable (frame-level off-by-one, measured). NEXT failing cee: `x := 13` after `(x:i32)=12` — needs TS's `addVariableToEnv` no-shadowing/duplicate rules, a wide-blast-radius port                                                                                                                               |
| `inherent_first_resolution` | still hollow. `f.m(true)` errors on HEAD; `s.starts_with(i32(5))` needs call-site where-clause validation WIDENED past marker traits, which first needs `type_implements_trait` fixed for concrete method-trait satisfaction (measured false negatives: `String <: Hash` ×14, `String <: Eq` ×12 over `check ./std` — widening today rejects valid std code)                                              |
| `prelude`                   | still hollow. `impl(AnotherBox, Dispose(...))` now REJECTED (self-constraint hook); `assume_init()`-twice is BLOCKED on TS-parity env cloning for the call checking phase (`cloneEnvForCTFECheck`) — a consumed-state gate at the TS-mirror site (helper.ts:402) false-positives on yo-self's shared-env double evaluation (measured: hollows imm_string). Reverted; do not re-land without the env clone |

**New known defect from the impl flip:** when a cee'd fn DEFINITION throws
mid-body (e.g. at the second divergent `return`), yo-self's mutable
registrations keep the half-evaluated fn and codegen emits a PARTIAL body —
statements before the throw as real C (with the unresolved `Impl` return
lowered to `void*`, so `return <int32_t temp>;` breaks clang), statements
after as `// Failed to transpile`. TS discards the whole definition. Cheapest
fix candidate: fn-body emitters treat a body containing ANY missing-ExprInfo
statement as fully failed (whole-body comment), which is what already happens
when the FIRST statement throws. Gate on corpus + battery + stage2 markers.

Method that works: run the file under a DIAGNOSTIC s1 (below), find the
`Expected compile error …` site, put the offending expression in
`src/tests/fixme.yo`, and compare `./yo-cli compile` (TS) against the yo-self
binary. TS rc=1 vs yo-self rc=0 localises the missing check in minutes.

#### Building a diagnostic s1 (the highest-value tool in this campaign)

yo-self swallows evaluator errors in three places and emits
`// Failed to transpile` instead. Un-silencing them turns "the file is hollow"
into a precise error list. ~4 minutes end to end:

```bash
cp -R yo-self /tmp/ydiag && rm -rf /tmp/ydiag/tests /tmp/ydiag/yo-self-bin.c
```

Then add an `eprintln` before each of these three `unwind`s and rebuild with
`./yo-cli compile /tmp/ydiag/main.yo --release -o /tmp/diag_s1`:

| file (under `/tmp/ydiag/`)               | handler                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `evaluator/exprs/_expr.yo:1018`          | `_evaluate_expression_wrapper`'s catch-all swallow |
| `evaluator/calls/function_type.yo:222`   | `_trial_eval_fn_body`'s def-time trial swallow     |
| `evaluator/values/anonymous_function.yo` | `_trial_eval_anon_body`'s equivalent               |

e.g. `(_err) -> { eprintln(\`\_\_DBG \${\_err.to_string()}\`); unwind(()) }`. Add
`open(import("std/fmt"));`to any file you touch — EXCEPT`yo-self/evaluator/calls/function.yo`, where `eprintln`is already in scope and
the import collides with`ToString`.

Then `/tmp/diag_s1 test <file> --parallel 1 2>&1 | grep __DBG | sort -u`.
Messages that appear for EVERY file are prelude-evaluation noise — ignore them;
the discriminating ones are the work-list. Use DISTINCT tags per site (the
2026-07-26 recipe used one `__DBG` for all three and could not tell them
apart), and know there is a FOURTH, silent swallow the recipe misses:
`_comptime_expect_error_arg_threw`'s `local_exn`
(`evaluator/builtins/comptime_expect_error.yo`).

### 2. The soundness fix — LANDED

The arg-type-check fix (a call's arguments were never validated against the
declared parameter types on the `_evaluate_funcval_runtime_call` path) landed
in `a71032468` with the full validation batch; TIER 2 green, FIXPOINT HOLDS.
History and the load-bearing function-type guard:
`issues/yo-self-arg-type-check-bypassed.md`.

### 3. The closure-forall family (8 hollow files)

Reproducer: `issues/repros/closure-arg-abandons-enclosing-begin.yo`. A closure
passed as a call ARGUMENT leaves the callee's forall `U` unbound → the callee's
def-time trial body eval hits `List(U)` → `(result : List(U)) = List(U).new()`
throws.

**MECHANISM CAPTURED + FIRST HALF LANDED 2026-07-27** (full detail in
`issues/yo-self-hollow-test-batch-main.md`): the throw travels the
SPECIALIZATION path (`create_specialized_function_inline` →
`try_to_call_function_with_arguments`), which installs NO swallow, unwinds
the CALLER's begin loop (the hollow blast radius), and is contained by the
ENCLOSING fn's own def-time trial — whose handler is what a diag build
prints (the source of every earlier misattribution).

**LANDED (TIER 2 + FIXPOINT green):** the closure-body-type Step-6 binding —
`register_closure_body_type` (function_value.yo, fed by
values/anonymous_function.yo's concrete-body refine block, COMPTIME body
types excluded) + the given-return substitution before Step-6 synthesize in
check_and_add_argument (helper.yo). The canonical repro's markers went
**2 → 0** (statements emitted for real, first time) and the blast radius is
gone; battery/corpus/std all at baseline.

**EMISSION HALF LANDED (batch 5, TIER 2 + FIXPOINT green 2026-07-27):** the
specialization-mint chain in helper.yo (307 insertions) — subst-by-occurrence
for `spec_ret_ty` and `spec_result` (SomeT occurrences collected from return
AND all params, `subst_new`/`subst_add`/`substitute`), capture-struct closure
param typing (`get_closure_capture_info`), the `cap_ty_fixed` rebind
fallback, and the zb-loop mint-env forall binding. The canonical closure
repro COMPILES AND RUNS. Two pieces measured harmful and dropped (see the
issues file): the register-all-specializations collection helper
(cycle_collector RC regression) and the wrapper-resolution stamp even
TS-conditioned (fs/file + fs/temp went hollow).
`issues/patches/spec-emission-second-half-wip.patch` is superseded — only
its two REJECTED pieces remain of interest as documentation.

**NEXT LAYER CRACKED (value-generic misbind, TIER 1 in flight 2026-07-27):**
per-arm isolation showed every imm_list closure/generic arm now emits clean;
the single batch-killer is `from_array` (`generic(N : usize)` + `Array(T,
N)`) — three writers stamped `N := TypeVal(...)` (kind Type) so
`with_capacity(N)` throws unify(usize, Type) on the unswallowed spec path.
Fix chain (function.yo + helper.yo, full mechanism in
`issues/yo-self-hollow-test-batch-main.md`): structural-fallback `.IntLit`
propagation into fresh_env (the faithful port of TS calleeEnv carrying
`N = <len> : usize` from synthesizer.ts:900-937), actual env VALUES in
spec_forall_args (TS keys specs on compileTimeArgValues), and Type-kind
guards on the two positional rebinds (receiver fallback + mint zb-loop; TS
never rebinds foralls). r_fromarray/r_fromlist markers 2 → 0, run clean.
Expected blast radius: imm_list + imm_vec hollow flips; feeds imm_set /
imm_sorted_set REDs. The cheap emitted-C sed-instrumentation trick
(setters/checks/containments/returns as ONE fprintf stream; never mix
eprintln/fprintf probe channels; stdout is block-buffered under `&>`) is the
tool that cracked all of this.

**Four measured dead ends — do not repeat** (all in
`issues/yo-self-hollow-test-batch-main.md`):

1. `synthesizeTypes` on the closure return in `yo-self/evaluator/calls/closure_type.yo` (TS
   closure-type.ts:186-196) — zero effect; that path is never taken for a
   closure passed as an argument (it is `yo-self/evaluator/values/anonymous_function.yo`).
2. Stamping the SomeType return from the body type (TS
   anonymous-function.ts:963-988) — it FIRES (`ret=U rid=1975 body=i32`) and
   Step 6 sees the resolution, yet the repro is unchanged.
3. Widening the expected-type clear at `yo-self/evaluator/values/anonymous_function.yo:1243` — needed to
   make (2) fire at all, not sufficient.
4. Narrowing the unknown-arg CTFE gate (`yo-self/evaluator/calls/comptime_fn.yo:565-585`; TS has no such
   gate) — clears the repro but regresses `imm_list` to SIGSEGV and clears no
   hollow file.

### 4. The 19 REDs

Independent, cluster-mapped, no shared blocker:
`issues/yo-self-69-red-list-map.md`.

## Gates — tiered (adopted 2026-07-26)

A landing costs ~75 min of gates while diagnosis costs minutes, so batch ports
and gate the batch:

- **TIER 1 — `scratchpad/gates_fast.sh` (~12 min)**: repros, the 20-file
  battery WITH per-file hollow detection, corpus diff-test, `check ./std`. Run
  on every change while assembling a batch.
- **TIER 2 — `scratchpad/gates_perf1.sh` (~75 min)**: adds stage2, clang,
  stage3, STRICT_FIXPOINT. Run ONCE per batch, immediately before pushing.
- Bisect a TIER-2 failure with 2-minute s1 builds. Do not go back to
  one-gate-per-commit.

Green baselines: corpus **PASS 141 / DIFF 0** (140 before
`while_or_shortcircuit_owned_temp.yo` was added 2026-07-27), `check ./std`
**153/153**, battery at its counts AND its hollow flags
(`module_struct_unification` and `atomic_object` are now hollow=0 GREEN;
`imm_string` 28/hollow=0), stage2 hollow markers **6**, **FIXPOINT HOLDS**.

```bash
bun run build                                             # before any yo-cli work
./yo-cli compile yo-self/main.yo --release -o /tmp/s1     # s1 — ~2 MINUTES, not 10
S1=/tmp/s1 P=x bash scratchpad/gates_fast.sh              # TIER 1
S1=/tmp/s1 P=x bash scratchpad/gates_perf1.sh             # TIER 2
BIN=/tmp/s1 OUT=/tmp/hs scratchpad/hollow_sweep69.sh      # honest 183-file score
```

Iterate in a scratch copy so a running gate never reads a half-edited tree:
`cp -R yo-self /tmp/yb && ./yo-cli compile /tmp/yb/main.yo --release -o /tmp/yb_s1`.
Add `open(import("std/fmt"));` to any file you put an `eprintln` in — except
`yo-self/evaluator/calls/function.yo`, where `eprintln` is already in scope and the
import collides with `ToString`.

## THE METHOD (non-negotiable — proven over ~35 fix rounds)

1. **Faithful port first.** Find the TS behaviour (file:line) and port that
   shape. Where yo-self's model genuinely differs (value semantics vs TS object
   identity), document the divergence AND use the equivalent existing
   mechanism. Being broader OR narrower than TS both break the self-compile.
   Distrust yo-self comments claiming a port was impossible — several were
   false.
2. **Gate every change; revert on ANY regression.** Tiers above.
3. **No hollow greens.** rc=0 proves nothing. Compare
   `grep -c "Failed to transpile\|Unknown type:"` against the TS emit, and for
   test files check the batch `main` specifically. **STRICT_FIXPOINT does NOT
   catch hollowness** — a state once passed every gate including the fixpoint
   while emitting 19 markers, because stage2 and stage3 drop the same
   statements. ASan is also useless here (`yo-cli` silently skips
   instrumentation); use `scratchpad/guardmalloc_corpus.sh`. Prove a gate can
   FAIL before trusting it to pass.
4. **Probe before fixing.** Measure, don't infer. Five of six fix attempts in
   the 2026-07-26 session were measured dead ends; each cost minutes to
   disprove and would have cost hours to debug after landing.
5. **Never filter a trace on a bare identifier name.** The prelude defines `f`,
   `x`, `m`; filtering on `callee == "f"` produced two wrong conclusions in one
   session. Filter on a shape unique to the reproducer.
6. **Long jobs die on this box.** rc=133/137/138/139 with a ZERO-byte log is a
   phantom kill — retry before believing a crash. Never run two `test`
   invocations over `./tests` concurrently; never edit `yo-self/*.yo` while a
   build reads the tree; never swap a binary a sweep is running.
7. `./yo-cli compile` cannot take `*.test.yo` — extract a standalone repro with
   `main` + `export(main)`.

## HARD-WON INVARIANTS (violate these and you re-live old sessions)

- **Per-call / per-closure type identity is THE recurring theme** (Gap-6). Do
  not weaken `_freshen_io_builtin_callee`, the call-scoped forall rebinds +
  lineage-identity gate (`yo-self/evaluator/types/synthesizer.yo`), the clfid spec-cache keying +
  per-spec SomeT rebuild (`yo-self/evaluator/calls/helper.yo`), or receiver-instance Self
  adoption (`yo-self/expr_info.yo`).
- **`SomeT.resolved_concrete` is a SHARED-LINEAGE cell** — per-call resolutions
  must rebuild a FRESH SomeT + cell, never write the shared id last-wins.
- **The shell pattern:** any walker of struct fields / enum variants may get a
  recursive-`Self` SHELL (empty lists) — call
  `resolve_enum_shell(resolve_struct_shell(ty))` first.
- **`Some(UnknownVal)` ≠ a value.** Every ported TS `if (expr.$.value)` gate
  needs an `is_unknown_val` guard.
- **Type-shape dispatch without a `Pointer` arm** silently no-ops for
  pointer-receiver methods.
- **Chars vs bytes:** `String.len()` is CHARS; byte loops use
  `bytes_len()`/`byte_at()`.
- **Retroactive envs:** ExprInfo envs share mutable Frames — "was X bound here"
  must use the emitter's C block-scope stack, not env lookups.
- **`type_to_string` is bounded by a monotonic visited set** (2026-07-26). Do
  not remove it: without it one render reached 6.8 GB RSS and hung six test
  files for 1800 s each.
- Yo syntax: `:=` is immutable (reassign needs `(x : T) = …`); no forward refs;
  no nested match patterns; a single-expression `{ }` parses as a struct
  literal; fn defs are `name :: (fn(...) -> T)({ ... })`.
- **The type-parameter binder is `generic(T : Type)`, not `forall`** — renamed
  2026-07-26 (`plans/FORALL_TO_GENERIC.md`). `forall`/`∀` are reserved and
  rejected at lex time. Do not "fix" `generic` back. Internal identifiers
  (`forall_labels`, `forall_types`, `forallParameters`) deliberately keep the
  old name.
- `./yo-cli fmt` every touched `.yo` before committing; lint-staged reformats
  `.md` on commit.
- rc=139 at -O0 on deep recursion is stack exhaustion — use `--release` or
  `YO_MAIN_STACK_MB=4096`.

## Key locations

| path                                                    | what                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `issues/yo-self-hollow-test-batch-main.md`              | the hollow-batch defect, causes, 4 dead ends                                              |
| `issues/yo-self-arg-type-check-bypassed.md`             | the parked soundness fix                                                                  |
| `issues/yo-self-69-red-list-map.md`                     | the 19 REDs, cluster-mapped                                                               |
| `issues/yo-self-stub-inventory.md`                      | 311 unported/divergent findings, each with TS file:line                                   |
| `issues/patches/arg-type-check-fix.patch`               | TIER-1-clean fix awaiting TIER 2                                                          |
| `scratchpad/hollow_sweep69.sh`                          | honest 183-file scorer                                                                    |
| `scratchpad/gates_fast.sh`, `scratchpad/gates_perf1.sh` | TIER 1 / TIER 2                                                                           |
| `tests/codegen-bootstrap/`                              | the 140-file differential corpus                                                          |
| agent auto-memory (outside the repo)                    | `MEMORY.md` in the agent memory dir indexes distilled lessons — recall before re-deriving |

Note `tmp/` is a git-ignored scratch dir holding ~78 stale `*.test.yo` files; a
bare `./yo-cli test` sweeps them up and they all fail. Ignore them, or pass an
explicit path.

## Open side issues (not #69 blockers)

- `issues/ts-early-return-nested-block-rc-drop.md` — TS frees an RC container
  early-returned from a nested if-block.
- `issues/ts-constructor-result-drop-o0-crash.md` — TS-side -O0 crash.
- Broad anon-struct expected-type rule blocked by a stage-2 miscompile; the
  narrow rule is committed and green.
- `issues/ts-while-loop-body-drops-missing-guards.md` — FIXED both sides
  2026-07-27 (TS while.ts + yo-self while_loop.yo, corpus test
  `while_or_shortcircuit_owned_temp.yo`).
- Intermittent rc=139 AFTER a correctly-printed impl-path error (2× then 6×
  clean on `repro_dispose_nonrc`) — logs have content, so NOT the zero-byte
  phantom signature. Watch item.
