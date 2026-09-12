# Faster edit-compile-run: what Yo can take from Zig, and what it cannot

_Status: ACTIVE (2026-09-09) — Phase 0 (instrumentation) LANDED 2026-09-10
(`--profile` / `--profile-json` real, `tests/cli-cases/compile-profile` gate,
answers recorded in §3.1); Phase 1 (dev profile) LANDED 2026-09-10
(`--emit-chunks auto` + the DEBUG `yo build` default + the `chunked-gate`
CI job, numbers in §4); Phases 2–5 not started.

This is the successor to two landed designs and should be read after them:

- `plans/reference/INCREMENTAL_COMPILATION.md` — Phases A–C LANDED: the
  build-runner artifact stamp, LSP-correct module invalidation, and the
  in-process `yo check --watch`. Its original Phase C (reuse evaluated
  modules across processes) is still deferred.
- `plans/reference/CHUNKED_C_EMISSION.md` — steps 0–5 LANDED: opt-in
  `--emit-chunks N`, a parallel `cc -c` driver and a per-chunk `.o` cache.
  Its closing observation is the starting point here: **after a warm
  chunked build the EVALUATOR is 85% of the rebuild**, and the `.o` cache
  only pays for flag changes because symbol names renumber on every edit.

The question that prompted this plan: Zig also compiles through a C
backend, Zig says its backends are faster than LLVM, and Zig's incremental
compilation is fast — can Yo learn from it? The short answer is yes, but
the lesson is not the one the question assumes. Section 1 sets the record
straight; the rest is the plan.

## 0. Where Yo's time goes today (measured, in-repo numbers)

All numbers are from the Mac Mini M4 unless noted; sources are the two
reference docs above and `src/README.md`.

| self-build (`yo build` of the compiler, `--optimize 2`) | seconds |
| --- | --- |
| evaluate + emit (`compile src/main.yo --skip-c-compiler`) | **137.4** |
| clang `-O2` on the single 148 MB / 2.35 M-line `yo.c` | 72.3 |
| **single-file total (today's default, `build.yo` sets no chunks)** | **209.7** |
| chunked N=8, cold `.o` cache | 171.5 |
| chunked N=4, warm cache (4 cached, ThinLTO link ~24 s) | 161.7 |

| the developer loop | seconds |
| --- | --- |
| `yo check ./src` full pass, 262 files | 95 |
| `yo check ./src --watch`, leaf edit (`src/lsp/folding.yo`, 3-file reverse closure) | 2.75 |
| `yo check ./src --watch`, hub edit (`src/token.yo`, 220-file reverse closure) | 87 |
| clang `-O0` single file / chunked N=4 parallel (C leg only) | 18.25 / 5.49 |
| `yo test ./tests/internal --parallel 1` (58–65 files) | 1332 (22.2 min) |

Structural facts that decide what is possible (file references are the
current tree, `src/**.yo`):

1. **One translation unit, whole program.** `Emitter` holds three buffers
   concatenated by `Emitter.print()`; `run_compile` writes one `.c` and runs
   one `cc`. Codegen is reachability-driven from the entry module's exports
   (`collect_required_functions`, `src/codegen/functions/collection.yo`),
   monomorphizing as it goes. There is no per-module object and no notion
   of a module in the emitted C.
2. **Symbol names are a global counter.** A function's C name is a
   sanitized `fn_yo_id_<N>` where `N` comes from the single monotonic
   `random_id` counter (`src/utils.yo`); type names are `__yo_t<N>` by
   interning order; `ExprInfo` keys come from `alloc_global_expr_id`
   (`src/expr.yo`). An edit that changes the number of ids consumed
   anywhere renames every symbol minted after it. This is why the chunk
   `.o` cache is a flag-change cache, not an edit cache, and why the chunk
   assignment had to be `fnv1a(c_name) % N` instead of by module.
3. **Every process re-evaluates everything.** The module cache
   (`src/evaluator/module_loader.yo`), the prelude env and the shared
   `ExprInfoTable` (`src/module_manager.yo`) live for one process. Nothing
   about evaluated modules, types or exports is ever written to disk. Each
   `yo build` artifact is a child `yo compile`; each `yo test` batch is a
   child `yo compile`; each of those re-parses and re-evaluates prelude,
   std and the whole import closure from source.
4. **The artifact stamp is all-or-nothing.** `compile_artifact`
   (`src/build_runner.yo`) hashes every `.yo` under the project AND the
   whole std tree plus the child argv; one changed byte anywhere recompiles
   the artifact from scratch. That is correct, and it is the only
   cross-process incrementality that exists.
5. **Laziness reorders, it does not skip.** `LAZY_TOPLEVEL_BINDINGS.md`
   rule 5: every definition of every imported module is forced by module
   end, so `check` and the LSP see every diagnostic. Forcing is miss-driven
   (`force_pending` on a lookup miss) — which means the evaluator ALREADY
   observes, at the moment it happens, which definition needed which
   other definition. Nothing records that edge today.
6. **`run_compile` demands a fresh `ExprInfoTable`.** A second in-process
   compile against a reused table produced 47 "Failed to transpile" stubs
   (`src/main.yo`, comment above `run_compile`); this is what pushed test
   batches into child processes and is the concrete blocker for any
   in-process build reuse.
7. **There is no profiler.** `yo test --profile` is parsed and discarded
   (`src/main.yo`, the flag loop in `run_test`) while the help text still
   advertises "Print per-phase timing"; `yo compile` has no phase timers at
   all. Every number in the table above was taken by hand with `time`.

## 1. What Zig actually does — and which claim is which

Zig's speed story is three separate things that are easy to conflate.

**1a. The "faster than LLVM" claim is about the self-hosted x86_64
MACHINE-CODE backend, not the C backend.** Zig 0.15.1 made its own x86_64
backend the default for Debug builds, stating compile time "around a 5x
decrease compared to LLVM in most cases" while also admitting it is "known
to emit slower machine code than the LLVM backend"; `-fllvm` opts back in
and ReleaseFast stays on LLVM. The rationale (Loris Cro, 2020) was that
LLVM was "at least 70% of the total compilation time" even for debug
builds where its optimizer buys nothing. Zig's answer was to write a
backend that skips the optimizer entirely. Mitchell Hashimoto's Ghostty
measurement makes the boundary concrete: the part of Ghostty that can use
the self-hosted backend got 66% faster; the LLVM-bound executable got
22% faster from general compiler work.

**1b. The Zig C backend (CBE) is a portability and bootstrap device, and it
is SLOW to consume.** Zig's bootstrap ships `zig1.wasm` (built with every
backend disabled except the C backend), runs it to emit `zig2.c`, and hands
that to the system C compiler; the reported cost of compiling `zig2.c` is
on the order of 11 minutes at `-O2` and 3 minutes at `-O0`. That is the
same shape as Yo's 72 s `-O2` / 18 s `-O0` clang leg on `yo.c`. Zig never
claims CBE is fast; the C compiler is the bottleneck for it exactly as it
is for Yo. So "learn from Zig's C backend to go faster" has no content —
the thing to learn from is what Zig did AROUND its backends.

**1c. Zig's incremental compilation is a frontend design plus a custom
linker, and it does NOT work through the C backend.** From the design
(mlugg, PR #21063 and the 0.14/0.15 notes):

- The unit of work is a **declaration** (an `AnalUnit`: a container
  declaration, a function body, a type), not a file or module.
- Every declaration's untyped IR (ZIR) carries a **source hash**; after an
  edit, only declarations whose hash changed are "outdated". A changed
  function body does not outdate its callers; a changed signature does.
- Semantic analysis records **dependency edges** as it resolves things
  (`src_hash`, `nav_val`, `nav_ty`, `interned`, `namespace`,
  `namespace_name`, `embed_file`), flushed into the InternPool at the end
  of analysis. Invalidation is the reverse closure over these edges, with a
  "potentially outdated" set resolved by re-analysis.
- **Identity is stable across updates**: the InternPool gives every type
  and value an index that survives; when a type's structure changes it is
  recreated at a new index and the old one is kept for lingering
  references. This is the hardest part of the design and the source of
  most of the bugs the notes call out.
- The output side is **in-place binary patching**: with the self-hosted
  linker, each declaration is an independently patchable block, so an
  update rewrites bytes in the existing executable (the demo figure is
  ~0.5 ms per rebuild). This requires owning the linker. The 0.15.1 notes
  say `-fincremental` is "stable enough to be used reliably in combination
  with `-fno-emit-bin`", i.e. for the analysis-only loop, and the PR
  states LLVM and the C backend do not support incremental updates.
- Zig analyzes **only what is referenced** from the root (lazy analysis
  reduces coverage, not just order) — unreferenced code is not
  type-checked, a long-standing complaint that Zig accepts as the price.

**What this means for Yo, stated once:**

| Zig mechanism | Applies to Yo? | Where it lands in this plan |
| --- | --- | --- |
| Debug builds skip the optimizer entirely | **Yes, cheaply** — `-O0` + chunks + no LTO already measured 3.3× on the C leg with identical runtime | Phase 1 |
| Per-declaration source hashing | **Yes** — the lazy-binding pending entries ARE per-definition units | Phase 3 |
| Dependency edges recorded during analysis | **Yes** — `force_pending` on a lookup miss is the hook | Phase 3 |
| Stable identity across updates (InternPool) | **Yes, and it is the prerequisite for everything on the C side** — replaces the `yo_id_N` counter | Phase 2 |
| Keep the process alive (`--watch -fincremental`) | **Yes** — `check --watch` already does; `build`/`test` do not | Phase 4 |
| In-place binary patching | **No** — needs a linker we do not own; a C backend cannot do it. The nearest achievable is per-module TUs + a 0.1 s `-O0` link | Phase 5 |
| A self-hosted machine-code backend | **Out of scope — user decision 2026-09-09** ("too hard to achieve for now"). Zig's x86_64 backend was a multi-year effort and still trails LLVM's code quality; it would also end the single-file portable-C distribution | §10 |
| Lazy analysis that skips unreferenced code | **Open decision** — conflicts with `LAZY_TOPLEVEL_BINDINGS.md` rule 5 (full coverage). Measure first | §6 |

## 2. Goals and non-goals

Goals, each with a number to hit (baseline → target, M4):

| loop | today | target | phase |
| --- | --- | --- | --- |
| self-build after touching a leaf `src/` file, dev profile (`-O0`) | ~155 s (137 eval + 18 C) | **≤ 10 s** | 4 + 5 |
| self-build after touching a leaf `src/` file, `--optimize 2` | ~210 s | ≤ 60 s (eval ≪ ThinLTO link) | 2 + 4 |
| `check --watch` hub edit (`src/token.yo`) | 87 s | proportional to definitions that actually changed, not to 220 importers | 3 |
| `yo test` of one `tests/internal/*.test.yo` (fresh process each) | 1–10 min | minus the prelude+std re-evaluation share (Phase 0 measures it) | 4 |
| chunks dirtied by a one-function edit (N=8) | 8 of 8 | 1 of 8 | 2 |

Non-goals, stated so they are not re-litigated:

- No native backend, no LLVM — **decided by the user 2026-09-09: too hard
  to achieve for now.** The C backend stays the only backend and the
  single-file `yo.c` stays the distribution format
  (`plans/reference/PORTABLE_C_DISTRIBUTION.md`). Every phase below is
  scoped to what a C backend can do.
- No in-place binary patching.
- No change to the language. In particular no change to rule 5 (full
  diagnostic coverage) without the §6 decision.
- The bootstrap fixpoint (stage-2 C ≡ stage-3 C, `cmp` byte-for-byte in
  `scripts/bootstrap/fixpoint_only.sh`) stays a required gate and must
  keep passing at every phase. Content-stable naming makes it easier to
  hold, not harder.

## 3. Phase 0 — instrumentation before anything else

**LANDED 2026-09-10.** `yo compile --profile` prints the per-phase /
per-module table on stderr; `--profile-json <path>` writes the
machine-readable form (module keys are absolute paths, sorted, so the file
diffs cleanly across commits); `yo test --profile` forwards the flag to every
batch-compile child and prints per-file wall lines; `tests/cli-cases/
compile-profile` pins the phase table (values normalized to `<TIME>` by the
CLI harness). The phase walls live around the existing boundaries in
`run_compile` (`src/main.yo`); per-module rows are recorded by the demand
loader (`_load_module_at_abs`, `mm_eval_entry_exprs`, `mm_load_prelude_file`
in `src/module_manager.yo`) as EXCLUSIVE times (nested demand loads
subtracted via a nesting accumulator, so rows sum without double-counting);
the collect/emit split and the function census live in `compile_module`
(`src/codegen/codegen_c.yo`); the shared state is the parallel-array block
in `src/utils.yo`.

### 3.1 The three answers (measured 2026-09-10)

Machine: AMD Ryzen AI MAX+ 395 (32c), WSL2, clang 21.1.7 `-O2`, seed-built
stage-2 at develop `0319bce7c` — **not** the M4, so absolute numbers are
~2.5× the M4's; the RATIOS are the signal. Self-build profile
(`compile src/main.yo --optimize 2 --skip-c-compiler --profile`, JSON kept
at `/tmp/prof-selfbuild.json` when re-measuring):

| phase | seconds |
| --- | --- |
| prelude evaluation | 1.3 |
| read+parse entry | 0.03 |
| entry module evaluation (wall, incl. all demand loads) | 228.7 |
| codegen: collect | 25.0 |
| codegen: emit | 88.3 |
| write C | 0.1 |

1. **Prelude + std is ~6% of evaluation** (1.3 s prelude + 12.7 s summed
   std-module rows of the 228.7 s eval wall; 86 std modules). By the
   decision rule below, **Phase 3 (per-definition invalidation) matters
   more than Phase 4 (resident evaluator)**: the daemon's per-artifact,
   per-test-batch saving on this class of machine is ~14 s, not ~40 s.
2. **`src/` is 93.6% of evaluation** (214.1 s across 309 modules) and
   extremely skewed: `env.yo` 27.2 s, `value.yo` 24.5 s,
   `vendor/markdown_yo/src/data/emoji_data.yo` 20.9 s,
   `evaluator/builtins/comptime_numeric_fns.yo` 15.5 s,
   `vendor/markdown_yo/src/common/entities.yo` 12.8 s — the top five alone
   are ~44% of the eval wall, and vendor/markdown_yo as a whole is 37.1 s
   (16%). Also: `codegen: emit` is 26% of the eval+emit total here, not the
   "minor share" the M4 suggested — the emission split matters on slower
   machines.
3. **Function census:** 8186 functions reach emission; 4351 from std, 3835
   from src+vendor; **0 minted during emission** — every specialization is
   minted during the COLLECTION passes (`collect_required_functions` and
   friends), so Phase 5's "specialization goes with its original's module"
   grouping has no emission-time minting to attribute, and Phase 2's
   specialization naming is complete before body emission starts.

These answers re-order nothing structurally but sharpen the targets: the
220-file hub re-check and the 22-minute `tests/internal` run are dominated
by re-evaluating `src/` modules that did not change — Phase 3's per-
definition dependency tracking is where the 228 s becomes proportional to
the edit.

Every phase below is chosen against the 137 s evaluator number and its
unknown breakdown. Do not guess; measure. This is one PR.

1. **Make `--profile` real.** `yo compile --profile` (and the `yo test
   --profile` that is currently swallowed) prints a per-phase table on
   stderr: lex+parse, prelude evaluation, std module evaluation, project
   module evaluation (split by module, top 20 by time), function
   collection, C emission, chunk assembly, `cc` compile, link. Use
   `Instant.now()` / `elapsed()` (`std/time/instant`) around the existing phase boundaries in
   `run_compile`; no new abstraction.
2. **Per-module evaluation cost table.** Emit it under `--profile` and as
   machine-readable JSON with `--profile-json <path>` so that the numbers
   can be diffed across commits. Keys are absolute module paths.
3. **Answer three questions with it and record the answers in this doc:**
   - what fraction of the 137 s is prelude + std (the part every child
     compile, every test batch, and every artifact re-pays);
   - what fraction is `src/` modules (the part `check --watch` already
     scopes), and how skewed it is per module;
   - how many functions in `function_order` come from std vs `src/`, and
     how many are specializations minted during emission (these have no
     single home module and constrain Phase 2's naming and Phase 5's TU
     grouping).
4. **Gate:** `tests/cli-cases/compile-profile` pins that the table has the
   expected phases (values are `ignore`d — timings are not reproducible).
   Fix the `--profile` help text or remove the flag; do not leave it
   advertised and inert.

Success = the three answers exist. If prelude + std is, say, 40 s of the
137 s, Phase 4's daemon pays that back on every artifact and every test
batch; if it is 10 s, Phase 3 matters more than Phase 4. The order of the
later phases may change on these numbers; the phases themselves do not.

## 4. Phase 1 — a dev profile that skips the optimizer (Zig lesson 1a)

**LANDED 2026-09-10.** `--emit-chunks auto` resolves
`N = clamp(1, cap, emitted_bytes / MIN_CHUNK_BYTES)` from the REAL emitted
size at chunk-assembly time (`compile_module`, `src/codegen/codegen_c.yo`);
`cap` is `YO_JOBS` when usable, else `std/thread.get_hardware_threads()`
(the cross-platform runtime shim that already existed — the plan's
"missing primitive" was `available_parallelism`; the existing API serves).
`MIN_CHUNK_BYTES = 4 MiB`, measured: a 410-line program emits 168 KB whose
shared header is ~20%, so N=4 there costs ~155% of the single-file C work —
every such program stays N=1. `--jobs` now defaults to the auto cap when
`--emit-chunks auto` is given (0-sentinel until parsed), else 8 as before.
`yo build` compiles DEBUG executables (no `optimize` field) with
`--emit-chunks auto` (`compile_artifact`, `src/build_runner.yo`), gated off
for optimized builds, libraries, `emit_c_to` and wasm; `YO_JOBS=1` is the
opt-out. `Executable.emit_chunks` already threaded to the child argv —
CHUNKED_C_EMISSION step 5 had landed it.

Measured on the dev machine (Ryzen AI MAX+ 395, 32c, clang 21):

| self-build C leg, `-O0` | wall |
| --- | --- |
| single file (`--profile`'s `cc compile+link` phase) | 23.9 s |
| `--emit-chunks auto` (N=32, jobs=32, header 12.1 MB; chunk-write→linked) | **7 s** |

Cheap `-O0` flags, measured individually on a 168 KB emission and NOT
adopted: `-fno-asynchronous-unwind-tables` and `-fno-color-diagnostics`
were both inside the ±10% run-to-run noise (309–338 ms baselines), the
latter because cc never colorizes a piped child anyway, and dropping unwind
tables risks the runtime's `backtrace()` diagnostics; `-g` was already
conditional on `--debug-symbols`.

Gates: `chunked-gate` CI job (test.yml) runs
`scripts/bootstrap/chunked_gate.sh` against the shared suite-candidate —
chunking is now a default for something; `tests/cli-cases/compile-emit-chunks`
grew an `auto` line pinning `chunks: 1 unit(s), … (jobs=4)`.

Zig's biggest single win was refusing to run an optimizer on debug builds.
Yo's equivalent is already measured: at `-O0`, chunked parallel compile is
**3.3× faster than single-file (18.25 s → 5.49 s) with identical runtime**,
no ThinLTO is needed, and a warm-cache rebuild's C leg is a 0.13 s link.
Today that configuration exists only as `yo compile --emit-chunks N` typed
by hand.

1. **`std/sys.available_parallelism()`** — the one missing primitive
   (`sysconf(_SC_NPROCESSORS_ONLN)` / `GetSystemInfo`), plus a `YO_JOBS`
   env override read first. Unblocks auto-N, which `CHUNKED_C_EMISSION.md`
   lists as the fourth condition for default-on.
2. **`--emit-chunks auto`**: `N = clamp(1, jobs, emitted_bytes /
   MIN_CHUNK_BYTES)`, with the knee measured at N≈8 and the size floor
   measured so a 1700-line program stays N=1 (the shared-header tax is
   ~27% of such a program's emission).
3. **`Executable.emit_chunks` in `std/build.yo`** — the open item from
   `CHUNKED_C_EMISSION.md` step 5 — threaded through `BuildArtifact` to
   the child argv exactly as `emit_c_to` is.
4. **Dev-profile default:** when `yo build` compiles at `-O0` (the default
   when no `--optimize` is given), it passes `--emit-chunks auto`; at
   `-O1`+ the default stays single-file until §5's naming lands, because
   at `-O2` the ThinLTO link (~24 s) is the floor and chunking only
   returns its 11 s compile. Single-file remains forced for `--emit-c`,
   `--emit-c-to`, `--static-library`, wasm and portable-C, as today.
5. **Cheap `-O0` flags, measured individually before adoption:**
   `-fno-asynchronous-unwind-tables`, dropping `-g` unless
   `--debug-info`, `-fno-color-diagnostics`. Expected single-digit
   percent each; adopt only what measures.
6. **Gates:** the chunked behavioural fixpoint script
   (`scripts/bootstrap/chunked_gate.sh`) becomes a CI job the day chunking
   is a default for anything; `tests/cli-cases/compile-emit-chunks`
   extends to `auto`; the self-build at `-O0` records its C-leg time in
   this doc.

Expected result: the dev-profile self-build's C leg goes from ~18 s to
~5.5 s cold and ~0.1 s warm. This does nothing for the 137 s; it removes
the C leg from the conversation so the remaining phases can be measured
cleanly.

## 5. Phase 2 — content-stable symbol names (Zig lesson 1c: stable identity)

> **LANDED 2026-09-12** (measured numbers below, "Results"). The landed
> scheme differs from the sketch in one respect worth knowing up front:
> fids are position-derived and **unique per mint** (occurrence-indexed),
> not merged per position — merging two derive(Eq) expansions from one
> macro site once shared a fid and emitted Os's body under VcOp's
> signature, so per-mint uniqueness is a correctness requirement, exactly
> like the counter it replaces.

Zig's InternPool gives every declaration an identity that survives an
edit. Yo's `fn_yo_id_<N>` / `__yo_t<N>` names are the opposite: an
identity that depends on how many ids were consumed before it. This one
fact defeats the `.o` cache for ordinary edits, forbids by-module chunk
grouping, and is why fixpoint diffs must be triaged "modulo id
renumbering". It is the prerequisite for Phases 4 and 5 and should land
before them.

Design:

1. **Function C names become a function of WHAT the function is, not WHEN
   it was seen.** For a named definition: `sanitize(module_stem) + "__" +
   definition_path` (e.g. `evaluator_exprs_begin__evaluate_begin_expression`).
   For a specialization: the original's stable name + `"__" +
   fnv1a64(type_key of the specialization's concrete argument types)` —
   the structural `type_key` already exists and is what
   `_g_type_c_name_intern` interns on. For anonymous closures: the
   enclosing definition's stable name + a per-enclosing-definition ordinal
   (stable under edits elsewhere, churns only within the edited
   definition — which is the correct blast radius).
2. **Type C names** likewise: `__yo_t_` + `fnv1a64(type_key)`, with a
   collision check at intern time that falls back to appending the
   interning ordinal and logs the event under `--profile` (expected never;
   a 64-bit FNV over ~10k keys is safe, but the check costs nothing).
3. **`ExprInfo` keys are untouched.** They are process-internal and never
   reach the C; renaming them buys nothing in this phase.
4. **Record the defining module on `CodegenFunctionEntry`.** The evaluator
   knows it; codegen does not. Phase 5's by-module grouping needs it, and
   it is free to carry.
5. **The sanitizer must be total and injective enough:** long names are
   fine for clang; the risk is two different Yo paths sanitizing to one C
   identifier. Reuse `sanitize_for_c_identifier` and add the same
   collision check as (2).

Gates, in order:

- **Byte identity, then stability.** Before editing: record the sha256 of
  the emitted `yo.c` for the self-build and for the language-suite corpus.
  After the change the emissions DIFFER (every name changed), so the gate
  is instead: stage-2 ≡ stage-3 still `cmp`-clean, and the full language
  suite passes on a compiler built from the renamed emission.
- **Edit stability, the actual objective:** emit the self-build twice,
  the second time after adding one unused function to a leaf `src/`
  module. Count differing chunk texts at N=8: today 8 of 8; the gate is
  **1 of 8** (the leaf's chunk under by-name hashing; under Phase 5's
  by-module grouping, the leaf's TU). Then repeat with an edit to
  `src/token.yo` (a hub) and record the number — it is allowed to be
  larger, it must be reported.
- **Fixpoint triage gets simpler:** with stable names a stage-2/stage-3
  diff points at a real divergence, so the "canonicalize `yo_id_\d+`
  before diffing" advice in `PORTABLE_C_DISTRIBUTION.md` can be retired.
  Update that doc when this lands.

Risks: the sanitized name length (clang has no practical limit; the
emitted-C size grows by the longer names — measure, expect low single-digit
percent, and it compresses); debuggability improves rather than regresses
(`lldb` backtraces name the Yo function). Windows COFF has a symbol-name
limit that is generous but not infinite — check `dumpbin`'s constraints
against the longest generated name in the self-build before merging.

### Results (2026-09-12)

What actually landed, module by module:

- **Type C names** — `__yo_t_<fnv1a64(type_key)>` with a `_x<k>`
  collision backstop at intern time (logged under `--profile`), as
  designed. The type keys themselves were made position-stable first:
  module-level `struct`/`enum` declaration ids are
  `stable_position_id` (source-position, merged across re-evaluation
  generations — previously `struct_decl_<ast_expr_id>`, which renumbered
  on any edit earlier in ANY file); CTFE instantiation ids are
  `stable_label_id` (same position, occurrence-indexed per mint).
- **Fids** — `stable_func_id(prefix, module, row, col)`:
  `<prefix>yo_id_<fnv1a64(position)><zero-padded occurrence>`. Every
  former `random_id` fid mint went through it (anonymous functions and
  closures, the function-type forward shells, the recur FuncVal, the
  derive fresh-id clone). The global `random_id` counter is RETIRED —
  zero call sites remain; positionless evaluator-side labels use
  `stable_module_id` (per-(prefix, module) occurrence).
- **Specialization C names** — `function_c_name`: plain fids pass
  sanitized; a spec id (fid + full compile-time signature, kilobytes of
  raw type key) is hashed to `__yo_fs_<fnv1a64(id)>`. The spec id itself
  stays raw (it is the evaluator's cache key and must stay injective);
  only the C name is compressed. Self-build binary 11.2 MB → 9.6 MB.
- **Capture structs** — `capture_<fnv1a64(cap_key)>` (the cap_key
  registry already merges; the hash replaces the counter) with the same
  `_x<k>` collision backstop.
- **Eval temps** — `generate_new_temp_variable_name` keys its hash and
  occurrence counter by the CANONICAL module path (not the 12-byte
  sanitized prefix, which every `file:///home/**` module shares).
- **Async SM fields** — local captures are `var_<name>_<fnv1a64(decl_site)>`
  (`decl_site` = the binding's `module:row:col`), registered centrally at
  SM build; the raw `var_<allocation-counter>` renamed every SM struct in
  the program on any binding change anywhere.
- **`CodegenFunctionEntry.def_module`** and the sanitizer collision
  backstop in `register_function`, as designed.

Gates:

- **Edit stability (the objective):** leaf edit (one function + one new
  exported function in `src/lsp/folding.yo`), N=8: **2 of 8 chunks + 1
  shared-header line** — and every differing line is the edit's own code
  (the new function's body in one chunk, its call site in the edited
  function in another, its forward declaration in `prog_shared.h`; by-name
  hashing legitimately splits one module's code across chunks). Before:
  8 of 8, ~2.3 M differing lines. **Hub edit** (`src/token.yo`):
  **1 of 8 chunks + 1 shared-header line** (165 lines — the edited
  definitions' own re-emissions and specializations; smaller in chunk
  count than the leaf edit because the by-name hash concentrates them).
- **Determinism:** the reverted tree re-emits byte-identical chunks.
- **Self-compile:** the renamed compiler compiles the tree with zero
  clang errors, and the resulting binary works (`--optimize 2`).
- **Language suite:** fast suite identical to clean `origin/develop` —
  3524 passed / 615 failed with BOTH binaries and byte-identical failure
  sets (the 615 are WSL2-local LeakSanitizer artifacts; develop's CI runs
  the same suite with the same sanitizer default and is green — see
  `issues/retired/closure-using-effect-resume-leaks-box.md`).
- `PORTABLE_C_DISTRIBUTION.md`'s canonicalization advice retired below.

## 6. Phase 3 — per-definition dependency tracking (Zig lesson 1c: Dependees)

> **Steps 1+2 landed 2026-09-12** (per-definition source hashes, dependency
> edges at every force/serve/member-read point, and the parse-only
> no-op fast path in the watch round — a comment-only or whitespace-only
> edit now costs a ~5 ms diff instead of the full reverse-closure re-check:
> 222 files / 375 s → 0 files / 5 ms on the `src/token.yo` probe). The
> per-definition INVALIDATION of step 4 (reset + reverse-edge re-force for
> body-only edits) is the remaining piece; a real def change currently
> falls back to today's file-level behavior, which is why the fast path's
> twin gate — a body edit in `src/token.yo` — still measures 375 s. Also
> surfaced and filed on the way:
> `issues/enum-pattern-bool-payload-not-compared.md` (a boolean-literal
> payload in an enum pattern is bound, not compared — `.Some(false)`
> matches `.Some(true)`).

`check --watch` invalidates the reverse IMPORT closure of a changed FILE.
That is the right shape at the wrong granularity: a one-line body edit in
`src/token.yo` re-checks 220 files because they import the module, even
though not one of them depends on the edited body. Zig invalidates by
declaration and by kind of dependency. The lazy-binding machinery makes
the same thing available in Yo with the evaluator's existing hooks.

Design:

1. **Per-definition source hash.** When `evaluate_module` registers a
   pending `::` entry / impl block (`src/evaluator/values/anonymous_module.yo`),
   store the FNV-1a of that definition's token span (from its first token
   to the terminating `;`, whitespace and comments excluded — the lexer
   already drops them). This is Zig's ZIR `src_hash` without the ZIR.
2. **Dependency edges recorded at the force point.** `force_pending` fires
   on a lookup MISS: the currently-evaluating definition (the top of the
   forcing stack, which already exists for cycle detection) needed the
   forced one. Record `(dependent_def, dependee_def)`. Cross-module
   lookups go through the module value's field access; record the same
   edge with the imported module's definition as dependee. Forced-already
   hits must ALSO record the edge (the miss only happens once), so the
   recording point is the lookup, not the forcing.
3. **Signature vs body.** Zig's `nav_ty` vs `nav_val` split is what lets a
   body edit stop at the edited function. Yo's analogue: a `fn`
   definition's hash is split into a signature hash (params, result type,
   where-clauses, effects) and a body hash. A dependent that only CALLED
   the function depends on the signature; a dependent that inlined it
   (`comptime` evaluation, macro expansion, `inline` builtins, a
   `comptime_assert` over its value) depends on the body. The evaluator
   knows which it did at the force point. First cut: record everything as
   body-dependent (correct, over-invalidates), measure, then split.
4. **Invalidation by definition.** `mm_invalidate_document` grows a
   sibling: given the changed file, re-lex, re-hash its definitions,
   compute the set whose hash changed, and invalidate THAT set plus its
   reverse edge closure. Definitions in the same module whose hash is
   unchanged and that are not in the closure keep their evaluated values.
   This is the same purge-and-re-register discipline Phase B2 established,
   applied per definition instead of per module: registry entries
   (`type_trait_methods`, generic impls, GADT, trait defaults, enum
   cfids) get a `(owner_module, owner_definition)` tag.
5. **Type identity — the hard part, handled the way Zig handles it.** A
   re-evaluated `struct` definition produces a new type id; values held by
   unaffected cached definitions still reference the old id. Zig keeps the
   old InternPool index alive and points lingering references at it. Yo's
   rule: a definition that produced a TYPE invalidates every dependent
   (there is no unaffected holder by construction — anyone who named the
   type is a dependee-edge holder from step 2). Fall back to the module-
   level reverse closure for any definition kind the edge recorder does
   not cover yet (macros producing definitions, `derive` rules); that
   fallback IS today's behaviour, so the phase can land incrementally
   with a per-kind allowlist and never be less correct than today.
6. **Cross-module laziness stays a non-goal.** A module is still fully
   evaluated before it is handed to an importer (rule 5). This phase
   changes what is RE-evaluated after an edit, not what is evaluated on a
   cold start.

Gates:

- `tests/internal/check_watch.test.yo` grows: (a) edit a function BODY in
  the imported module of a two-file fixture → only that definition is
  re-evaluated (assert via a debug counter of `force_pending` calls);
  (b) edit its SIGNATURE → the importer's dependent definition is
  re-evaluated too; (c) the same after changing a `struct` field → every
  holder re-evaluates; (d) five edit rounds leave registry sizes flat.
- `check ./src --watch`, hub edit (`src/token.yo`, a body-only change):
  today 87 s. Target: the same order as the leaf edit (~3 s) when only one
  body changed. Record the number here.
- Correctness backstop: a `check --watch` round's diagnostics must equal
  a cold `check` of the same tree. Add `--watch-verify` (debug flag) that
  runs both and diffs; run it over a scripted 20-edit sequence on `src/`
  before merging. Zig's incremental bugs were almost all "stale state
  the invalidation missed"; this is the cheap oracle for that class.

## 7. Phase 4 — keep the evaluator alive across builds and tests (Zig lesson: `--watch`)

The deferred original Phase C of `INCREMENTAL_COMPILATION.md` — reusing
evaluated modules across build invocations — has two possible shapes:
serialize the evaluated state, or never let the process die. The repo
already concluded serialization is "a project, not a patch" (a 7.4 M-live-
`Variable` env graph, `plans/backlog/YO_SELF_ENV_SHARING.md`). Zig's answer
is the same as `check --watch`'s: **a resident process**. `zig build
--watch -fincremental` keeps one compiler alive and re-links on change.
This phase does the same for `build` and `test`.

Design:

1. **Lift the fresh-`ExprInfoTable` invariant — the real work.** The 47
   "Failed to transpile" stubs on a second in-process compile came from
   stale `ExprInfo` and stale fid-keyed function registries
   (`function_value.yo`) being read by codegen. With Phase 3's per-
   definition invalidation, an invalidated definition's `ExprInfo`
   entries are purged with it (tag entries by owner definition at
   allocation; `alloc_global_expr_id` runs under a known owner), and the
   fid-keyed registries get the same owner-tagged purge Phase B2 gave the
   trait registries. Gate: two consecutive in-process `run_compile`s of
   `src/main.yo` produce `cmp`-identical C with zero FTT markers — this is
   the 47-stub experiment re-run, and it must be zero, not "fewer".
2. **`yo build --watch` compiles in-process.** Today each round shells out
   per artifact; after (1) the artifact compile is a function call against
   the warm module cache, and the Phase A stamp still decides whether an
   artifact needs it at all. The `cc` leg stays a child process.
3. **`yo test` batches compile in-process under one evaluator.** This is
   the largest wall-clock consumer in the repo (22 min for
   `tests/internal`; every batch re-evaluates prelude + std). After (1)
   the runner evaluates prelude + std once and each batch's import
   closure on top. The compiled binaries still run in child processes with
   ASan as today. Gate: `yo test ./tests/internal` wall time, before and
   after, in this doc; the hollow-batch check (`__yo_user_main` is a real
   body, not a "Failed to transpile" comment) stays mandatory because an
   in-process regression would present exactly as hollow batches.
4. **Memory is the constraint Zig does not have.** A self-build's
   evaluator peaks at 11–20 GB (`yo-one-heavy-job-at-a-time`,
   `YO_SELF_ENV_SHARING.md`). A resident process that accumulates
   generations must purge, not just invalidate — Phase 3's owner-tagged
   purges are the mechanism, and `--watch` gets a `--max-rss-mb` valve
   that restarts the process cleanly when exceeded (the "counter-triggered
   self-restart valve" already noted as the fallback in
   `INCREMENTAL_COMPILATION.md`). Report RSS per round under `--profile`.
5. **No daemon yet.** A background `yo` server that ordinary `yo build`
   invocations talk to is the Zig-adjacent endgame (and what an IDE build
   integration wants), but it adds a protocol, lifecycle and a staleness
   surface. `--watch` gives the same speedup for the developer sitting at
   the tree. Revisit after (1)–(4) have run for a release.

Expected result on the dev-profile self-build after a leaf edit: the
evaluator re-does the changed definitions plus their closure (Phase 3),
re-emits everything (emission is a minor share of the 137 s — Phase 0
quantifies it), recompiles the dirty TU (Phase 5) and links in 0.1 s.
That is the ≤ 10 s target in §2.

## 8. Phase 5 — per-module translation units (the C backend's version of patching)

With Phase 2's stable names, `fnv1a(c_name) % N` is no longer the only
edit-stable grouping: functions can be grouped by **defining module**, so
an edit dirties one TU. This is as close as a C backend gets to Zig's
per-declaration patching — the unit is a module rather than a
declaration, the "patch" is recompiling one `.o` at `-O0` (~0.1–1 s for a
typical `src/` module) and re-running a 0.1 s link.

1. **Grouping = defining module**, from the field Phase 2 added to
   `CodegenFunctionEntry`. Specializations minted during emission go
   with the module of their ORIGINAL (the generic definition), not the
   caller; Phase 0's count says how large that bucket is.
2. **Balance.** `CHUNKED_C_EMISSION.md` rejected by-module grouping
   because module sizes differ by orders of magnitude (`expr.yo` vs a
   leaf), which makes the slowest job the wall clock on a COLD build.
   Resolution: by-module for the `.o` cache's sake, then pack modules into
   `jobs` bins by emitted size for the cold path (largest-first); a bin is
   still a stable unit as long as membership is a deterministic function
   of (module set, sizes) — record the packing in a stamp so the warm path
   recompiles a bin only when its member set or any member's text changed.
3. **The shared header tax** grows with N; by-module N would be ~260 for
   the self-build, which is why binning matters. Measure aggregate CPU
   and wall at bins = jobs vs 2×jobs, as the earlier N sweep did.
4. **`-O2` stays single-file by default** until ThinLTO-with-cache is
   measured: with LTO the link is the 24 s floor and is not cacheable, so
   per-module TUs buy little there. The dev profile is the target.

Gate: one-function edit in a leaf `src/` module, dev profile, warm cache
→ "1 to compile, N−1 cached" in the driver's report, and the fixpoint
script still `cmp`-clean on the single-file default emission.

## 9. Open decision — reachability-driven evaluation for `compile` (Zig's lazy analysis)

Zig type-checks only what is reachable from the root. Yo's rule 5
deliberately does the opposite so `check` and the LSP report every
diagnostic. These are compatible if the two commands differ: `check`
keeps full coverage; `compile`/`build` could evaluate only what codegen
will reach. Whether that is worth having depends on a number Phase 0
produces — how much of std's evaluation cost is spent on definitions the
program never uses. If it is large, the decision is the user's: it trades
"a broken unused function in std fails every build" for build time, and
Zig's experience says users are surprised by it. Not proposed here; parked
until the number exists.

## 10. What is explicitly rejected, with the reason

- **A self-hosted native backend (user decision, 2026-09-09).** Zig's x86_64 backend took years, still
  emits slower code than LLVM, and Zig kept LLVM for release builds. Yo
  would lose the portable-C distribution that lets a C compiler alone
  bootstrap it (`scripts/make-portable-c.sh`). The 5× Zig reports for
  Debug is approximated for Yo by Phase 1's `-O0` chunked path at ~3.3× on
  the C leg, which is not the dominant cost anyway.
- **Serializing evaluated modules to disk.** The env-graph snapshot
  problem stands; the resident-process route delivers the reuse without
  it.
- **A faster C compiler for dev builds (tcc and friends).** The emitted
  C uses `_Thread_local`, `_Atomic`, `_Alignas`, compound literals,
  `__attribute__`s and the async runtime's platform headers; a second
  compiler's C11 subset would become a compatibility surface. Not worth
  it while the C leg is 18 s → 5 s at `-O0` with clang.

## 11. Sequencing and risk

| phase | depends on | size | main risk |
| --- | --- | --- | --- |
| 0 instrumentation | — | days | none; do first |
| 1 dev profile | 0 (for the size floor) | ~1 week | default-on regressions on small programs — auto-N floor |
| 2 stable names | — | ~1–2 weeks | name collisions; Windows symbol limits; every golden that hashes emitted C re-records |
| 3 per-definition deps | 2 not required, 0 recommended | 3–4 weeks | stale-state bugs — the `--watch-verify` oracle is mandatory |
| 4 resident evaluator | 3 | 2–3 weeks | memory growth; the fresh-table invariant |
| 5 per-module TUs | 2, 1 | ~1 week | cold-build balance |

Phases 1 and 2 are independent and can proceed in parallel. Phase 3 is the
deep cut and the one Zig's history says will take longest to make
trustworthy; it is also the one that turns the 137 s into something
proportional to the edit. Each phase ends by writing its measured numbers
into §0 of this document; when all five have landed, this doc graduates to
`plans/reference/` with those tables as the record.

## Sources

Zig facts above are taken from:

- Zig 0.15.1 release notes — x86_64 backend default for Debug, "around a
  5x decrease", 1984/2008 behaviour tests, `-fincremental` +
  `--watch` status: https://ziglang.org/download/0.15.1/release-notes.html
- Zig 0.14.0 release notes — incremental compilation and the x86 backend
  as the two edit-cycle investments: https://ziglang.org/download/0.14.0/release-notes.html
- mlugg, "Incremental compilation progress", ziglang/zig PR #21063 —
  AnalUnit, Dependee kinds, ZIR source hashes, type identity across
  updates, backend support: https://github.com/ziglang/zig/pull/21063
- mlugg, "Inside Zig's Incremental Compilation":
  https://mlugg.co.uk/posts/incremental-compilation-internals/
- Loris Cro, "Zig's New Relationship with LLVM" — LLVM ≥ 70% of compile
  time, in-place binary patching rationale:
  https://kristoff.it/blog/zig-new-relationship-llvm/
- Mitchell Hashimoto, "Zig Builds Are Getting Faster" — Ghostty
  measurements 0.14 → 0.15.1: https://mitchellh.com/writing/zig-builds-getting-faster
- Zig bootstrap flow (`zig1.wasm` → `zig2.c` → system C compiler):
  https://ziglang.org/news/goodbye-cpp/ and the `zig2.c` compile-time
  report in https://github.com/ziglang/zig/issues/22111
- In-place patching demo figure (~0.5 ms):
  https://forum.dlang.org/thread/ctelroirrkqpkrlupajp@forum.dlang.org
