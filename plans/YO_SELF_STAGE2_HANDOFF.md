# yo-self bootstrap — handoff

_Rewritten 2026-07-26 for handover. Historical detail lives in `git log` of
this file and in `issues/*.md`; nothing below needs re-litigating._

## Where things stand

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61.**
- **#69 (`s2 test ./tests`): 132 GREEN / 32 HOLLOW / 19 RED of 183.**

**Do not quote a bare "N passing" number.** 33 files used to be counted green
while running NOTHING: yo-self emitted the test batch's whole `main` as a
`// Failed to transpile …` comment, so the binary exited 0 and the harness
scored every test a pass. Proven with a deliberate `assert(false)` probe (TS:
"33 passed / 1 failed"; yo-self: "34 passed"). Details + reproducer:
`issues/yo-self-hollow-test-batch-main.md`.

Score honestly with **`scratchpad/hollow_sweep69.sh`** (resumable, 183 files,
~45 min): a file is GREEN only if it exits 0 **and** its batch `main` is not a
comment. Anything else is HOLLOW or RED.

## What to work on, in order

### 1. The hollow cluster (32 files) — biggest and best-mapped

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
**One is already done and proves the method** — `ccd2dc498` made an infix
operator with no impl on a primitive receiver an error (`bool < 3`), flipping
`operator_grouping` hollow → GREEN. The remaining six and what each needs:

| file                        | expectation yo-self wrongly accepts                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `inherent_first_resolution` | `f.m(true)` must not fall through from inherent `m(i32)` to trait `m(bool)`; `s.starts_with(i32(5))` must fail the `P : Pattern` bound |
| `atomic_object`             | `atomic(ref(struct(inner : NonSend)))` must be rejected                                                                                |
| `basic`                     | `x = 12` on a variable defined outside the fn body / while loop                                                                        |
| `impl`                      | fn returning `Impl(Id)` from divergent `cond`/`match` arms; `v.pick("s")`                                                              |
| `module_struct_unification` | bare `module(x : i32)` and bare `Module` as expressions                                                                                |
| `prelude`                   | conflicting `impl` on `AnotherBox`; `uninit.assume_init()` before init                                                                 |

Method that works: run the file under a diagnostic s1 (prints every swallowed
error), find the `Expected compile error …` site, put the offending expression
in `src/tests/fixme.yo`, and compare `./yo-cli compile` (TS) against the
yo-self binary. TS rc=1 vs yo-self rc=0 localises the missing check in minutes.

### 2. The parked soundness fix — arguments are not type-checked

`f :: (fn(x : i32) -> i32)(x); f(true)` — TS rejects, **yo-self accepts and
emits `yo_id_NNNN((int32_t)(true))`**. Located precisely:
`_evaluate_funcval_runtime_call` (`evaluator/calls/function.yo:1347-1674`), the
runtime-return branch of the FuncVal arm taken for most ordinary calls, calls
NEITHER `try_to_call_function_with_arguments` NOR
`check_if_function_parameter_matches_argument` across its 327 lines.

A fix exists and is **TIER-1 clean but TIER-2 unverified**:
`git apply issues/patches/arg-type-check-fix.patch` (93 lines, one file). It
needs rebasing onto the `forall`→`generic` rename, then TIER 1 + a full TIER 2.
Full analysis, including the load-bearing function-type guard found by
measurement: `issues/yo-self-arg-type-check-bypassed.md`.

### 3. The closure-forall family (8 hollow files)

Reproducer: `issues/repros/closure-arg-abandons-enclosing-begin.yo`. A closure
passed as a call ARGUMENT leaves the callee's forall `U` unbound → the callee's
def-time trial body eval hits `List(U)` → `(result : List(U)) = List(U).new()`
throws → `_trial_eval_fn_body`'s silent handler (`calls/function_type.yo:222`)
swallows it and abandons the caller's begin loop.

**Four measured dead ends — do not repeat** (all in
`issues/yo-self-hollow-test-batch-main.md`):

1. `synthesizeTypes` on the closure return in `closure_type.yo` (TS
   closure-type.ts:186-196) — zero effect; that path is never taken for a
   closure passed as an argument (it is `values/anonymous_function.yo`).
2. Stamping the SomeType return from the body type (TS
   anonymous-function.ts:963-988) — it FIRES (`ret=U rid=1975 body=i32`) and
   Step 6 sees the resolution, yet the repro is unchanged.
3. Widening the expected-type clear at `anonymous_function.yo:1243` — needed to
   make (2) fire at all, not sufficient.
4. Narrowing the unknown-arg CTFE gate (`comptime_fn.yo:565-585`; TS has no such
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

Green baselines: corpus **PASS 140 / DIFF 0**, `check ./std` **153/153**,
battery at its counts AND its hollow flags, stage2 hollow markers **6**,
**FIXPOINT HOLDS**.

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
`evaluator/calls/function.yo`, where `eprintln` is already in scope and the
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
  lineage-identity gate (`types/synthesizer.yo`), the clfid spec-cache keying +
  per-spec SomeT rebuild (`calls/helper.yo`), or receiver-instance Self
  adoption (`expr_info.yo`).
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

| path                                          | what                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| `issues/yo-self-hollow-test-batch-main.md`    | the hollow-batch defect, causes, 4 dead ends            |
| `issues/yo-self-arg-type-check-bypassed.md`   | the parked soundness fix                                |
| `issues/yo-self-69-red-list-map.md`           | the 19 REDs, cluster-mapped                             |
| `issues/yo-self-stub-inventory.md`            | 311 unported/divergent findings, each with TS file:line |
| `issues/patches/arg-type-check-fix.patch`     | TIER-1-clean fix awaiting TIER 2                        |
| `scratchpad/hollow_sweep69.sh`                | honest 183-file scorer                                  |
| `scratchpad/gates_fast.sh` / `gates_perf1.sh` | TIER 1 / TIER 2                                         |
| `tests/codegen-bootstrap/`                    | the 140-file differential corpus                        |
| agent auto-memory `MEMORY.md`                 | distilled lessons — recall before re-deriving           |

Note `tmp/` is a git-ignored scratch dir holding ~78 stale `*.test.yo` files; a
bare `./yo-cli test` sweeps them up and they all fail. Ignore them, or pass an
explicit path.

## Open side issues (not #69 blockers)

- `issues/ts-early-return-nested-block-rc-drop.md` — TS frees an RC container
  early-returned from a nested if-block.
- `issues/ts-constructor-result-drop-o0-crash.md` — TS-side -O0 crash.
- Broad anon-struct expected-type rule blocked by a stage-2 miscompile; the
  narrow rule is committed and green.
