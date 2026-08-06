> **CLOSED (2026-08-06).** The bootstrap campaign this document belongs to is
> complete: the self-hosted compiler passes the full suite, the stage-2/stage-3
> fixpoint holds, and every CI job gates PRs (run 31069479984, commit
> `ac85f6cfc`). Kept as a historical record — do not resume work from this
> file. Umbrella status: `plans/BOOTSTRAPPING.md`. What comes next:
> `plans/SELF_HOSTING_COMPLETION.md`.

# Bootstrapping the codegen — TS `src/codegen/` → yo-self `yo-self/codegen/`

Plan for the codegen slice of self-hosting (successor to
`BOOTSTRAPPING_EVALUATOR.md`, whose `check` surface went green 2026-06-10).
`BOOTSTRAPPING.md` is the umbrella record — update both when status changes.

> **COMPLETE (2026-08-03, `65ebcdbb2`):** all 8 phases done. Full suite
> 186/186 GREEN under the self-hosted binary, corpus 154/154, stage-2
> emit 0 markers / clang 0 errors, and the **Phase-6 fixpoint HOLDS**
> (stage-2 ≡ stage-3 byte-identical). The P2 memory blocker was resolved
> by the 2026-07 perf arc (hash-clustering, emit dispatch, -26%% GC).
> Operational record: [`YO_SELF_STAGE2_HANDOFF.md`](YO_SELF_STAGE2_HANDOFF.md).

**Status in one line (2026-07-01, historical):** the emitter port is substantially complete —
Phases 0–5 are done or near-done and the differential corpus
(`tests/codegen-bootstrap/`, 96 fixtures) passes. **P0** (intermittent
heap-corruption SIGTRAP) is FIXED. **P1** (executing-mode transpile-error tail) is
**COMPLETE — 0 real failures**: the TS compiler self-compiles `yo-self/main.yo`
(`--emit-c`) in **81 s** producing **zero** real `// Failed to transpile` markers,
and the port is faithful (corpus 96/96 binary≡TS), so the yo-self binary emits the
same. The only remaining gate is **P2** — memory: the yo-self **binary** peaks
~10 GB RSS self-compiling (≈3× the TS compiler's ~3.3 GB), which swap-thrashes on a
16 GB box (TS fits and finishes in 81 s). This memory bloat — not markers, not
compute — is what blocks a _fast_ binary self-compile and the **Phase 6 fixpoint**
on this hardware. The `YO_GC_FULL_PCT` env knob (`ed48c310c`) caps the GC's
full-scan peak to help at the margin, but cannot shrink the live set.

> **P1 METRIC CORRECTED (2026-07-01): every historical count was inflated by a
> fixed floor of 2.** A naive `grep -c "Failed to transpile" stage2.c` matches the
> codegen's OWN fallback-message _definitions_ — `String.from("// Failed to
transpile ")` at `yo-self/codegen/exprs/generation.yo:409` (value-emit) and
> `:577` (ref-emit) — which become two C string literals
> (`(const uint8_t*)"// Failed to transpile "`) when yo-self compiles yo-self. A
> REAL failure is an emitted COMMENT line (`^\s*// Failed to transpile <expr>`); a
> string-literal match (`"// Failed to transpile`) is the floor. **So "527 → 30 →
> 2" was "525 → 28 → 0" real failures** — the drain finished. Always measure with
> `scripts/count-transpile-failures.sh <emitted.c>` (prints `<real> real (<floor>
string-literal floor)`, exits non-zero iff real > 0), never a bare grep.
> Caveat: the genuine count was only ever cleanly measurable from a COMPLETING
> self-compile; the TS self-compile (which completes in 81 s) is the reference and
> shows 0 real, confirming the binary (faithful port) would too once P2 lets it
> finish. See `issues/yo-self-p1-transpile-tail.md`.

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

| Gate                     | Command                                                                                                               | Expected                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TS unit tests            | `bun test --timeout 30000`                                                                                            | all pass                                                                                                                        |
| TS evaluator on std      | `node ./out/cjs/yo-cli.cjs check ./std`                                                                               | all pass (count drifts)                                                                                                         |
| Full integration suite   | `node --expose-gc --max-old-space-size=4096 ./out/cjs/yo-cli.cjs test ./tests --parallel 2 --bail --c-compiler clang` | all pass, ~12 min                                                                                                               |
| Self-hosted sweep        | `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std` / `./tests` / `./yo-self`                                        | all pass except the 2 baseline fixtures `tests/circular_deps/circular_error_{a,b}.yo` (error identically under TS)              |
| **Differential harness** | `scripts/diff-test.sh tests/codegen-bootstrap --parallel 1` (env `YO_SELF_BIN`, default `/tmp/yo-self-bin`)           | **no `DIFF`/`TS-FAIL`**; `SELF-FAIL` only from the flaky SIGTRAP (P0) — confirm any SELF-FAIL is flaky by re-running standalone |

> **Validate serially (`--parallel 1`).** Under `--parallel 3` the flaky SIGTRAP
> (P0) produces non-deterministic SELF-FAILs on _different_ fixtures each
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
_swallow_ that protects `check` does not apply. This surfaces the remaining
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

## Status snapshot (2026-07-01)

| Phase                                         | State                 | Notes                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — baseline + differential harness + UAF fix | ✅ done               | `scripts/diff-test.sh`; the ExprInfo-table UAF is fixed (RC layer clean)                                                                                                                                                                                           |
| 1 — typed pipeline                            | ✅ done               | constants/utils/context/collection/codegen-c orchestration                                                                                                                                                                                                         |
| 2 — expression emitters                       | ✅ substantially done | atoms, control flow, operators, struct/enum/newtype/tuple construction, property access, casts, address-of, pointer ops, extern calls, Index-trait dispatch                                                                                                        |
| 3 — functions/types/dyn/specialization        | ✅ substantially done | dyn subsystem complete; generic specialization (instance+static, ctor-in-body, const-generic `Array(T,U)`, fresh-id body clone); generic `println`/`print` end-to-end                                                                                              |
| 4 — memory-management correctness             | 🟡 substantially done | RC dup/drop placement, cycle-GC scaffolding, dispose dispatch, runtime borrow-flag backstop wired (both compilers). Remaining: complete consume-tracking mirror; **systematic guard-page/ASan-clean validation is blocked by P0+P2**                               |
| 5 — async/effects/parallelism (POSIX)         | 🟡 substantially done | FSM transform core, state-machine + state-code-gen emitters, IO runtimes (Linux/macOS/Windows), `unwind` escape-propagation, parallelism runtime. Remaining: synchronous `ctl` effect handlers; the MATCH cluster in await codegen; `run_test` wiring in `main.yo` |
| 6 — self-host fixpoint                        | ❌ not reached        | the finish line; **now gated solely on P2** (P0 fixed, P1 = 0 real failures). The binary's ~3× memory peak swap-thrashes the stage-2 self-compile on 16 GB; needs the object-shrink refactor or a 32 GB box                                                        |

Differential corpus: **96 fixtures, PASS** (serial). Test-suite denominators for
Definition of Done: `tests/*.test.yo` = 85; `yo-self/tests/` = 59 files (already
green under TS; re-validate under `yo-self-bin test` in Phase 6).

---

## Remaining work — PRIORITIZED

The systemic issues below gate the fixpoint, in priority order. With P0 fixed
(2026-06-21) and **P1 complete (0 real transpile failures, 2026-07-01)**, the
**sole remaining blocker is P2 — memory**: the binary self-compile peaks ~3× the
TS compiler and swap-thrashes on this 16 GB box. P2 is now the lead and the only
thing between here and the Phase 6 fixpoint.

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

### P1 — executing-mode evaluator/codegen tail — ✅ COMPLETE (0 real failures, 2026-07-01)

The transpile-error drain is **finished**. The TS compiler (the reference; same
codegen logic as the faithful binary port) self-compiles `yo-self/main.yo`
(`node out/cjs/yo-cli.cjs compile yo-self/main.yo --emit-c`) in **81 s**, emitting
`stage2.c` with **0 real** `// Failed to transpile` markers. Verify with:

```
scripts/count-transpile-failures.sh /tmp/stage2_ts.c   # → "0 real (2 string-literal floor)"
```

**The floor of 2 is not failures** — it is the codegen's own fallback-message
_definitions_ compiled into the output (see the METRIC CORRECTED note at the top
of this doc). Every historical "527 / 30 / 2 markers" figure was that count minus
2 = real failures, so the true trajectory was **525 → 28 → 0**. The systemic
mechanisms that drove the tail (def-time body-eval typing, `Self`-not-found in
specialized method bodies, recursive-enum self-shell clone, comptime-arg→`Self`
coercion, gated macro-dispatch) were all resolved over the session's fix series
(tasks #48–#62); the warm-up-masking caveat below explains why the last
per-module residuals vanished in the real (full) self-compile exactly as predicted.

> ⚠️ **Why standalone per-module surveys OVERCOUNTED (historical).** A method
> first specialized via a NESTED path (e.g. `xs.clone()` → `Self.with_capacity` →
> `(*(T))(_ptr)` cast) could fail to bind the impl forall `T` and degenerate to
> `Type(1)`, but the SAME method specialized DIRECTLY first (as happens in the
> full self-compile) binds `T`, succeeds, and caches a good entry the nested call
> reuses. So single-module marker counts were an upper bound; the genuine count is
> only meaningful from a COMPLETING self-compile — which the TS reference now
> provides (0 real). Confirmed: the binary is a faithful port (corpus 96/96
> binary≡TS output), so it emits the same 0 real once P2 lets it finish.

Codegen-bug fixes that landed late in the drain and are validated in the corpus
(96/96): try-macro/match-arm returning-arm env leak, iterator `Option(i32)`
double-id (enum structural dedup), recursive-enum `Box(Self)` nested match
(structural compatibility recursion). See `issues/fixed/`.

Reusable drain methodology (kept for the record):

> survey a COMPLETING compile (`scripts/count-transpile-failures.sh <emitted.c>`)
> → reproduce minimally (`src/tests/fixme.yo`) → if the cond/expr has no ExprInfo,
> instrument the def-time trial-eval swallow (`_trial_eval_fn_body` in
> `evaluator/calls/function_type.yo`) to print the swallowed throw → root-cause →
> fix in the evaluator or emitter → re-measure → corpus-validate → commit.

Deferred (not P1 blockers — neither appears in the 0-real self-compile output):

- General trait-`?=`-default codegen (`String`/`Ord`/`Error.source` `!=`
  defaults) — `create_specialized` must monomorphize default bodies with a
  direct-call-only param bind + struct-id stability (Task #22; reverted 3×).
- The MATCH cluster in await/async codegen and synchronous `ctl` effect
  handlers (Phase 5 tail).

### P2 — memory: the unified self-compile now COMPLETES on 16 GB (goal: < TS)

**The "~37 GB, can't run on a 16 GB box" wall is BROKEN.** That figure was the
`-O0` build (stack-dominated: ~13 MB eval frames forcing a ~17 GB stack). The
real _heap_ driver was the port deep-`.clone()`ing value-type data wherever TS
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
- **Result: stage-2 self-compile completes, profiled heap peak ~7.5 GB → ~5.26 GB
  after the boxing series, `stage2.c` emitted, 0 real transpile-error markers
  (P1 done — the historical "30" was 28 real + the 2-string floor).**

**Reference baseline (re-measured 2026-07-01): the TS compiler self-compiles
`yo-self/main.yo --emit-c` in 81 s at ~3.3 GB peak** (`node out/cjs/yo-cli.cjs`).
The yo-self **binary** does the same work but peaks **~10 GB RSS (≈3× TS)** — so on
a 16 GB box (with ~7 GB system baseline) it swap-thrashes for hours, where TS fits
and finishes in 81 s. **This 3× memory ratio is the entire reason the binary
self-compile is slow** — it is not markers (0 real) and not compute.

> **Ruled out — NOT a GC regression (2026-07-01).** Built the pre-Bacon-Rajan
> binary (`dc6e0d69f^`, the old full-heap-at-2×-live GC) in a worktree and ran the
> same self-compile: it peaks at the SAME ~8.6 GB RSS and swap-thrashes
> identically. So the session's GC rewrite (`dc6e0d69f`) did not inflate the peak;
> the ~3× bloat is the value-type object model (below), present in both.

> **GC knob (`ed48c310c`): `YO_GC_FULL_PCT`** lets a constrained run cap the full
> collector's re-arm factor below the default 2×-live (e.g. `YO_GC_FULL_PCT=110`).
> It measurably keeps RSS lower and the early/mid self-compile phases at ~100 % CPU
> (vs swap-thrash), but it cannot shrink the **live** working set, so the deepest
> eval point (~10 GB) still exceeds 16 GB headroom. Useful margin, not a fix.

**Target: drive the binary peak under the TS ~3.3 GB.** "yo-self codegen < TS" is a
~3× reduction from the ~10 GB RSS binary peak (≈2× from the ~5.26 GB profiled heap).

**Approach = Rust's memory model — owned `String` for building, `str` for views,
`Arc<str>`(=`std/imm/string`) / RC-sharing for clone-heavy immutable data —
applied biggest-first:**

- ✅ RC-share recursive `TypeValue` collections; share the immutable token source.
- ❌ Sharing the def-time body env (`snapshot_env` in `_build_def_time_body_env`
  instead of copying caller variables) — TRIED, REVERTED. Corpus-clean (83/83,
  same 30 markers) but it _increased_ peak 7.5 → 8.9 GB (sharing the caller
  frames pinned more via ExprInfo env-snapshots than the copy did). Lesson: the
  2.6M `add_variable_to_env` Variables are **not** a single copy-loop — they are
  genuine bindings across all evaluated bodies (confirmed by `sample`: called
  from `_evaluate_funcval_runtime_call` / identifier eval / init-assignment on
  every call), retained via ExprInfo env-snapshots.

**Re-measured 2026-07-01 (the numbers above this line predate the `ref(enum)`
refactor and are STALE — Variable/ExprInfo shrank to pointers).** macOS `heap` on
the binary self-compile + a `-Dmain` `sizeof` probe give the CURRENT breakdown:
**~13 M TypeValue @ 168 B (~2.5 GB)** + **~26 M ArrayList objects @ 80 B (~2.1 GB)
— the TypeValues' collection fields** (`field_types`/`param_types`/`forall_types`/
`variant_fields`, 2–4 per compound type) + ~16.5 M backing buffers (~0.5 GB). So
~90 % of the heap is rooted in TypeValue + its collections. Allocation is DIFFUSE
(no hot site); the fit-determining metric is the transient **peak** (~9.5 GB), not
steady size.

Two levers, in order:

- **DONE — RC header 64 → 56 B** (`c8fa9157c`): ref_count size_t→u32 + gc_mark
  enum→u8, repacked into one 8-byte word. −0.43 GB steady (ArrayList 88→80 crosses
  the 96→80 malloc class). Safe, validated (corpus 96/96, std 152/152, RC/cycle/
  atomic/thread). Reduces steady pressure but NOT the peak (per-object size doesn't
  bound a count-driven surge). Further header/variant micro-shrinks are diminishing
  (~0.1–0.2 GB, rippling, peak-neutral) — not worth grinding.
- **NEXT (the peak lever) — hash-cons TypeValues**: dedup structurally-identical
  types so the evaluator materialises D distinct types instead of ~13 M. TypeValue
  is ALREADY a `ref(enum)` (the "convert to a handle type" blocker is GONE — task
  #36 did it), so interning is a refcount bump, not a representation rewrite. This
  is the only lever with multi-GB, peak-reducing potential. Full design, phasing,
  mutation-safety analysis, and risks: **`plans/backlog/TYPEVALUE_HASH_CONSING.md`**.

**Pragmatic stance**: the self-compile already _completes_ on 16 GB in a clean env
(`YO_MAIN_STACK_MB=2048`, no stray procs; peak ~9.5 GB fits, slow post-peak from
compressor pressure). Driving under the TS ~3.3 GB bar is the hash-consing effort.

### Phase 6 — the fixpoint (after the above)

1. `yo-self-bin test ./tests` matches `./yo-cli test`.
2. Stage 2 (`yo-self-bin compile yo-self/main.yo`) → stage-2 binary passes (1).
3. Stage 3 + the fixpoint comparison (Definition of Done).
4. Re-validate `yo-self/tests/` under `yo-self-bin test`.

---

## References

- `scripts/diff-test.sh` — the differential harness; the `check`-equivalent run
  after every batch.
- `scripts/count-transpile-failures.sh` — the **correct P1 metric**: counts real
  emitted `// Failed to transpile` comment lines, separating them from the fixed
  2-occurrence string-literal floor a bare grep miscounts. Use this, never a bare grep.
- `plans/archive/codegen-baseline-scorecard.md` — the committed Phase-0 baseline.
- `BOOTSTRAPPING.md` — umbrella status; update its codegen rows as work lands.
- `BOOTSTRAPPING_EVALUATOR.md` + `EVALUATOR_PORT_REVIEW.md` — the evaluator
  slice (complete) + the divergence inventory the executing-mode tail draws from.
- `issues/fixed/` — per-fix dossiers (Index-trait codegen, cond/panic,
  open-import FuncVal typing, the UAF dossier with the gmalloc workflow, …).
