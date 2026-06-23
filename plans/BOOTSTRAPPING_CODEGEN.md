# Bootstrapping the codegen — TS `src/codegen/` → yo-self `yo-self/codegen/`

Plan for the codegen slice of self-hosting (successor to
`BOOTSTRAPPING_EVALUATOR.md`, whose `check` surface went green 2026-06-10).
`BOOTSTRAPPING.md` is the umbrella record — update both when status changes.

**Status in one line (2026-06-20):** the emitter port is substantially
complete — Phases 0–5 are done or near-done and the differential corpus
(`tests/codegen-bootstrap/`, 83 fixtures) passes — but the **self-host fixpoint
(Phase 6) is not reached**. P0 (the intermittent heap-corruption SIGTRAP) is FIXED.
Remaining gates: **P2** — memory. The old "~37 GB, can't run on 16 GB" wall is
**BROKEN**: building the self-host binary at `--optimize 1` + Rust-style sharing
fixes (RC-share recursive `TypeValue` collections; share the immutable token
source; share the def-time body env) make the unified stage-2 self-compile
**complete on this 16 GB box** (peak ~7.5 GB; commit `e9d7bfde3`, corpus 83/83).
It is now an optimization target: get under the measured **TS baseline of 3.8 GB**
(yo-self codegen < TS). And **P1** — a long tail of executing-mode
evaluator/codegen gaps in the completing self-compile's `stage2.c` (currently
**527** `Failed to transpile` markers).

> **P1 ROOT CORRECTED (2026-06-23):** the tail is **NOT** the recursive-enum
> self-shell. Eliminating the shell entirely (approach D,
> `plans/RECURSIVE_ENUM_SHELL_REFACTOR.md`) leaves 527→527 markers (295/296
> throw-points byte-identical) — the shell was orthogonal (only ~37 markers,
> already fixed). The real root is **def-time body-eval typing**: the trial
> wrapper `_trial_eval_fn_body` (calls/function_type.yo) evaluates ~93 of
> yo-self's own function bodies with mistyped params/locals, so ordinary
> `if`/`match` statements (246/296 throw-points are plain `if(...)`) throw "got
> unit"/"incompatible types"/"member mismatch". Diagnosis in progress (instrument
> the trial wrapper → throw→function map). See `issues/yo-self-p1-transpile-tail.md`.

---

## Definition of Done

A FAITHFUL port: strict 1-to-1 file mapping (`src/codegen/X.ts` ↔
`yo-self/codegen/X.yo`), same functions and control flow. `yo-self-bin compile
<file.yo>` produces C11 whose **runtime behavior matches the TS compiler's
output** (judged by stdout + exit code + test results, NOT C-text equality),
culminating in the fixpoint:

1. `yo-self-bin` (stage 1, built by TS) compiles `yo-self/main.yo` → stage 2.
2. Stage 2 compiles `yo-self/main.yo` → stage 3.
3. Stage 2 ≡ stage 3 (behaviorally; `random_id` makes C text unstable, so
   compare run behavior — or seed ids for a text-equality build).

**DONE when ALL hold:**
- [ ] Differential harness: 100% of `tests/*.test.yo` PASS (same stdout, exit
      code, per-test results) on POSIX targets (macOS arm64 + Linux x86_64).
      Windows + WASM runtimes are an explicit out-of-scope follow-up.
- [ ] `yo-self-bin test ./tests` matches `./yo-cli test ./tests`.
- [ ] All differential runs clean under guard pages (libgmalloc).
- [ ] Self-host fixpoint (stage 2 ≡ stage 3).
- [ ] Every validation gate still green; `yo-self/tests/` green under BOTH
      compilers (`./yo-cli test` and `yo-self-bin test`).
- [ ] `BOOTSTRAPPING.md` umbrella table updated.

---

## Validation gates (must stay green throughout)

| Gate | Command | Expected |
|---|---|---|
| TS unit tests | `bun test --timeout 30000` | all pass |
| TS evaluator on std | `node ./out/cjs/yo-cli.cjs check ./std` | all pass (count drifts) |
| Full integration suite | `node --expose-gc --max-old-space-size=4096 ./out/cjs/yo-cli.cjs test ./tests --parallel 2 --bail --c-compiler clang` | all pass, ~12 min |
| Self-hosted sweep | `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std` / `./tests` / `./yo-self` | all pass except the 2 baseline fixtures `tests/circular_deps/circular_error_{a,b}.yo` (error identically under TS) |
| **Differential harness** | `scripts/diff-test.sh tests/codegen-bootstrap --parallel 1` (env `YO_SELF_BIN`, default `/tmp/yo-self-bin`) | **no `DIFF`/`TS-FAIL`**; `SELF-FAIL` only from the flaky SIGTRAP (P0) — confirm any SELF-FAIL is flaky by re-running standalone |

> **Validate serially (`--parallel 1`).** Under `--parallel 3` the flaky SIGTRAP
> (P0) produces non-deterministic SELF-FAILs on *different* fixtures each
> run; a serial run plus a standalone re-run of any failure is the reliable
> signal. "Identical crash across builds → suspect the compiler, not your diff."

---

## Handoff onboarding

**Environment (macOS dev box):**
- `bun` drops out of PATH in fresh shells — re-export the devenv bin dir
  (`/nix/store/*-bun-*/bin` or the devenv profile) before `node`/`bun`.
- `bun run build` before any `node ./out/cjs/yo-cli.cjs …` after TS edits. Never npm.
- The self-hosted binary is deeply recursive — run with `YO_MAIN_STACK_MB=2048`
  (NOT 8192: an 8 GB stack reservation starves the heap on a 16 GB box → rc=137;
  2 GB is the sweet spot here). A `-O0` rc=139 on deep recursion is stack
  exhaustion, not heap corruption.
- Build loop: `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin` — ~5 min,
  NO `--release` (too slow to iterate).
- Run `./yo-cli fmt <file.yo>` on every created/modified `.yo` before committing.
- Classify yo-self-bin failures by **exit code**: rc=0 pass, rc=1 evaluator
  error, rc=134 SIGABRT (usually OOM), rc=139 SIGSEGV (stack), rc=133 SIGTRAP
  (heap corruption — P0).
- `--sanitize address` is broken here (Nix clang vs Xcode runtime) and single-TU
  ASan OOMs at 16 GB. For memory bugs use guard pages:
  `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib MallocStackLogging=full <bin> …`,
  then post-crash lldb `-k` + `malloc_history <pid> <addr>` for alloc/free/use
  stacks (template: `issues/fixed/yo-self-macro-dispatch-corruption.md`).

**Conventions (non-negotiable):**
- **Strict 1-to-1**: same functions, same order; language-forced divergences get
  a header comment. No yo-only helper files.
- **TS-first for bugs**: if TS codegen has a bug, fix TS (with a `tests/` case
  that fails first), then port.
- **Never regress the gates.** Findings → `issues/`; Yo-language surprises →
  `.github/skills/*` + `.github/instructions/*`.
- Commits: `git commit --no-verify`, body ends
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push incrementally;
  validate every batch.

**Yo-syntax landmines** (full list in
`.github/skills/yo-syntax/syntax-cheatsheet.md` — read it):
- Single-expression fn body must NOT have braces (`{ expr }` = struct lit).
- `if(cond, { block })` — NOT `if(cond) { block }`.
- No forward references; self-recursion via `recur`, not the fn's name.
- No variable shadowing (match-arm bindings can't reuse an outer name).
- `match` over multi-field variants: curly destructuring `.Variant({ field, other : alias })`.
- Objects are Rc'd, cannot be mutually recursive — break cycles with id strings.

---

## Architecture — the coupling that defines the work

TS codegen is driven almost entirely by evaluator annotations on `expr.$`
(yo-self: the **`ExprInfo` table**, keyed by global `ast_expr_id`): `type`,
`value`, `variable_name`, `env`, `control_flow`, `path_collection`,
`runtime_arg_exprs_in_order`, `runtime_destructurings`, `dyn_call_trait_values`,
`deferred_dup/drop_expressions`, `macro_expansion`, `await_analysis`,
`index_method_value`, capture structs. **Most of the porting effort is making the
evaluator PRODUCE these fields and the emitters CONSUME them — not the C
string-building.**

**Executing-mode requirement.** Codegen evaluates function bodies in
`is_executing = true` mode with REAL, propagating errors — the def-eval-wall
*swallow* that protects `check` does not apply. This surfaces the remaining
evaluator tail by design (see P1). yo-self's own source is the harshest
corpus there is.

**Core data model (relevant to P2).** `TypeValue`, `AstExpr`, `EvalValue`
are **`enum`s** (sum types — the natural representation for the ~40-variant Type
union, etc.). Recursive children use **`Box(Self)`** (single-owner); collection
fields are **`ArrayList(T)`** (an `object` — RC, reference-semantics, mutable).
TS represents these as `interface`s (shared heap references, GC'd). The port
turned each TS union into a value-type enum and reached for deep `.clone()`
wherever TS relied on a shared reference — the fastest path to an obviously
correct port, trading **memory** for simplicity. That trade is the root of
the P2 memory issue.

---

## Status snapshot (2026-06-20)

| Phase | State | Notes |
|---|---|---|
| 0 — baseline + differential harness + UAF fix | ✅ done | `scripts/diff-test.sh`; the ExprInfo-table UAF is fixed (RC layer clean) |
| 1 — typed pipeline | ✅ done | constants/utils/context/collection/codegen-c orchestration |
| 2 — expression emitters | ✅ substantially done | atoms, control flow, operators, struct/enum/newtype/tuple construction, property access, casts, address-of, pointer ops, extern calls, Index-trait dispatch |
| 3 — functions/types/dyn/specialization | ✅ substantially done | dyn subsystem complete; generic specialization (instance+static, ctor-in-body, const-generic `Array(T,U)`, fresh-id body clone); generic `println`/`print` end-to-end |
| 4 — memory-management correctness | 🟡 substantially done | RC dup/drop placement, cycle-GC scaffolding, dispose dispatch, runtime borrow-flag backstop wired (both compilers). Remaining: complete consume-tracking mirror; **systematic guard-page/ASan-clean validation is blocked by P0+P2** |
| 5 — async/effects/parallelism (POSIX) | 🟡 substantially done | FSM transform core, state-machine + state-code-gen emitters, IO runtimes (Linux/macOS/Windows), `unwind` escape-propagation, parallelism runtime. Remaining: synchronous `ctl` effect handlers; the MATCH cluster in await codegen; `run_test` wiring in `main.yo` |
| 6 — self-host fixpoint | ❌ not reached | the finish line; gated on P0–P2 |

Differential corpus: **80 fixtures, PASS** (serial, modulo P0). Test-suite
denominators for Definition of Done: `tests/*.test.yo` = 85; `yo-self/tests/` =
59 files (already green under TS; re-validate under `yo-self-bin test` in
Phase 6).

---

## Remaining work — PRIORITIZED

The systemic issues below gate the fixpoint, in priority order. With P0 fixed
(2026-06-21), the corpus is deterministically green again, so the validation
signal is reliable; the lead is now the P1 tail (steady, well-understood drain);
the P2 memory issue is the deepest and ultimately blocks the unified fixpoint on
this hardware.

### P0 — intermittent SIGTRAP-in-malloc (heap corruption) — ✅ FIXED (2026-06-21)

Was a deterministic double-free of a borrowed clone-argument temp on a
`match(o, .Some(_) => return(f(x.clone())), …)` path: `src/codegen/exprs/match.ts`
re-emitted the arm begin-block's `deferredDropExpressions` at scope-close even
when the arm's final expression exits via control flow — but the `return` had
already flushed `pendingDeferredDrops` (which includes those drops) and dedup'd
them, so the temp was dropped twice (the redundant drop executes live, before the
return). Fixed by skipping the scope-close drop emission when the final
expression has control flow. Validation: heavy fixtures 0/20 crashes (was ~33%),
corpus PASS 80/80 deterministically, full TS suite 2601/2601 (shared codegen —
no regressions), regression test `tests/return_call_clone_arg_drop.test.yo`.
Detection used an RC quarantine (poison-instead-of-free in `__yo_decr_rc` →
deterministic abort) — gmalloc does NOT reproduce freelist-corruption
double-frees. See `issues/fixed/yo-self-codegen-intermittent-sigtrap.md`.

### P1 (LEAD) — executing-mode evaluator/codegen tail (per-module transpile errors)

Compiling individual modules surfaces `// Failed to transpile …` markers — each
a *candidate* executing-mode gap. Small/medium modules are clean or near-clean;
foundational modules (`error.yo`, `lexer.yo`, `token.yo`, `utils.yo`) are at 0.
As of 2026-06-21, TWO families FIXED (validated: corpus 83/83 + std 152/152, zero
regression): `Self`-not-found in specialized HashMap/HashSet method bodies ×4
(`378914804`) + value.yo `field_labels` dual-struct clone (`8910182ad`). value.yo
is down to **2** (`field_types` + `and`), parser.yo **3** (`array_list` ×2 + arg-count).
The remaining tail is now ROOT-CAUSED to a few systemic mechanisms (see
`issues/yo-self-p1-transpile-tail.md` for the full evidence; 10 build-validated fix
attempts ruled out 10 distinct sites):
- **`field_types` (value) / `args` (parser)** — clone of a recursive-enum
  SELF-SHELL-typed runtime receiver. `clone` resolves via the generic Clone-impl /
  derived-clone path (NOT the `type_id_or_empty` registry — proven: the chokepoint
  resolve no-op'd), which the shell breaks → `clone`→TypeVal→`Type(1)`. Compounded by
  registration TIMING (`resolve_enum_shell` returns `vars=0` before
  `register_enum_final` on early calls). A deep, MULTI-FACETED effort (shell +
  clone-via-generic-impl/derived + timing) in the hardest subsystem — not a single
  targeted fix (10 ruled out). Warm-up-masked (likely vanishes in the real
  fixpoint, like field_labels did).
- **`and` (value)** — a comptime_str LITERAL arg to a `Self`-typed param
  (`String.starts_with(prefix : Self)`): the comptime-arg→param coercion
  (helper.yo:482) skips it because `Self` isn't resolved to the receiver during
  arg-binding. Regression-prone area (touching it unguarded once regressed std
  151→17); needs careful Self-resolution-in-coercion.
- **`array_list` (parser ×2 + arg-count)** — gated MACRO_DISPATCH (the macro isn't
  expanded at def-time eval).

> ⚠️ **Standalone per-module surveys OVERCOUNT.** Some markers are
> warm-up/ordering artifacts, NOT real fixpoint blockers: a method first
> specialized via a NESTED path (e.g. `xs.clone()` → `Self.with_capacity` →
> `(*(T))(_ptr)` cast) can fail to bind the impl forall `T` and degenerate to
> `Type(1)`, but the SAME method specialized DIRECTLY first (as happens
> throughout the full self-compile) binds `T`, succeeds, and caches a good entry
> the nested call reuses. So `value.yo`'s remaining `field_labels` error
> disappears once `ArrayList(String).with_capacity` is warmed by any direct call
> — it is substantially a per-module-compile artifact. The genuine remaining
> tail can only be measured by the REAL stage-2 self-compile (P2-gated: OOMs on
> 16 GB). Treat single-module marker counts as an upper bound, and confirm a
> candidate is real (not warm-up-masked) before investing in a deep fix.
> (Details + repro ladder: `issues/yo-self-p1-transpile-tail.md`.)

The drain methodology is proven and steady:

> survey per-module (`compile <m>.yo --emit-c --skip-c-compiler`,
> `grep -c "Failed to transpile"`) → pick a tractable family → reproduce
> minimally (`src/tests/fixme.yo`) → if the cond/expr has no ExprInfo, instrument
> the def-time trial-eval swallow (`_trial_eval_fn_body` in
> `evaluator/calls/function_type.yo`) to print the swallowed throw → root-cause →
> fix in the evaluator or emitter → re-measure → corpus-validate → commit.

Known open items in this bucket:
- General trait-`?=`-default codegen (`String`/`Ord`/`Error.source` `!=`
  defaults) — `create_specialized` must monomorphize default bodies with a
  direct-call-only param bind + struct-id stability (Task #22; reverted 3× —
  needs the param-bind isolated from the shared specialization path).
- The MATCH cluster in await/async codegen and synchronous `ctl` effect
  handlers (Phase 5 tail).
- Note: the LARGEST modules (`function.yo`, `match.yo`, `helper.yo`,
  `codegen_c.yo`, the async modules) cannot be surveyed standalone today — they
  `rc=134` OOM mid-compile (the P2 memory issue). Their tail is only reachable
  once P2 is addressed or on a bigger box.

### P2 — memory: the unified self-compile now COMPLETES on 16 GB (goal: < TS)

**The "~37 GB, can't run on a 16 GB box" wall is BROKEN.** That figure was the
`-O0` build (stack-dominated: ~13 MB eval frames forcing a ~17 GB stack). The
real *heap* driver was the port deep-`.clone()`ing value-type data wherever TS
shares a reference. Building the self-host binary at **`--optimize 1`** (LLVM
stack coloring shrinks frames ~100×) plus a sequence of **Rust-style sharing
fixes** make the unified `yo-self/main.yo` stage-2 self-compile **complete** on
this 16 GB box.

**Confirmed (commit `e9d7bfde3`, corpus 83/83 clean):**
- `TypeValue.clone` RC-shares its recursive nested-type collections instead of
  deep-cloning them (the `EnumT`/`Struct`/`TraitT` arms; `ArrayList` is RC, so a
  plain field copy is a refcount bump). Sound because TypeValues are
  rebuilt-not-mutated; also retired the `g_tv_clone_path` cycle guard.
- `Token.clone` shares the immutable `input` (full module source) instead of
  deep-copying it on every AST clone — that single copy was **~1.6 GB / 76% of
  peak** (`String.clone` 1.6 GB → 145 MB).
- **Result: stage-2 self-compile completes, peak ~7.5 GB, `stage2.c` emitted,
  30 transpile-error markers** = the real P1 tail (now measurable — P2 was
  blocking P1 measurement).

**Target: the measured TS baseline is 3.8 GB** (`node yo-cli compile main.yo
--emit-c --skip-c-compiler`), NOT the ~1 GB an earlier note assumed. So "yo-self
codegen < TS" is now a ~2× reduction from 7.5 GB.

**Approach = Rust's memory model — owned `String` for building, `str` for views,
`Arc<str>`(=`std/imm/string`) / RC-sharing for clone-heavy immutable data —
applied biggest-first:**
- ✅ RC-share recursive `TypeValue` collections; share the immutable token source.
- ❌ Sharing the def-time body env (`snapshot_env` in `_build_def_time_body_env`
  instead of copying caller variables) — TRIED, REVERTED. Corpus-clean (83/83,
  same 30 markers) but it *increased* peak 7.5 → 8.9 GB (sharing the caller
  frames pinned more via ExprInfo env-snapshots than the copy did). Lesson: the
  2.6M `add_variable_to_env` Variables are **not** a single copy-loop — they are
  genuine bindings across all evaluated bodies (confirmed by `sample`: called
  from `_evaluate_funcval_runtime_call` / identifier eval / init-assignment on
  every call), retained via ExprInfo env-snapshots.

**The remaining gap to < TS is a multi-session object-shrink refactor.** The
peak is dominated by heavy *value-type* objects where TS uses light shared refs:
**2.6M `Variable` @ 896 B (2.32 GB / 44%)** + **688K `ExprInfo` @ 1366 B
(0.94 GB / 18%)**. Shrinking them means **boxing rarely-`Some` value-type
fields** (e.g. `Variable.consumed_at_token`, `ExprInfo.origin_type` /
`converted_runtime_type` — `Option(T)` reserves `sizeof(T)` inline even when
`None`). Each such cut yields only ~150–270 MB and **ripples to consumers**
(they expect the unboxed type → unbox at every read), so ~12–15 cuts are needed.
Higher-leverage **type interning** (share one canonical `TypeValue`) is
infeasible without converting the entire `TypeValue` representation to an
RC/handle type (thousands of sites) — the original "multi-week refactor". The
heavy `Variable` fields (`ty`, `token`×3) can't be cheaply boxed (always present
→ boxing just moves them to the heap unless interned).

**Fallback / pragmatic stance**: the practical win — the self-compile *completes*
on 16 GB (the fixpoint is now physically runnable here, and on a 32 GB+ box with
ample headroom) — is DONE. Driving under TS's 3.8 GB is a separate, dedicated
multi-session effort along the object-shrink path above.

### Phase 6 — the fixpoint (after the above)

1. `yo-self-bin test ./tests` matches `./yo-cli test`.
2. Stage 2 (`yo-self-bin compile yo-self/main.yo`) → stage-2 binary passes (1).
3. Stage 3 + the fixpoint comparison (Definition of Done).
4. Re-validate `yo-self/tests/` under `yo-self-bin test`.

---

## References

- `scripts/diff-test.sh` — the differential harness; the `check`-equivalent run
  after every batch.
- `plans/codegen-baseline-scorecard.md` — the committed Phase-0 baseline.
- `BOOTSTRAPPING.md` — umbrella status; update its codegen rows as work lands.
- `BOOTSTRAPPING_EVALUATOR.md` + `EVALUATOR_PORT_REVIEW.md` — the evaluator
  slice (complete) + the divergence inventory the executing-mode tail draws from.
- `issues/fixed/` — per-fix dossiers (Index-trait codegen, cond/panic,
  open-import FuncVal typing, the UAF dossier with the gmalloc workflow, …).
