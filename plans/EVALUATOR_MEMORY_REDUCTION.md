# Evaluator memory reduction — audit and implementation plan

**Status: ACTIVE 2026-09-25 — `check src/main.yo` 19.9 → 2.59 GB over the campaign (Linux max RSS 2.49 GB, ratcheted); the missing-release hunt is closed (§0.10: zero-hit roots 32 K + 748 + 209 → 0 + 4 + 0 via #893 and #904). Landed: Phase 0 steps 1/4/5, Phase 1 steps 1/4 (#805, #807), Phase 2/F3 (#814), Phase 7 incl. the ExprInfo diet (#817), the value-cell change (#825). 2026-09-24 (§0.5): the exit heap walk found the "untouched" TypeValue cluster was a LEAK — a `match`/`cond` passed as a call argument never released its result, and `_substitute_at`'s `intern_type(match(...))` leaked every rebuilt node: 9.86 → 6.84 GB (−31%) with the codegen fix (`issues/fixed/match-or-cond-call-argument-result-is-never-released.md`); the frame name index no longer keeps a list per name: 6.84 → 5.96 GB (§0.6); definition-site FuncVals read capture names/types from their shared handles: 5.96 → 5.47 GB (§0.7); 2026-09-25 (§0.8): every `HashMap` rehash leaked one reference per RC key/value — a `cond` arm rendering `unsafe.drop(...)` was never emitted — 5.54 → 2.59 GB (−53 %) (`issues/fixed/cond-unit-arm-statement-is-dropped.md`). (§0.9) Three expression-position shapes left a call's argument temp unreleased — struct-literal tails (#888), operator operands in `if` conditions and in `cond`/`match` arm values (#891): 1.1 M leaked strings at `check` exit. (§0.11) `compile`'s shared table kept every executed CTFE clone's metadata: 1.56 GB, now dropped when the call returns — compile front half 6.70 → 5.07 GB (#913). (§0.12) Synthesized tokens copied their module's whole source text: `check src/main.yo` 2,504 → 2,159 MB (#915). (§0.13) Derived FuncVals take only their parent's aligned handles and store no flat capture names/types: 2,069 → 1,551 MB. Landed since: Phase 0 step 6 (the CI memory ratchet, #872) and step 3c (the holder census, §0.6/§0.10/§0.12). Still open: Phase 0 step 2, Phase 1 steps 2/3/5, Phases 3, 4, 5b, 6; Phase 5a is superseded (§0.5). Next: re-take the exclusive shares on the §0.13 compiler (the remaining derived copies are one value list and one handle prefix each — §0.7's full prefix sharing), then the `Variable` diet / header / `Option(ref)` layout work.** Originally: audit complete, nothing implemented. Written
after measuring the current tree (§0) and re-reading every earlier memory
campaign (§3). Companion research: `backlog/ARENA_ALLOCATOR_FEASIBILITY.md`
(whether an arena allocator can help; short answer: not with this problem).

The one-paragraph version: the evaluator's footprint is **retention of live
metadata, not allocation churn**. Every expression ever evaluated leaves a
456 B `ExprInfo` plus its own `Environment` snapshot in a table that is a
process-lifetime root; every specialization re-evaluates a fresh-id clone of
its body and adds a full set of them; every binding ever made leaves a 224 B
`Variable`; every one of those objects — and every `ArrayList` whose element
type can form a cycle — carries a 56 B cycle-collector header. `yo check
src/main.yo` — evaluator only, no C emitted — now peaks at **19.3 GB** on this
tree (§0.1), and the per-type census (§0.4) finds **130 M live objects /
13.3 GB of struct bytes still reachable at exit**: the peak IS the retained
set. The self-emit (`compile --emit-c`) peaks at 22.3 GB, so the evaluator is
~87% of the compile footprint too. The plan
attacks the count of retained objects first (Phases 1–2, no layout change, C
output byte-identical), then the per-object cost (Phases 3, 5, 6), and treats
the specialization population and the super-linear compile-cost bug as the
two investigations that decide the second half (Phases 4, 7).

---

## 0. Baseline (measured 2026-09-20)

### 0.1 Numbers

Mac Mini M4, 16 GB, `yo 0.2.37` (the published seed), tree `develop` @
`49d75c665`, `--std-path ./std`. Two peer `yo build` processes were running
during every measurement below, so **wall times are unreliable; the peak
footprints are not** (phys_footprint is per process; the compressor charges
compressed pages at compressed size, so memory pressure can only shrink it).

| command                                            | peak memory footprint | wall   | notes                                                          |
| -------------------------------------------------- | --------------------- | ------ | -------------------------------------------------------------- |
| `yo check ./src` (275 files, one process)          | **20.17 GB**          | 378 s  | max RSS 2.9 GB — clamped by paging; `sys` 43 s                 |
| `yo check src/main.yo` (single entry, whole closure)| **19.33 GB**         | 345 s  | so the directory walk is NOT the accumulator — one entry is    |
| `yo check ./src/types` (13 files)                  | 7.13 GB               | 45 s   |                                                                |
| `yo compile src/main.yo --emit-c --skip-c-compiler --optimize 2` | **22.27 GB**  | 738 s  | evaluator + codegen, no clang; the check is 87% of this peak   |
| `yo check std/collections/array_list.yo`           | 0.30 GB               | 1.1 s  |                                                                |
| `yo check std/prelude.yo`                          | 0.25 GB               | 0.7 s  | the prelude alone                                              |
| `yo check hello.yo` (prints one line)              | 0.49 GB               | 1.8 s  | the floor: prelude preload + `std/fmt` closure                 |

The floor across published seeds, each checking the same `hello.yo` against
its OWN bundled std (an apples-to-apples time series of "prelude + std/fmt"):

| seed   | 0.2.19  | 0.2.24  | 0.2.29  | 0.2.30  | 0.2.31  | 0.2.37  |
| ------ | ------- | ------- | ------- | ------- | ------- | ------- |
| floor  | 0.27 GB | 0.28 GB | 0.42 GB | 0.60 GB | 0.52 GB | 0.49 GB |

The floor doubled between 0.2.24 and 0.2.30 and has been flat since; the floor
is not where the 19 GB is.

### 0.2 The historical ledger this extends

Every number below is from a plan that measured it (file cited). "footprint"
is macOS phys_footprint; "tracked live" is the allocator-boundary instrument of
`backlog/RC_HEADER_SPLIT.md` (sum of `malloc_size` over live blocks).

| date       | job                                  | result                                                       | source                                     |
| ---------- | ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------ |
| 2026-08-05 | self-emit (TS vs yo-self r16)        | 6.05 GB vs 9.08 GB footprint; yo-self retires 31% FEWER instructions — it stores more, not computes more | `backlog/YO_SELF_ENV_SHARING.md` |
| 2026-08-05 | ExprInfo env prune (REJECTED)        | released 3.08 M envs, −1.13 GB only, +80% wall, emitted C changed | `archive/YO_SELF_EXPRINFO_PRUNE.md`    |
| 2026-08-17 | def-time env sharing                 | 14.55 → 12.21 GB footprint, 678 → 232-283 s                  | `backlog/YO_SELF_ENV_SHARING.md` §3        |
| 2026-08-17 | RC header split (16 B small header)  | 12.21 → 11.53 GB footprint; tracked live ~19 GB before/after — the metric hid a real −2.6 GB of zero-heavy bytes | `backlog/RC_HEADER_SPLIT.md` |
| 2026-08-17 | **`check` closure vs emit**          | **1.89 GB vs 12.2 GB — "~85% of footprint is emission-phase specialization structures"** | `backlog/YO_SELF_ENV_SHARING.md` §3 |
| 2026-08-18 | `_inject_forall_captures` memo       | tracked live 19.07 → 14.94 GB (−4.1 GB), wall −35%           | `backlog/RC_HEADER_SPLIT.md`               |
| 2026-08-18 | ExprInfo accessor diet (REFUTED)     | diet binary −1.8 GB on same input, diet SOURCE +3.9 GB to compile (~10 MB retained per new call site) | `backlog/RC_HEADER_SPLIT.md` |
| 2026-08-23 | FuncVal env sharing (steps 2+3)      | 17.19 → 16.08 GB footprint (self-emit, seed compile)         | `backlog/FUNCVAL_ENV_SHARING.md`           |
| 2026-08-24 | one 5-line debug probe               | seed compile 17.5 → 29.1 GB, +2.9× wall, probe never fires   | `issues/fixed/debug-probe-line-costs-gigabytes-at-compile-time.md` |
| 2026-09-20 | `check src/main.yo`                  | **19.33 GB** (this document)                                  | §0.1                                       |

Read the two bold rows together: five weeks ago the evaluator-only `check` was
1.9 GB and codegen-driven specialization was the other ~10 GB. Today the
evaluator-only `check` is 19.3 GB. Either `check` now performs the work that
used to happen only under codegen (the lazy-binding forcing walk, def-time body
trials for every definition, contract lowering — `reference/LAZY_TOPLEVEL_BINDINGS.md`
landed 2026-09-05 and `backlog/FORMAL_VERIFICATION.md` V1–V7 landed in the same
window), or something regressed. **Phase 0 step 2 settles this with a per-release
bisect before anything is optimized**; the rest of this plan does not depend on
the answer because every lever below removes objects that are retained under
BOTH commands.

### 0.2b Phase 0 step 5 — the per-release series, and the answer (2026-09-20)

`check src/main.yo --std-path ./std`, each tag's own tree with its own seed
binary (v0.2.31 has no bundle on this machine), plus the develop commits since
the v0.2.38 tag with the v0.2.38 binary:

| tree                  | footprint    | wall   | note                                   |
| --------------------- | ------------ | ------ | -------------------------------------- |
| `v0.2.37`             | 19.35 GB     | 162 s  |                                        |
| `v0.2.38`             | 19.92 GB     | 170 s  |                                        |
| `24fcd192f` (#802)    | 19.90 GB     | 170 s  |                                        |
| `7eada73f8` (#800)    | **31.55 GB** | **350 s** | seven gated debug probes             |

So the §0.1 baseline (19.33 GB on `49d75c665`) was flat across the last two
releases, and the SAME afternoon #800 added 11.6 GB. The cause is F8, now
root-caused: **one template string with ten interpolations**. Template
strings fold into a left-nested `.+` method chain and the evaluator costs
~4× per chain level (receiver evaluated once to resolve the method and again
as the `self` argument, compounding) — a 15-line program with a
10-interpolation template checks at 10.7 GB / 67 s
(`issues/fixed/debug-probe-line-costs-gigabytes-at-compile-time.md`, with the growth
curve and the isolation table in
`issues/fixed/seven-gated-debug-probes-cost-11-gb-of-check-memory.md`). The
probes are removed in Phase 1's PR; the evaluator fix is Phase 7, promoted to
run right after Phase 1 because every `a.f().g().h()` chain in user code pays
the same curve.

**F3 correction (audit by grep was wrong).** Stored snapshots ARE mutated:
65 sites re-adopt a recorded env's frame LIST by handle
(`env.frames = info.env.frames;` — the TS-era "env = info.env" idiom), after
which a `push_env_frame` on the live env writes into that snapshot's list.
Snapshot sharing therefore needs the adoption sites to take a COPY
(`copy_frames`), otherwise one push would rewrite every sharer's recorded
scope; Phase 2 below is amended accordingly, and only `new_expr_info`'s two
snapshot sites share (the 19 other `snapshot_env` callers build scratch envs
they go on to mutate).

### 0.2c Phase 1 measured (2026-09-20)

Same source tree both sides (`24fcd192f`, probe-free), `check src/main.yo
--std-path ./std`, quiet machine:

| binary                                                   | footprint    | wall   |
| -------------------------------------------------------- | ------------ | ------ |
| seed v0.2.38                                             | 19.90 GB     | 170 s  |
| Phase 1 (walk `ctx` released, spec-cache `env` removed) + #804 | 17.61 GB | 145 s |
| + the F8 fix (receiver evaluated once per call)          | **10.16 GB** | **90 s** |
| same binary on the #800 tree (the seven probes present)  | 10.16 GB     | 90 s   |

F1 is worth **2.3 GB (11.5%)**: the per-module tables of finished walks are
one holder among several. **The F8 fix is worth another 7.4 GB and 55 s on
the compiler's own source** — `src/` has a 19-deep method chain
(`lsp/server.yo:257`, the capabilities JSON builder), two 8-interpolation
templates and dozens of 5–7-deep chains, each of which cost 2^depth
evaluations — and it makes the seven #800 probes free (31.55 → 10.16 GB on
that tree). Together: the evaluator's footprint on `check src/main.yo` is
**halved** (19.9 → 10.2 GB) and wall time −47%, with the emitted C unchanged
(fixpoint holds; the seed-vs-new emit comparison is recorded below when it
lands). The rest of the live set is reachable from the module cache
(function values → bodies → their def-time `ExprInfo`s through
`g_funcval_def_envs` and the specialization caches); Phase 0 step 3's holder
attribution remains the measurement that ranks what is left.

### 0.2c′ What #805 broke on develop (2026-09-21, fixed the same day)

The Phase 1 PR turned three `tests/internal` CI shards red (run 35520237279),
for two unrelated reasons, both fixed in the follow-up PR:

- **F1's context release** assumes every re-forcing caller declared itself a
  watch session. `main.yo` does for `check --watch`, `lsp/server.yo` for the
  LSP; the in-process watch driver in `tests/internal/check_watch.test.yo`
  did not and hit the new internal error. Now the test declares itself, and
  `mm_revalidate_plan` treats a released context as "not per-def-able"
  (file-level reload) instead of an internal error mid-round
  (`issues/fixed/in-process-watch-drivers-lost-their-walk-contexts.md`).
- **A pre-existing codegen bug** the Phase 0 instrument exposed:
  `(g_node_eval_counting : bool) = debug_knob(...).is_some();` is the first
  module-level initializer in `src/` whose method specialization is used
  nowhere else, and the function collector never walked module-level
  initializers, so the statement degraded to a stub that swallowed the next
  declaration (`issues/fixed/module-level-init-callees-are-never-collected.md`).
  The self-build was green only because `main.yo`'s import closure happens
  to use `Option(String).is_some()` elsewhere.
### 0.2d Phase 0 step 4 measured — the specialization population (2026-09-21)

`YO_SPEC_REPORT=1 yo check src/main.yo --std-path ./std` on the Phase 1 tree
(24fcd192f + PR #805), 10.75 GB / 102 s:

| Counter | Value | Meaning |
| --- | --- | --- |
| `cloned_nodes` | 1,303,246 | AST nodes minted by `clone_expr_fresh_ids` (every cache MISS clones the whole body) |
| `node_evaluations` / `distinct_nodes` | 1,951,270 / 1,812,574 | the evaluator touched 1.81 M distinct nodes; after the F8 fix no node is evaluated more than 8× |
| `specializations` | 10,357 over 61 fids | call-site specializations, cache HITS included (`record_fid_spec` fires whenever the resolved fid differs from the generic one) |
| `runtime_calls` | 43,369 | runtime dispatches counted for the supersession rule |

Top of the table (names recovered from the emitted C's mangled suffixes):

| specs | fid | what it is | distinct emitted bodies |
| --- | --- | --- | --- |
| 3,501 | `yo_id_10369372665995140176…` | the prelude's bool `!` operator (`fn(T, self : T) -> T`) | 1 |
| 3,133 | `yo_id_764922425204514452…` | `ArrayList(T).new()` | ~20 (one per element type) |
| 532 / 460 / 422 | `…5533302169…`, `…10235496796…`, `…13402457958…` | `HashMap` slot helpers and a `Result`/`Option` constructor over `String` | few |

Reading: the top two fids are 64 % of all specializations and collapse to a
handful of emitted functions, so the population is dominated by REPEATED
call-site resolution of the same instantiation. Those repeats are cache hits
and cost no clone — the 1.30 M cloned nodes come from the ~10 k misses at
~130 nodes each (generic std bodies are small; the compiler's own generic
helpers are the fat tail). Consequences for Phase 4:

- Design 1 (no AST clone per specialization) targets 1.30 M `AstExpr`s plus
  their `ExprInfo`s — roughly 42 % of everything the evaluator evaluated. It
  is the larger of the two designs by population and stays the candidate.
- Design 2 (discard generic-body trial infos) targets only the 61 generic
  ORIGINAL bodies' def-time infos — a few thousand nodes. Not worth a phase
  on its own; fold it into Design 1 if that lands.
- The cache-hit count is not a memory lever, but 3,501 resolutions of `!`
  is a TIME lever: `_find_specialization_cache` is a linear scan over
  `g_specialized_fn_caches` (61 entries) then over each entry's caches,
  comparing type keys. Measure before touching; a fid-keyed map is the
  obvious shape.

### 0.3 How to measure (the rules that bit earlier campaigns)

- **Peak footprint, never RSS.** `/usr/bin/time -l <cmd>` → `peak memory
  footprint`. On a 16 GB machine RSS clamps (§0.1 shows 2.9 GB RSS for a 19 GB
  process). "GB" in this document is decimal.
- **Footprint is compressor-noisy for zero-heavy heaps.** For an A/B of a lever
  that deletes NULL-heavy bytes (headers, `Option` fields), measure **tracked
  live bytes** with the allocator-boundary shim (Phase 0 step 1 makes that
  script durable) — `RC_HEADER_SPLIT.md` shows footprint under-reporting a
  2.6 GB win by 1.9 GB.
- **Quiet machine.** Peer builds distort wall time and, past ~16 GB, force
  paging that inflates `sys` and can kill the run. Never A/B while a sweep or
  build runs (memory note "never measure during a sweep").
- **Same source both sides of an A/B.** The lever's own source edit changes the
  compiler's compile-time cost (the diet refutation was exactly this: the
  binary won, the source lost). Measure a lever as a 2×2: {old, new binary} ×
  {old, new source} when the lever touches `src/evaluator` hot paths.
- **Every lever must keep the emitted C byte-identical** unless the plan says
  otherwise (Phase 3's niche change legitimately shifts it): the rejected
  prune was caught only because its output differed.

---

### 0.4 The exit-live census (2026-09-20, instrumented compiler)

`scripts/bootstrap/live_census_t.py` (this PR) over a fresh emission of the
same tree, compiled with `clang -O1`; +1 per constructor, −1 per installed
`dispose_fn`, dumped at exit. Footprints of the instrumented runs matched the
uninstrumented ones (0.49 / 7.13 / 19.43 GB), so the counters did not perturb
the shape. Struct bytes exclude raw buffers (`ArrayList` backing stores,
HashMap tables) and allocator overhead; adding those (~22.6 M byte-strings
alone) closes the gap to the footprint.

| run                     | live objects at exit | live struct bytes | gross constructions | peak footprint |
| ----------------------- | -------------------- | ----------------- | ------------------- | -------------- |
| `check hello.yo`        | 2.84 M               | 0.20 GB           | 16.3 M              | 0.49 GB        |
| `check ./src/types`     | 48.6 M               | 5.14 GB           | 388 M               | 7.13 GB        |
| **`check src/main.yo`** | **130.5 M**          | **13.32 GB**      | **1.59 B**          | **19.43 GB**   |

`check src/main.yo`, top rows (`live × sizeof`; enum rows are labelled by the
emitter's `<enum:…>` comment — `expr_r335c2` = `AstExpr`, `value_r45c2` =
`EvalValue`, `definitions_r110c2` = `TypeValue`):

| type                                   | live       | gross     | sizeof | live bytes  |
| -------------------------------------- | ---------- | --------- | ------ | ----------- |
| `ExprInfo`                             | 7.35 M     | 11.5 M    | 440    | **3.23 GB** |
| `Variable`                             | 10.15 M    | 14.7 M    | 192    | 1.95 GB     |
| `TypeValue`                            | 7.76 M     | 16.4 M    | 176    | 1.37 GB     |
| `ArrayList(TypeValue)` (tracked, 80 B) | 11.57 M    | 129.8 M   | 80     | 0.93 GB     |
| `ArrayList(u8)` (strings)              | 22.65 M    | 729.6 M   | 40     | 0.91 GB + buffers |
| `Environment`                          | 7.30 M     | 14.3 M    | 112    | 0.82 GB     |
| `Token`                                | 6.68 M     | 13.9 M    | 104    | 0.69 GB     |
| `AstExpr`                              | 10.72 M    | 13.4 M    | 64     | 0.69 GB     |
| `ArrayList(EvalValue)` (value cells)   | 8.09 M     | 12.4 M    | 80     | 0.65 GB     |
| `ArrayList(Frame)` (env snapshots)     | 7.25 M     | 14.4 M    | 80     | 0.58 GB     |
| `ArrayList(usize)`                     | 11.98 M    | 136.3 M   | 40     | 0.48 GB     |
| `ArrayList(ArrayList(TypeValue))`      | 3.22 M     | 3.2 M     | 80     | 0.26 GB     |
| `EvalValue`                            | 1.82 M     | 15.2 M    | 96     | 0.18 GB     |
| `ArrayList(AstExpr)`                   | 3.94 M     | 23.8 M    | 40     | 0.16 GB     |
| `ArrayList(String)`                    | 3.45 M     | 103.6 M   | 40     | 0.14 GB     |
| `ArrayList(ArrayList(String))` (paths) | 3.40 M     | 6.0 M     | 40     | 0.14 GB     |
| `Box(Token)`                           | 1.45 M     | 1.45 M    | 24     | 0.03 GB     |
| `Frame`                                | 0.34 M     | 3.0 M     | 96     | 0.03 GB     |
| `ExprInfoRare`                         | 0.10 M     | 0.5 M     | 240    | 0.02 GB     |
| `SpecializedFunctionCache`             | **3,134**  | 3,134     | 88     | —           |

What the census settles:

- **`ExprInfo` : `Environment` : `ArrayList(Frame)` = 7.35 : 7.30 : 7.25 M.**
  The 1:1:1 population F3 predicts; the snapshot pair is 1.40 GB of struct
  bytes plus one 8·depth-byte buffer each, all removable by sharing.
- **Clusters** (struct bytes only): ExprInfo + env snapshots + path lists
  **4.93 GB**; TypeValue + its child/level/label lists **3.03 GB**; Variable +
  value cells **2.60 GB**; AST (`AstExpr` + `Token` + arg lists) **1.57 GB**;
  byte-strings 0.91 GB + buffers.
- **Headers: 83.0 M objects carry the 56 B tracked header = 4.65 GB** (35% of
  all struct bytes); 45.5 M small-header lists carry 0.73 GB. Every
  `ArrayList` whose element type is cycle-capable (`TypeValue`, `EvalValue`,
  `Frame`, `ArrayList(TypeValue)`) is itself tracked and 80 B, not 40 —
  30 M of the tracked objects are such lists.
- **The specialization CACHE is tiny** (3,134 entries): F2a (its retained
  `env`) is hygiene, not a lever. The specialization COST is the bodies it
  re-evaluated — `AstExpr` live (10.7 M) is ~5× a plausible source-node count,
  `ExprInfo` live 7.35 M — and those are counted under F2/F3.
- **Churn is enormous and irrelevant to the peak**: 1.59 B constructions,
  130 M live. `ArrayList(TypeValue)` alone was built 130 M times for 11.6 M
  survivors; `ArrayList(u8)` 730 M times. The allocator absorbs it; only the
  survivors cost footprint (F9 confirmed).
- Still open (Phase 0 step 3b): WHICH ROOT retains each survivor. The
  per-type census cannot tell a `Variable` held by a walk's table from one
  held by a def-env registry; the holder-attribution walk remains the next
  measurement.

---

## 1. Where the bytes are: the data model

Sizes are `sizeof` on the emitted C (arm64), taken from the 2026-08 censuses and
re-derived from the field lists in the current source; the 56 B / 16 B header
choice is read from the constructors in the emitted C (§1.3). Phase 0 re-counts
them with the durable census; treat the counts as ceilings until then.

### 1.1 The core objects

`sizeof` is read from the 2026-09-20 census binary (arm64); populations are
the `check src/main.yo` exit-live counts (§0.4).

| type (file)                               | sizeof | header | why it is this size                                                                                                                                         | live at exit |
| ----------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `ExprInfo` (`src/expr_info.yo`)           | 440 B  | 56 B   | 3 required handles + **24 `Option(...)` fields at 16 B each** (tag + payload; no niche for ref handles); 19 of 24 are ≤2.5% occupied at exit               | 7.35 M (3.23 GB) |
| `Environment` (`src/env.yo`)              | 112 B  | 56 B   | `frames : ArrayList(Frame)` + 2 Strings + `Option(usize)`; **one per `ExprInfo`** — `new_expr_info` calls `snapshot_env`, which allocates a fresh list too | 7.30 M (0.82 GB) + 7.25 M frame lists (0.58 GB) |
| `Variable` (`src/env.yo`)                 | 192 B  | 56 B   | 10 handles/ints + `ArrayList(EvalValue)` value cell + 10 grouped bools; `value` is a separate 80 B tracked list when the binding has a comptime value       | 10.15 M (1.95 GB) + 8.09 M value cells (0.65 GB) |
| `TypeValue` (`src/types/definitions.yo`)  | 176 B  | 56 B   | `ref(enum)`, ~40 variants; the size is the largest variant's payload (`TraitT`/`SomeT`: 10-11 handles); each node owns 1-6 `ArrayList`s                    | 7.76 M (1.37 GB) + 11.6 M child lists (0.93 GB) + 12 M usize lists (0.48 GB) |
| `AstExpr` (`src/expr.yo`)                 | 64 B   | 56 B   | `FnCall(id, func, args, is_infix, token)`; specialization deep-clones bodies with fresh ids (`clone_expr_fresh_ids`, 54 call sites)                        | 10.72 M (0.69 GB) |
| `Token` (`src/token.yo`)                  | 104 B  | 56 B   | 8 fields incl. 3 Strings (`value`, `module_path`, `input`); `Token.clone` returns self                                                                       | 6.68 M (0.69 GB) |
| `EvalValue` (`src/value.yo`)              | 96 B   | 56 B   | `ref(enum)`, 20 variants                                                                                                                                    | 1.82 M (0.18 GB) |
| `ArrayList(T)` (std), cycle-capable `T`   | 80 B   | 56 B   | `_ptr, _length, _capacity` + the TRACKED header, because a list of `TypeValue`/`EvalValue`/`Frame` handles can sit on a cycle                              | 30.1 M (2.4 GB) |
| `ArrayList(T)` (std), other `T`           | 40 B   | 16 B   | same body, small header: strings (`ArrayList(u8)`), `usize`/`String`/`bool`/`AstExpr` lists                                                                | 45.5 M (1.8 GB) + buffers |
| `String` (std) = `newtype(Option(ArrayList(u8)))` | 16 B inline | — | a String FIELD is 16 B (tag + handle) plus its 40 B `ArrayList(u8)` object plus the byte buffer: **three allocations' worth of overhead per name**   | 22.65 M `ArrayList(u8)` |

Two consequences follow from the table alone:

1. **One evaluated expression costs 440 + 112 + 80 (+ 8·frames) ≈ 650 B
   before its type or any child list.** At 7.35 M `ExprInfo`s that is 4.6 GB
   of pure per-node bookkeeping (measured: 4.93 GB for the cluster), of which
   the `Environment` + frame list share (192 B/node, 1.40 GB) is 100% redundant
   within a scope (§2 F3).
2. **`Option(ref)` costs 16 B where a nullable pointer costs 8.** `ExprInfo`
   alone loses 192 B to this; `String` fields lose 8 B each everywhere
   (`Variable.name`, every `Token`, every `TypeValue` id/name). The codegen
   already niches `Option(*T)`; extending that to reference handles is the one
   layout lever that shrinks every table at once (§2 F4).

### 1.2 The retention roots

Everything above stays alive because something process-lifetime points at it.
The roots, in the order the earlier campaigns found them mattering:

| root                                                                | what it pins                                                                                                             | lifetime                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `EvalContext.expr_info_table` (`ExprInfoTable = HashMap(ExprId, ExprInfo)`) | every `ExprInfo` → its env snapshot → frames → `Variable`s → values                                              | the context's; codegen shares ONE table across all modules (`g_shared_expr_info_table`) |
| **`g_finished_walks : HashMap(String, ModuleWalk)`** (`src/evaluator/context.yo:1167`) | `ModuleWalk.ctx` is `copy_eval_context(ctx)` — it **shares the module's whole `ExprInfoTable` handle** and `env`, for every module ever walked, including in one-shot `check`/`compile` where no revalidation will ever happen | process |
| `g_specialized_fn_caches` (`calls/helper.yo:1450`)                   | one `SpecializedFunctionCache` per specialization: `specialized_func_value` (a FuncVal whose body is a fresh-id clone) **and `env : Environment`** — the callee env, never read back by `_find_specialization_cache` (it returns only the value) | process |
| `g_comptime_fn_caches` / `ctx.comptime_fn_caches`                    | CTFE memo: arg values + results (type constructors, comptime fns)                                                        | process                                   |
| `g_module_cache_vals` (`module_loader.yo:107`)                       | every evaluated module's value: FuncVals → bodies, capture lists, def-env keys                                            | process (cleared only by `clear_module_cache`) |
| `g_capture_envs`, `g_funcval_cap_vars`, `g_shared_capture_envs`, `g_funcval_def_envs` (`env.yo`) | frozen definition scopes (shared `Variable` handles since the env-sharing campaigns)                       | process                                   |
| `g_func_parameters_frame` + the 15 `g_func_*` side tables (`evaluator/types/function.yo`) | per-func-id frames, default exprs, where-clause exprs, contract exprs                                        | process; never purged (B2 purges only trait methods + generic impls) |
| `g_frame_indexes` (`env.yo:473`)                                     | name → positions index per frame; **bounded to 2048 entries** since 2026-08-07                                            | bounded                                   |
| the other ~250 module-level globals (288 `(g_* : ...)` bindings in `src/`) | registries keyed by func/type id Strings                                                                            | process                                   |

The prune post-mortem's open question — "`ExprInfo.env` is not the only holder
of the 7.4 M `Variable`s; find the OTHER holder" — is answered by the second and
third rows: `g_finished_walks` pins every module's table (and through it every
env), and `g_specialized_fn_caches` pins a callee `Environment` per
specialization. Neither is read again in a one-shot command.

### 1.3 The RC header on evaluator types

The 2026-08 header split gave cycle-INCAPABLE types a 16 B header and left the
56 B header (packed word + `dispose_fn` + `traverse_fn` + 4 intrusive-list
pointers) on cycle-capable ones. Read from the emitted constructors: `ExprInfo`,
`Variable`, `Environment`, `Frame`, `TypeValue`, `EvalValue`, `AstExpr` and
`Token` all `__yo_gc_register` and carry the 56 B header — **every core
evaluator object is tracked**, and so is every `ArrayList` whose element type
is cycle-capable (`ArrayList(TypeValue)` is 80 B, `ArrayList(u8)` 40 B). The
census puts **83.0 M tracked objects × 56 B = 4.65 GB of headers, 35% of all
live struct bytes**, at the exit of `check src/main.yo`. The tracked header is
13% of an `ExprInfo`, 29% of a `Variable`, 32% of a `TypeValue`, 50% of an
`Environment`, 70% of a tracked `ArrayList`. `RC_HEADER_SPLIT.md` step 2
(type-id registry instead of two function pointers, roots list as an array:
56 → 24-32 B) would return 2.0-2.7 GB on today's population; §5 Phase 6.

---

## 2. Findings

Each finding states the mechanism, the evidence, and what it implies. F1–F4
are new to this audit; F5–F9 consolidate what earlier plans measured so the
lever ranking in §4 has one source.

### F1. One-shot commands retain every module's whole evaluation context

`begin_module_walk` stores `ModuleWalk(ctx : copy_eval_context(ctx), env, defs,
by_index, begin_exprs, module_frame, …)` and `end_module_walk` moves it into
`g_finished_walks`, where nothing removes it except a re-walk of the same path.
`copy_eval_context` shares the `expr_info_table` handle (`context.yo:1545`).
What is read from a FINISHED walk on the one-shot path (audited 2026-09-20,
every `finished_walk_for` / `g_finished_walks.get` site in `context.yo` and
`module_manager.yo`): `defs` / `by_index` (`_find_def_by_name`, dependency
edges in `record_module_member_read`, the cross-module serve of an
already-forced definition in `resolve_pending_definition`) and `module_frame`
(`_def_variable_for` → `module_frame_variable`). Lookup-miss forcing itself
goes through `_active_walk_for`, i.e. walks still on the `g_module_walks`
stack. **`ctx` and `env` are read only by Phase 3b revalidation
(`module_walk_force_env`, `revalidate_walk_defs`, `mm_revalidate_apply`)** —
the LSP / `check --watch` path (`reference/INCREMENTAL_COMPILATION.md`). For
`yo check` without `--watch`, `yo compile`, `yo build`, `yo test`, `yo doc`
and `yo verify` the retained `ctx` (and through it the module's whole
`ExprInfoTable`) and `env` are dead weight.

Evidence: the code path (§1.2); the prune post-mortem's unexplained holder;
`check ./src` costing only 0.8 GB more than `check src/main.yo` despite
evaluating 275 entry files (the retained state is dominated by the std/compiler
closure both commands load, which is retained once either way).

Implication: a mode flag (`retain_walks_for_revalidation`, set only by
`--watch` and `yo lsp`) that lets `end_module_walk` drop `ctx` (and `env`)
recovers whatever share of the peak the per-module tables are — to be measured
in Phase 0, expected to be large for `check` because in check mode each module
gets its OWN table (`module_manager.yo:1595` "No-op during check/test") and the
walk is the only thing keeping it. **For the LSP the right shape is the same
flag plus "retain tables only for OPEN documents"** (`mm_set_open_document` /
`mm_forget_open_document` already exist).

### F2. Specialization is the multiplier

Every specialization (`create_specialized_function_inline`, driven from the
evaluator on call and from codegen's `collect_required_functions` for
reachable generics) deep-clones the body with fresh ids, re-evaluates it in a
fresh callee env, and stores the result in `g_specialized_fn_caches`. Per body
node that is: one `AstExpr` (+ args list), one `ExprInfo`, one `Environment`
snapshot + frame list, plus a `Variable` per binding and every intermediate
`TypeValue`. Nothing is ever released. The 2026-08-17 measurement put 85% of
the emit footprint in exactly this population; today's `check` is doing the
same work (§0.2).

Evidence: §0.2; §0.4 (10.7 M live `AstExpr` against a source tree whose
parser mints a fraction of that; 3,134 `SpecializedFunctionCache` entries at
exit, so the retained CACHE is small and the retained BODIES are the cost);
`clone_expr_fresh_ids` (54 call sites, 9 in `calls/function.yo`, 7 in
`calls/helper.yo`, 12 in `builtins/contracts.yo`); `g_fid_specs` /
`g_fid_rtcalls` counters already exist (`expr_info.yo:1417`) but nothing prints
them.

Implication: the count of specializations × nodes per body is THE number to
know (Phase 0 step 3). Levers: (a) drop the per-specialization `env` from the
cache (never read back); (b) do not clone the AST — key `ExprInfo` by
(specialization id, source node id) instead, deleting the 4.9 M `AstExpr`
population and the token re-clones; (c) discard the def-time trial ExprInfos of
GENERIC bodies once their first specialization exists (codegen never emits a
generic body; the evaluator re-derives everything it needs from the
specialization). (b) and (c) are Phase 4 and gated on the counts.

### F3. Every `ExprInfo` carries a private, redundant `Environment` snapshot

`new_expr_info(env, ty)` always allocates `snapshot_env(env)`: a new
`Environment` (112 B + 56 B header) and a new `ArrayList(Frame)` (40 B +
8 B × depth) holding the SAME `Frame` handles as the live env. Frames append
in place, so two snapshots taken in the same scope with no push/pop in
between are **observationally identical** (same frames, same membership at
every later read). Consecutive expressions in one scope — the overwhelming
case — could share one snapshot object. Nothing mutates a stored snapshot: the
ten `X.env = …` writers in `src/evaluator/` replace the handle, and no site
pushes into or pops `info.env.frames` (audited 2026-09-20 by grep; Phase 2
step 1 re-audits by instrumentation).

Evidence: `snapshot_env` (`env.yo:1833`) and `new_expr_info` (`expr_info.yo:459`);
§0.4: 7.35 M `ExprInfo` : 7.30 M `Environment` : 7.25 M `ArrayList(Frame)` —
the 1:1:1 population, 1.40 GB of struct bytes plus the frame buffers.

Implication: a scope-version memo (bump a counter on every `push_env_frame` /
`pop_env_frame` / direct `frames` mutation; `new_expr_info` reuses the last
snapshot when the version and the env identity match) deletes most of 5.68 M
`Environment` + 7.25 M list objects (1.40 GB struct + buffers, measured) with
**no semantic change and byte-identical C**. This is the cheapest multi-hundred-MB
lever in the plan.

### F4. `Option(ref)` has no niche, so every optional handle costs 16 B

`Option(*T).None` is already emitted as NULL (`.github/instructions/yo-design.instructions.md`),
but `Option(T)` for a reference-semantics `T` (a `ref(struct)`/`ref(enum)`
handle, which is never NULL) is a tagged 16 B payload. `ExprInfo` has 24 such
fields (192 B of 456 B); `String` is `newtype(Option(ArrayList(u8)))`, so every
String field is 16 B instead of 8 (`Token` ×3, `Variable.name`, every
`TypeValue` id/name/label list element); `Option(String)` is 24 B.
`YO_SELF_ENV_SHARING.md` §4 estimated this at ~0.5 GB for `ExprInfo` alone;
across all tables it is larger and it also shrinks every `ArrayList(String)`
buffer by half.

Implication: a codegen-level change (Phase 3) that legitimately changes the
emitted C for every program. It needs the full battery, an ASan run, and an
`unsafe.cast`/FFI audit (a niche `Option(ref)` must never be handed to C code
expecting the tagged layout — `c_include`/extern signatures cannot mention
`Option(ref)`, verify).

### F5. `TypeValue` is interned only at `substitute()`

`backlog/TYPEVALUE_HASH_CONSING.md` measured 13 M live `TypeValue`s, landed
interning at `substitute()` (−1.45 M) and made `TypeValue.clone` return self.
Today (§0.4): **7.76 M `TypeValue` + 11.6 M `ArrayList(TypeValue)` + 3.2 M
`ArrayList(ArrayList(TypeValue))` + ~12 M `ArrayList(usize)` level lists =
3.03 GB of struct bytes**, the second-largest cluster — and 130 M
`ArrayList(TypeValue)` were CONSTRUCTED for 11.6 M survivors, i.e. type nodes
are rebuilt ~11× over. The remaining population is construction-site minted
(25 variants, ~86 sites). Recursive interning at the constructor
factories is designed there and not built; the construction-site memo is the
only form that also cuts the transient peak.

**Measured 2026-09-21 (`YO_TYPE_INTERN_PROBE=1`, tree-built compiler, `check
src/main.yo`):** the probe records every type at the two points where it
becomes RETAINED — `expr_info_table_set` (an `ExprInfo`'s `ty`) and
`add_variable_to_env` (a `Variable`'s `ty`) — and hashes its full structural
key (`type_intern_key`, depth cutoff 600, cycle-safe).

| retained type references | distinct structural keys | duplication |
| ------------------------ | ------------------------ | ----------- |
| **10,283,917**           | **17,538**               | **586×**    |

So 99.83% of what the two holders retain is a structural duplicate of one of
17.5 K types. Against the §0.4 census (7.76 M live `TypeValue`, 3.03 GB for
the cluster) that puts the ceiling of construction-site interning at
essentially the whole cluster minus 17.5 K objects — the largest lever left
in this plan by a wide margin. The same walk counted the lists hanging off
those types (per reference, so shared subtrees repeat): **44% of
`ArrayList(TypeValue)` reached are EMPTY** (2.27 G of 5.14 G), which is the
`Func` variant carrying five lists for a function that uses one; interning
the parent subsumes this, a shared empty singleton would not be safe on its
own unless every list is treated as immutable after construction (a grep for
in-place `push`/`insert` through the TypeValue field names finds zero sites;
destructured aliases are the audit still owed).

The probe costs nothing when off (knob-off run 89 s / 10.05 GB, knob-on 134 s
/ 10.05 GB peak footprint — the probe's own HashSet is 17.5 K entries).
Lesson recorded on the way: the probe's ten-interpolation report line made
`yo build` pathological under the v0.2.38 seed (~4^N interpolation cost,
fixed on develop 2026-09-20 but not in the seed) — `src/` diagnostic lines
stay short until a seed ships the fix.

### F6. `Variable` retention is a consequence of F1–F3, not a lever of its own

The two env-sharing campaigns removed the copy-minted `Variable`s (7.4 M → the
remaining population is genuine bindings: parameters, locals, captures per
specialization). They are retained because frames are retained by the env
snapshots (F3) and the tables (F1). Shrinking `Variable` itself (inline
single-slot value cell: `RC_HEADER_SPLIT.md` lever 3, ~0.8 GB) is real but
sequenced after F1–F3 because those may delete most of the population first.

### F7. Identifier strings are a three-allocation type

A name is a 16 B inline `String`, a 40 B `ArrayList(u8)` object and a
≥16 B malloc'd buffer. 42.7 M `ArrayList(u8)` were live at exit in the
2026-08-17 census (3.26 GB at the old 80 B; ~1.7 GB + buffers now). Sources:
`Variable.name`, `Token.value`/`module_path`, type/enum/func id Strings (shared
by handle but each mint is fresh), `g_frame_indexes` key clones (bounded since),
the 30+ registries keyed by `String`. The hot-path profile (`YO_SELF_ENV_SHARING.md`
§3b) also shows String-keyed identity (split/hash/compare) as the largest
named CPU long tail.

Implication: a `Symbol` (u32 handle into a global intern table) for names and
ids is the structural fix — broad, and sequenced last (Phase 5b) because F4
halves the inline cost first and Phase 0's census will say how many of the
strings are names versus content.

### F8. Compile cost per call site is super-linear — a bug, and it blocks the diet

Two independent measurements: the ExprInfo accessor diet cost +3.9 GB to
COMPILE (~370 accessor calls → "~10 MB of retained evaluation state per call
site"), and one 5-line gated debug probe cost +11.7 GB / +2.9× wall of seed
compile (`issues/fixed/debug-probe-line-costs-gigabytes-at-compile-time.md`, open).
Both point at one mechanism in def-time trial evaluation / specialization
(suspects: a new binding shape driving `value_to_string`-class recursive
formatters through fresh unknown lineages; per-interpolation cost in template
strings). Until it is found, every refactor that adds calls in hot evaluator
files is a memory regression for the self-compile, and the refuted diet is
refuted only "as implemented".

### F9. The floor is fine; the churn is fine

`hello.yo` checks at 0.49 GB (prelude + `std/fmt`), flat since 0.2.30. Gross
constructions were 1.5 BILLION per self-emit against 120 M live at exit
(`RC_HEADER_SPLIT.md` census) — the allocator absorbs the churn; the collector
is ~4% of wall; `YO_GC_FULL_PCT=130` moved nothing (all live data). The
problem is what stays, not what is allocated.

---

## 3. Refuted and do-not-retry (from the record)

| idea                                                         | where refuted                                  | why                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Prune `ExprInfo.env` per module with a mark walk             | `archive/YO_SELF_EXPRINFO_PRUNE.md`            | −1.13 GB only, +80% wall, and it changed the emitted C (missed roots)                     |
| Accessor-based `ExprInfoRare` diet of 15 fields              | `backlog/RC_HEADER_SPLIT.md`                   | binary wins 1.8 GB, source loses 3.9 GB (F8); reopen only after F8 is fixed               |
| Memoize `capture_env_for` rebuilds (by source / by content)  | `backlog/YO_SELF_ENV_SHARING.md` §3 second site | 37 / 587 hits per self-emit; +2.1 GB retention                                             |
| Freeze multi-frame def envs per definition                   | `backlog/FUNCVAL_ENV_SHARING.md` header        | broke Call-tuple dispatch; thrashed `g_frame_indexes` (24 s → 9 min)                      |
| Intern at storage points (`type_of_eval_value`, `Variable.ty`) | `backlog/TYPEVALUE_HASH_CONSING.md` §7       | 99.9% hit rate on already-canonical types = pure overhead; intern PRE-canonical only       |
| Tighter `YO_GC_FULL_PCT`                                     | `backlog/RC_HEADER_SPLIT.md`                   | 130 vs 200 moved nothing — the tracked set is live                                          |
| Share live `Frame` handles into def-time envs                | `issues/env-sharing-live-frame-membership-leak.md` | frames append in place → membership leaks → statements silently dropped from the C      |
| `Frame.where_clause_constraints` eager HashMap               | `backlog/YO_SELF_ENV_SHARING.md` §4            | 157 k frames × 496 B ≈ 78 MB, not GB                                                       |
| An arena / bump allocator for the compiler                   | `backlog/ARENA_ALLOCATOR_FEASIBILITY.md`       | the footprint is retention; a no-free region turns 1.5 B gross constructions into ~150 GB  |
| Owner-purge the specialization cache on LSP invalidation (as a MEMORY lever) | §5 Phase 1 step 5 (2026-09-25)                 | 5-round `yo lsp` 0.98 vs 0.99 GB: stable type ids make re-evaluation HIT the old entries (124 flat in a focused test). Landed anyway the same day for CORRECTNESS: #883's per-fid purge dropped function types the cache still handed back, and a `build --watch` round emitted an untranspiled call (`issues/fixed/build-watch-reuses-a-stale-imported-module.md`) |

---

## 4. Levers, ranked

"Saving" is the best available estimate with its provenance; Phase 0 replaces
every estimate with a measurement before the phase that spends it starts.
"C identical" = the emitted C must stay byte-identical (the gate that caught
the prune).

| #  | lever                                                                  | est. saving                                | risk   | C identical | phase | evidence            |
| -- | ---------------------------------------------------------------------- | ------------------------------------------ | ------ | ----------- | ----- | ------------------- |
| 1  | Drop `ModuleWalk.ctx`/`env` retention outside watch/LSP (F1)           | up to the per-module tables — measure      | LOW    | yes         | 1     | §1.2, F1            |
| 2  | Drop `SpecializedFunctionCache.env` (never read back) (F2a)            | negligible — 3,134 entries (§0.4); hygiene | LOW    | yes         | 1     | `helper.yo:1571`    |
| 3  | Scope-version env-snapshot sharing in `new_expr_info` (F3)             | **1.40 GB struct + buffers** (7.3 M envs + 7.25 M lists, measured) | LOW | yes | 2  | §0.4                |
| 4  | `Option(ref)` niche in codegen (F4)                                    | ≥0.5 GB `ExprInfo` alone; every String field −8 B | MED (layout) | NO — full battery + ASan | 3 | §1.1             |
| 5  | Specialization without AST cloning; drop generic-body trial infos (F2b/c) | up to 4.9 M `AstExpr` + a share of `ExprInfo` — measure | HIGH | should be | 4 | F2               |
| 6  | Recursive `TypeValue` interning at constructors (F5)                    | up to the 3.03 GB TypeValue cluster (7.8 M nodes + 27 M lists, measured) | MED | yes | 5a | §0.4, `TYPEVALUE_HASH_CONSING.md` |
| 7  | `Symbol` interning for names/ids (F7)                                  | strings population — measure               | HIGH (broad) | yes   | 5b    | F7                  |
| 8  | Tracked RC header 56 → 24-32 B (type-id registry, roots array)          | **2.0-2.7 GB** at 83 M tracked objects (measured 4.65 GB of headers) | HIGH (GC) | layout-only | 6 | §0.4, `RC_HEADER_SPLIT.md` step 2 |
| 9  | `Variable.value` inline single slot                                    | ~0.8 GB before F1–F3; less after           | MED    | yes         | 6     | `RC_HEADER_SPLIT.md` lever 3 |
| 10 | Root-cause the super-linear per-call-site compile cost (F8)            | unlocks lever 11; fixes user programs too  | investigation | —    | 7     | F8                  |
| 11 | `ExprInfo` diet (rare group) done without the accessor pathology        | ~1.2 GB (19 of 24 fields ≤2.5% occupied)   | MED    | yes         | 7     | `RC_HEADER_SPLIT.md` |

---

## 5. Implementation plan

Every phase: its own branch and PR (squash-merged), commit + push before every
heavy step, `yo fmt` on every touched `.yo`, `yo check ./src --std-path ./std`
first, then the gates in §6. A phase that changes an estimate by more than 2×
in either direction re-ranks §4 in this document before the next phase starts.

### Phase 0 — instruments and attribution (no compiler behaviour change)

The scratchpad scripts of the 2026-08 campaigns are gone; the census script
that survives (`scripts/bootstrap/live_census.py`) targets the retired
`__yo_struct_yo…_id_N` naming and no longer matches the emitted C. Make the
instruments durable and answer the three questions the ranking depends on.

1. **`scripts/bootstrap/live_census_t.py` — LANDED with this plan.** The
   per-type live census for the current content-hashed `__yo_t_<hash>` naming
   (+1 at each `__yo_new___yo_t_N[_Variant]` definition; −1 at the entry of
   the `yo_id_K` the constructor installs as `header.dispose_fn`; dump
   `live gross sizeof slot` per type from a destructor, names in the `.map`;
   types with no `dispose_fn` are ceilings). §0.4 is its first output. Input: `yo compile src/main.yo
   --emit-c --skip-c-compiler --std-path ./std -o <c>`; output: the
   instrumented `.c`, compiled with the same flags `yo build` uses (it links
   OpenSSL: `-I$(brew --prefix openssl@3)/include -L…/lib -lssl -lcrypto -lm`
   on macOS). Document in `scripts/bootstrap/README` or the script header.
   Acceptance: the census of `check hello.yo` runs and its exit-live total
   reconciles with the footprint within the allocator overhead.
2. **`scripts/bootstrap/peak_histogram.py`** — the allocator-boundary
   instrument from `RC_HEADER_SPLIT.md`: retarget the emitted
   `#define __yo_malloc/calloc/realloc/free` at accounting shims
   (`malloc_size` per block), keep a per-16 B-size-class histogram of live
   bytes, snapshot at every >1/128 high-water growth, record
   `__builtin_return_address(1)` for the top classes (arm64 keeps frame
   pointers; symbolize with `atos`). Report tracked live at peak and its
   composition. Acceptance: reproduces the shape of the 2026-08-18 table
   (40 B class, 448 B class, …) on the current tree.
3. **Attribute the 19.3 GB `check`** with both instruments on
   `check src/main.yo` and on `check ./src/types`: (a) per-type live at exit
   — **DONE 2026-09-20, §0.4**; (b) peak composition; (c) **retention by
   holder** — extend the census with
   a second counter keyed by the ROOT that retains the object at exit (walk
   `g_finished_walks` → tables → count reachable `ExprInfo`/`Environment`/
   `Variable`; walk `g_specialized_fn_caches`; walk the module cache; the
   remainder is "other roots"). This is the measurement the prune post-mortem
   asked for and never got. Record the result in this document's §0.
4. **DONE (§0.2d).** **Specialization counts**: a `YO_SPEC_REPORT=1` env knob (read once at exit
   in `src/main.yo`, like `YO_DEBUG_*`) that prints `g_fid_specs` /
   `g_fid_rtcalls` sorted by count plus the total number of nodes cloned by
   `clone_expr_fresh_ids` (add a counter next to `g_next_global_expr_id`).
   Acceptance: the report runs on `check src/main.yo` and the plan's Phase 4
   estimate is replaced by its numbers.
5. **Per-release bisect of `check src/main.yo`** (the §0.2 question): for each
   tag `v0.2.31 … v0.2.37`, `git worktree add $HOME/Workspace/Yo-wt/bisect-<v>
   v<v>` (+ submodules), then `~/.cache/yo/versions/<v>/bin/yo check
   src/main.yo --std-path ./std` under `/usr/bin/time -l`, one at a time on a
   quiet machine. Record the footprint series here. If one release jumps
   >2×, read its merged PRs for the evaluator-side cause before Phase 1
   (a regression fix may be cheaper than every lever below).
6. **A memory ratchet in CI**: a `memory-ratchet` job on the Linux leg that
   runs `/usr/bin/time -v <seed-built yo> check ./src/types --std-path ./std`
   and fails when `Maximum resident set size` exceeds the recorded baseline
   by >10% (baseline TSV under `scripts/bootstrap/`, updated deliberately like
   `known-failing.tsv`). Linux has no compressor, so max RSS is the honest
   number there. Add it to branch protection by hand (the list is manual).

### Phase 1 — retention hygiene (F1, F2a): fewer roots, byte-identical C

1. **Walk retention flag.** In `src/evaluator/context.yo` add
   `(g_retain_walk_contexts : bool) = false` with a setter. `ModuleWalk.ctx`
   and `ModuleWalk.env` become `Option(...)`; `end_module_walk` keeps them
   only when the flag is set and otherwise stores `.None` (the record keeps
   `module_path`, `defs`, `by_index`, `begin_exprs`, `module_frame`,
   `module_frame_id` — everything the one-shot readers listed under F1 touch).
   `module_walk_force_env`, `revalidate_walk_defs` and `mm_revalidate_apply`
   take the `.None` case as "not retained: fall back to the file-level
   re-walk" (the conservative fallback those paths already have). Set the
   flag in `run_check` when `--watch`/`--watch-once` is given and in
   `yo lsp`'s server start. `yo compile`/`build`/`test`/`doc`/`verify` never
   set it. An ACTIVE walk (still on `g_module_walks`) is unaffected: forcing
   reads the live `ctx`/`env` passed to `begin_module_walk`, not the copy.
2. **Prove the walk is dead on the one-shot path**: an assertion build
   (`YO_DEBUG_WALKS=1`) that panics if `finished_walk_for` returns a slim
   record and the caller touches `.ctx`/`.env`; run `check ./src`,
   `check ./std`, `compile src/main.yo --skip-c-compiler`, the fast suite.
3. **LSP: retain only open documents.** `mm_forget_open_document` drops that
   document's walk `ctx` (keeping the slim record); `mm_set_open_document`
   restores full retention on the next walk. Gate with the LSP tests under
   `tests/internal/` and a long-lived `yo lsp` session (open/edit/close 50
   documents, footprint must plateau).
   **LANDED 2026-09-24.** `yo lsp` no longer sets the global retention flag;
   `mm_set_open_document` / `mm_forget_open_document` add and remove the
   document's canonical path in `g_retained_walk_paths`
   (`set_walk_context_retained`, `src/evaluator/context.yo`), and
   `end_module_walk` keeps a context only for those (or for everything under
   `check --watch`). The revalidation planner treats a closure module whose
   walk released its context as a per-module file-level fallback instead of
   re-forcing into it (forcing without a context is an internal error). Test:
   `tests/internal/module_invalidation.test.yo` "B3" (red on the old rule).
   Measured, seed-built binaries: `yo lsp` opening `src/main.yo`
   **9.39 → 8.48 GB (−0.91 GB)**. **The plateau gate FAILED — before and
   after this change:** cycling the same 10 std documents through
   open/edit/close grows the peak 0.63 GB (1 round) → 1.89 GB (5 rounds), a
   pre-existing per-round leak (step 5's concern), filed as
   `issues/lsp-memory-grows-per-open-edit-close-round.md`.
4. **`SpecializedFunctionCache.env`**: the field is write-only today —
   `_find_specialization_cache` (`helper.yo:1455-1600`) returns only
   `specialized_func_value`, and its `caller_env` parameter appears once, as
   a bare expression statement (`helper.yo:1501`), i.e. unused. Confirm with
   the assertion build, then delete the field, the `env` parameter of
   `_store_specialization_cache` (2 call sites: `helper.yo:4063`, `:4407`) and
   the dead `caller_env` parameter.
5. **Registry sweep**: for each of the 288 module-level globals, classify
   {bounded, per-module (purgeable by owner), per-function (purgeable by
   owner), process}. Record the table in this document. For the per-function
   `g_func_*` side tables, add the owner tag the B2 purge already uses for
   trait methods/impls so `mm_invalidate_document` can purge them too
   (LSP steady-state leak; measure with step 3's long session).
   **PARTLY LANDED 2026-09-25, by measurement rather than the full table.**
   The holder census over 1 vs 5 LSP rounds (after §0.8) named ONE root that
   grows: `g_funcval_cap_vars` (+81.5 K reachable objects over four rounds,
   plus the capture-type lists behind untracked `Box(FuncValData)`s that only
   look unreached). Its entries are now owner-tagged at
   `register_funcval_cap_vars` (`registration_owner()`, which lazy forcing
   already sets to the definition's module), and
   `purge_funcval_cap_vars_owned_by` runs in `mm_invalidate_document` beside
   the four B2 purges. Test: the B2 test in
   `tests/internal/module_invalidation.test.yo` now also holds the registry's
   count flat (red without the purge). Stage-2 `yo lsp`, 10 std documents:
   1 round 0.44 → 0.42 GB, **5 rounds 1.19 → 0.98 GB**; `check src/main.yo`
   unchanged (interleaved 2.71/2.80 vs 2.76/2.73 GB). About 0.14 GB per
   round remains. The next census names the next holder; the full 288-global
   table is still not written.
   **Batches 1–2, 2026-09-25.** A census row per container global's LENGTH
   (`L` rows, `holder_census_t.py`) found **56 registries growing every LSP
   round**, in three key families: function ids, type ids, expression ids.
   Their entries are mostly UNTRACKED (`HashMap(String, EvalValue)` and the
   like take the small header), so the traverse-based H rows never saw them.
   The `HOLDER_DEEP` walk (precise `traverse_fn` for tracked objects,
   header-restricted conservative scan for untracked ones, bytes per root)
   ranks the 1→5-round growth: `g_method_callee_values` +264 MB,
   `g_ifc_memo` +94 MB, unreachable +69 MB, `g_macro_expansions` +47 MB,
   `g_frame_indexes` +31 MB, `g_type_intern` +24 MB,
   `_trait_method_defaults` +17 MB, then a long tail. (A first version that
   scanned every word of every object attributed 0.5 GB to a trait registry:
   an enum's union tail holds a previous occupant's stale words.)
   - **Batch 1 (#883), function-id family**: the 17 `g_func_*`/`g_macro_*`
     side tables and two `function_value.yo` registries. A function id is
     recorded in `g_owned_func_ids` at its FIRST registration only;
     specialization copies (`to_id`) are shared across modules through the
     specialization cache and stay. 5 rounds 0.98 → 0.97 GB.
   - **Batch 2, expression-id family**: `g_method_callee_values`/`_types`,
     `g_macro_expansions`, `g_arm_init_ranges`, `g_io_builtin_calls`,
     recorded in `g_owned_expr_ids` at insert and purged by
     `purge_expr_side_tables`. **5 rounds 0.96/0.97 → 0.90/0.91 GB.**
   - **Batch 3, memo registries**: `g_ifc_memo` (impl.yo), `_trait_method_defaults`
     and `g_type_intern` via a shared `OwnedKeys` log in `utils.yo` (the
     owner mirror lives there so `types/intern.yo` can tag without importing
     the evaluator). Memo and intern entries carry no identity contract, so a
     purge costs at most a recompute. **5 rounds 0.90 → 0.79 GB**;
     `check src/main.yo` unchanged (2.75 vs 2.78 GB).
   All three are gated by B2 tests (flat counts across rounds, red without
   the purge). Next: the rest of the type-id family, `g_frame_indexes`, and
   the unreachable set (mostly `ArrayList(u8)` string buffers in one-shot
   `check`: 4.65 M objects / 223 MB at exit — holder or leak, not yet split).
6. Measure `check src/main.yo` and the self-emit (footprint + tracked live);
   update §0.

### Phase 2 — env-snapshot sharing (F3): byte-identical C

Amended 2026-09-20 after the audit found the 65 adoption sites (§0.2b):

1. **Adoption sites copy.** Every `env.frames = X.env.frames;` becomes
   `env.frames = copy_frames(X.env.frames);` (`copy_frames` in `src/env.yo`,
   a shallow copy of the handle list). This is what makes sharing sound: a
   live env can then never alias a recorded snapshot's list, so a later push
   cannot rewrite a recorded scope. It costs one list per adoption executed
   and is applied mechanically (`scripts`-free: a regex over `src/`, 65 sites
   in 31 files, asserted count).
2. **Frame-sequence memo instead of a version counter.** `Environment` gets
   `snapshot_memo : Option(Environment)`; `expr_info_env_snapshot(env)` (used
   ONLY by `new_expr_info` and `clone_expr_info_for_shared_begin_result`)
   returns the memoized snapshot when its frame sequence equals the live
   env's (compared by `Frame.id`, O(depth)), else `snapshot_env`s a fresh one
   and memoizes it. No version bookkeeping at the 65 mutation sites is needed:
   equality of the sequence IS the validity test, since frames append in
   place. The other 19 `snapshot_env` callers build scratch envs they go on
   to mutate and keep private copies. A snapshot's own memo stays `.None`
   (no cycle: snapshots hold Frame handles, never the live env).
3. Prove: emitted C byte-identical on the corpus (`scripts/cli-diff-test.sh`
   + the self-emit diff), `fixpoint_only.sh`, `gates_fast.sh`. Measure:
   `Environment` live count should fall by the share of consecutive
   same-scope infos (expect >80%); footprint and tracked live recorded here.
4. **Frame list buffers**: with snapshots shared, the remaining per-snapshot
   `ArrayList(Frame)` is per SCOPE; leave it.

**What landed (2026-09-21, branch `perf/evaluator-memory-p2-f3`) — two
corrections to the design above:**

- The memo is a 4-slot **global ring** (`g_snapshot_ring` in `src/env.yo`),
  not a field on `Environment`: an `Option(Self)` field on the widely
  imported ref struct emitted TWO C types for `Environment` (an id/era
  split, `issues/option-self-field-on-environment-splits-into-two-c-types.md`).
  The ring keeps the last four snapshots; a hit is a frame-sequence match.
- Copying at the 65 `frames` adoption sites was necessary but not
  sufficient. A recorded env is also adopted **by handle** — the whole
  `Environment` object — in four syntactic shapes (`x = info.env;`,
  `rec.env = info.env;`, `env = match(.., .Some(i) => i.env, ..)`,
  `evaluate_*(e, info.env, ctx)`), and the adopter then evaluates further
  arguments in it, whose blocks push and pop; with sharing that rewrote every
  sharer's recorded scope ("Variable body_info already defined"). The
  `frozen : bool` flag + `YO_DEBUG_FROZEN=1` guard (panics on a mutation of
  a recorded snapshot; the lldb backtrace names the adopter) found them one
  cycle at a time — 3 cycles, then a scripted sweep of the whole class:
  every such adoption is now `snapshot_env(info.env)` (58 sites, 24 files).
  Note `pop_frame_nonmutating` is not safe on a shared snapshot either: it
  reassigns `self.frames`. Lesson recorded in memory
  (`yo-env-snapshot-sharing-lessons`): run the four static scans BEFORE the
  next guard build; each guard cycle is a 15-minute self-build.
- **Measured 2026-09-21** (`check src/main.yo --std-path ./std` on tree
  24fcd192f, `/usr/bin/time -l`, guard clean = zero frozen-snapshot
  mutations across the whole run):

  | tree | peak footprint | max RSS | wall |
  | --- | --- | --- | --- |
  | Phase 1 (#805) | 10.16 GB | — | 90 s |
  | Phase 1 + F3 | 9.72 GB | 9.87 GB | 88.7 s |

  With plain private copies at the adoption sites: 9.72 GB (−0.44 GB). With
  the copy-on-write adoption that keeps emission identical
  (`expr_info_adopt_env`): **10.01 GB (−0.15 GB, −1.5 %)**, 88.2 s. The ring
  hit rate IS high — `YO_SPEC_REPORT` on the self-compile: 2,807,813 hits /
  423,507 misses (87 % of recorded envs shared) — so the audit's 2–3 GB
  estimate for F3 was wrong, not the design: a snapshot is one `Environment`
  plus a handle list of a few frames (~150 B), and 2.8 M of them are ~0.4 GB.
  The frames' VARIABLE lists, which the audit attributed per snapshot, were
  already shared `Frame` objects. F3's true ceiling was ~0.4 GB and the
  copy-on-write adoptions give a third of it back. Lesson for the remaining
  phases: the census counts OBJECTS; multiply by the object's own size before
  ranking a lever.
- **Emission:** identical to develop except one dup/drop pair whose
  `nested_dup` gate develop computed from an alias-inflated recorded env
  (measured with a decision probe in both trees; the ring off reproduces the
  same emission) — `issues/fixed/recorded-env-adopted-by-handle-mutates-shared-snapshots.md`.
  The `YO_ENV_NO_RING=1` knob and the ring hit/miss counters in
  `YO_SPEC_REPORT` stay as instruments; `YO_DEBUG_FROZEN=1` stays as the
  guard for future adoption sites.

### Phase 3 — `Option(ref)` niche (F4): layout change, full battery

1. **Spec**: `Option(T)` where `T` is a reference-semantics handle
   (`ref(struct)`, `ref(enum)`, `atomic(ref(...))`, `Box`, `Arc`, `Iso`,
   `dyn`? — decide per representation; `dyn` is a fat pointer, exclude) is
   emitted as the bare pointer with `NULL` = `.None`. Mirrors the existing
   `Option(*T)` rule (`yo-design.instructions.md` "Option(*T).None is
   optimized as NULL").
2. **Sites**: type emission (`codegen/types/generation.yo`), construction
   (`Option(T).Some(x)` / `.None`), match/destructure on `.Some/.None`,
   `is_some/is_none/unwrap` builtins, dup/drop/dispose/traverse lowering
   (`exprs/rc_fns.yo`, the drop lowerings — audit every `true => ""` fallback
   arm first, memory note "empty-string drop fallback class"), async
   state-machine slots (`codegen/async/`), the `sizeof` model
   (`types/utils.yo` size walk — must agree with the emitter on every target;
   `issues/fixed/sizeof-of-aggregate-with-unit-field-disagrees-with-emitted-c-struct.md`
   is the failure mode), `derive(Eq/Clone/ToString)` over `Option`, comptime
   `Option` values crossing to runtime, FFI (`c_include`/extern signatures:
   reject `Option(ref)` in extern types or keep the tagged layout there).
3. **Gates**: the full language suite ON a niche-built compiler, ASan on
   Linux CI (layout bugs present as immediate UAF/OOB), `check ./std`,
   `fixpoint_only.sh` (the emitted C legitimately changes ONCE; the fixpoint
   must hold on the new emission), the dup/drop emit-diff gate, MSVC layout
   check (`-Xclang -fdump-record-layouts` on `*-windows-msvc` — the model must
   match). Measure: `sizeof(ExprInfo)` 456 → ≤ 264, `sizeof(String)` 16 → 8;
   footprint + tracked live on `check src/main.yo` and the self-emit.

### Phase 4 — the specialization population (F2b/c): measure, then decide

Gated on Phase 0 step 4's counts — measured in §0.2d: Design 1 targets 1.30 M cloned nodes, Design 2 a few thousand; go with 1. Two candidate designs, both "should be
byte-identical" (they change bookkeeping, not what is emitted):

1. **No AST clone per specialization.** Key `ExprInfoTable` by
   `(spec_id, source ExprId)`: `EvalContext` carries the current `spec_id`
   (0 for def-time evaluation), `expr_info_table_set/get` fold it into the
   key, `create_specialized_function_inline` mints a fresh `spec_id` instead
   of calling `clone_expr_fresh_ids`, and codegen's function generator is
   handed the `spec_id` with the FuncVal (a field on `FuncValData` next to
   `env_key`). Every site that today relies on fresh ids being globally unique
   (the `_optimize_dup_drop_pairs` family walks by id, deferred-drop lists
   hold synthesized `___drop` nodes — those synthesized nodes still need
   fresh ids: keep `alloc_global_expr_id` for synthesized nodes only) must be
   listed before coding. Prototype on one call site (`calls/helper.yo`'s
   inline specialization), measure the `AstExpr` count drop, then extend.
2. **Discard generic-body trial infos.** After a generic function's first
   specialization is cached, remove the def-time trial `ExprInfo`s of its
   ORIGINAL body ids from the table (walk the body, `remove` each id) — they
   are never emitted (`_is_generic_unspecialized_func` gates emission) and
   the evaluator re-derives what it needs from the specialization. Guard
   with an assertion build that panics on a `expr_info_table_get` miss for a
   removed id; run the full battery. If the LSP needs hover types on generic
   bodies, the Phase 1 retention flag keeps them there.
3. Either design lands only with: emitted C byte-identical on the corpus,
   `fixpoint_only.sh`, `gates_fast.sh`, the hollow sweep ratchet, and the
   census showing the population it targets gone.

### Phase 5 — identity: `TypeValue` interning (5a) and `Symbol` (5b)

- **5a** follows `backlog/TYPEVALUE_HASH_CONSING.md` §7 Phases 1–2 as written
  (atomic `mk_*` factories, then `Func`/`Struct`/`EnumT`/`Pointer`/`Tuple`
  construction-site interning with the validated full-content key in
  `src/types/intern.yo`), with one change from this audit: measure the live
  `TypeValue` count FIRST (Phase 0 step 3) — `TypeValue.clone` returning self
  already removed the clone-minted population that plan was written against.
  MEASURED 2026-09-21 (F5): 10.28 M retained references over 17,538 distinct
  structural keys — the lever is real and is the next thing to build. Order
  of work: (1) audit in-place mutation of a `TypeValue`'s lists through
  destructured aliases (the field-name grep is clean); (2) intern at the
  RETENTION points first (`expr_info_table_set`, `add_variable_to_env`) —
  one `HashMap(u64, TypeValue)` keyed by the structural hash, colliding
  keys verified by the full key — which cuts the RETAINED population without
  touching the 86 construction sites; measure; (3) then the construction-site
  factories for the transient peak. Gate: cold self-emit byte-identical,
  the era-split tests (`yo-identical-name-unify-error-is-an-id-era-split`),
  `check src/main.yo` peak before/after.

  **MEASURED 2026-09-21 (later): retention-point interning is a NULL result —
  do not retry in this form.** Built on the probe (experiment branch
  `perf/typevalue-intern-at-retention`, diff kept in the session record):
  `intern_retained_type` at `expr_info_table_set` and the three Variable
  binders in `env.yo`, same table and key as the `substitute` sites, SomeT-
  bearing types passed through (a type variable's resolution cell mutates;
  two same-id variables may legitimately hold different cells). `check
  src/main.yo`, tree-built compiler, knob A/B in one binary:

  | retention interning | wall  | peak footprint |
  | ------------------- | ----- | -------------- |
  | off                 | 90 s  | 9.62 GB        |
  | on                  | 124 s | 9.63 GB        |

  Cold self-emit byte-identical on vs off; gates_fast 0 failures — the
  mechanism is SAFE, it just changes nothing. The counters say why:

  | retention calls | already in the table (hit) | new key (miss) | skipped (SomeT) |
  | --------------- | -------------------------- | -------------- | --------------- |
  | 10,962,233      | **10,406,550 (95%)**       | 8,788          | 546,895 (5%)    |

  95% of what the two holders retain is a HANDLE TO A TYPE THE TABLE ALREADY
  HOLDS — the substitute-site interning made the retained roots shared long
  ago, so replacing a root with "its canonical" replaces it with itself and
  frees nothing. The 586× "duplication" the probe reported is duplication of
  REFERENCES, not of objects. Consequence for the census: the 7.76 M live
  `TypeValue` objects are NOT the ExprInfo/Variable roots (those are ~17.5 K
  shared objects); they are held elsewhere — inside subtrees of types the
  retained roots do not reach, in `FuncMeta` lists, registries
  (`register_func_type`, MethodEntry.ty, GenericImplEntry patterns), the
  specialization caches, or SomeT-bearing families. The next step is a
  HOLDER census (for each live `TypeValue`, which root reaches it), not more
  interning; construction-site interning (hash-consing proper) only pays if
  that census shows constructed-then-dropped duplicates, which the 130 M
  constructed / 11.6 M surviving list figure (F5) still suggests for the
  TRANSIENT peak. Rule learned: a probe that counts references at a holder
  says nothing about object identity — count MISSES against a table, or
  compare handles, before sizing a lever.

  **Second A/B, same day — types used as VALUES: also null, and it locates the
  population.** `EvalValue.TypeVal` payloads (every type expression's result,
  every comptime type binding) interned at the same two retention points (all
  five Variable binders + the ExprInfo table setter; branch
  `perf/typevalue-intern-typeval-payloads`, retired, diff in the session
  record):

  | retention interning of ty + TypeVal payloads | wall  | peak footprint |
  | -------------------------------------------- | ----- | -------------- |
  | off                                          | 102 s | 9.59 GB        |
  | on                                           | 144 s | 9.64 GB        |

  | calls (ty + payload) | hits       | misses | skipped (SomeT) |
  | -------------------- | ---------- | ------ | --------------- |
  | 12,557,745           | 11,221,663 | 10,139 | **1,325,943**   |

  The payload hooks added 1.6 M retained references: 1,351 new keys, the rest
  hits — and **0.78 M of them SomeT-bearing**, skipped. Read against §0.4
  (7.76 M live `TypeValue`, 11.57 M live `ArrayList(TypeValue)`, ~17.5 K
  shared roots): the unshared population is the **SomeT-bearing families** —
  ~1.3 M roots at retention, each a generic signature or instantiation with
  its own subtree (a `Func` carries five lists), ~5–6 objects apiece, i.e. the
  whole cluster. They are excluded from interning by design: a type
  variable's `resolved_concrete` cell mutates after construction and two
  same-id variables may legitimately hold different cells
  (`yo-identical-name-unify-error-is-an-id-era-split`), so merging them by
  structural key is exactly the wrong merge §4.8 of the hash-consing plan
  warns about.

  **So F5 is now a DESIGN problem, not an instrumentation one:** give type
  variables an identity that interning can key on — (id, cell identity), or
  cells shared by construction so equal-key SomeTs ARE one object — and
  intern the SomeT-bearing families at construction. Until that design
  exists, no further retention/construction hook will move the peak; the two
  null A/Bs above are the measurement.
- **5b** `Symbol :: newtype(u32)` + a global intern table (`std`-free, in
  `src/utils.yo`): start with `Variable.name` and the frame index keys (one
  lookup path, `get_variables_from_frame`/`_frame_positions`), measure, then
  `Token.value` for identifiers (diagnostics render through the table). Each
  step is a broad mechanical refactor; land per field, byte-identical C.

### 0.4′ The exit-live census RE-TAKEN at 9.69 GB (2026-09-21)

Same recipe as §0.4 (`scripts/bootstrap/live_census_t.py`, `clang -O1`,
`check src/main.yo`). §0.4 was taken at the 19.33 GB baseline and every lever
estimate in this plan is derived from it, so it is two phases stale. The
instrumented run's footprint (9.69 GB) matches the uninstrumented one
(9.72 GB), so the counters still do not perturb the measurement.

**6.18 GB of live struct bytes over 67.5 M objects**, down from 13.3 GB over
130 M.

| type | live | sizeof | live bytes | vs §0.4 |
| --- | --- | --- | --- | --- |
| `TypeValue` | 7.55 M | 176 | **1.329 GB** | 1.37 GB — unmoved |
| `Variable` | 4.90 M | 192 | 0.941 GB | 1.95 GB |
| `ArrayList(TypeValue)` | 11.12 M | 80 | **0.890 GB** | 0.93 GB — unmoved |
| `ExprInfo` | 2.06 M | 216 | 0.445 GB | 3.23 GB |
| `ArrayList(usize)` | 10.82 M | 40 | 0.433 GB | 0.48 GB |
| `ArrayList(EvalValue)` | 4.54 M | 80 | 0.363 GB | 0.65 GB |
| `ArrayList(u8)` (strings) | 8.32 M | 40 | 0.333 GB | 0.91 GB |
| `ArrayList(ArrayList(TypeValue))` | 3.22 M | 80 | **0.258 GB** | 0.26 GB — unmoved |
| `AstExpr` | 3.98 M | 64 | 0.255 GB | 0.69 GB |
| `Token` | 2.26 M | 104 | 0.235 GB | 0.69 GB |
| `Environment` | 1.32 M | 120 | 0.158 GB | 0.82 GB |
| `EvalValue` | 1.36 M | 96 | 0.130 GB | 0.18 GB |
| `ArrayList(Frame)` | 1.32 M | 80 | 0.105 GB | 0.58 GB |
| `ExprInfoRare` | 0.17 M | 464 | 0.079 GB | 0.02 GB |

**What the re-take settles, and it re-ranks the rest of the plan:**

- **The `TypeValue` cluster is now the whole game.** `TypeValue` + its two
  list types = **2.48 GB of the 6.18 GB live, 40 %**, and it is the ONLY
  cluster the campaign has not touched: all three rows are within 4 % of
  their 19 GB-era values while everything around them fell by half or more.
  Lever 6 (recursive interning at the constructors, F5) is no longer one
  candidate among several — it is the largest single lever left by a wide
  margin, and `intern_type` already exists with only TWO call sites
  (`types/substitution.yo`), so the mechanism is built and unused.
- **The `ExprInfo` cluster is done.** 7.35 M → 2.06 M live and 3.23 → 0.445 GB.
  Phase 4's specialization designs (no AST clone, drop generic-body trial
  infos) now target a population of 2.06 M `ExprInfo` + 3.98 M `AstExpr` =
  0.70 GB TOTAL, of which the 1.30 M cloned nodes are a part. That caps both
  designs well under 0.5 GB and demotes them below the header split.
- **The RC header is 56 B of every one of those 67.5 M objects = 3.78 GB**,
  which is why 6.18 GB of struct bytes sits under a 9.69 GB peak. Lever 8
  (56 → 32 B) is worth ~1.6 GB at today's population, second only to the
  `TypeValue` cluster, and it is a layout change that touches the GC.
- **Buffer-shape levers are dead** (see the value-cell refutation below): the
  `gross` column shows the churn is in `ArrayList(u8)` (399.9 M gross, 8.32 M
  live) and `ArrayList(String)` (48.1 M gross), which is allocation traffic,
  not retention. The peak is still the retained set.

**Tracked vs untracked, from the same run** (a type is tracked iff its C
constructor calls `__yo_gc_register`; `RC_HEADER_SPLIT.md` step 1 — the 16 B
header for cycle-incapable types — has ALREADY LANDED, which is part of why
the peak fell, so that lever is spent):

| | types | live | live bytes |
| --- | --- | --- | --- |
| tracked (56 B header) | 115 | 38.2 M | **4.76 GB** |
| untracked (16 B header) | 434 | 29.2 M | 1.42 GB |

77 % of the live bytes are in tracked objects, and the tracked list is the
`TypeValue` cluster plus `Variable`, `ExprInfo` and `Environment`. What that
leaves of `RC_HEADER_SPLIT.md`:

- step 2 (tracked `traverse_fn` → a `u32 type_id`, 56 → 48 B) is worth
  **0.31 GB** at 38.2 M tracked objects — real but no longer a headline;
- dropping one of the two intrusive GC list pairs (56 → 40 B) would be
  ~0.61 GB on top, and it is the riskiest change in the plan.

The `ArrayList(TypeValue)` row is the clearest statement of where the bytes
are: 11.12 M objects at 80 B, of which **56 B is the RC header** — a
two-element type-argument list costs more in header than in content. There
are ~1.5 such lists per live `TypeValue`, because `Func` carries five and
`Struct` two, which is why interning a type deletes far more than the type.

**Revised route to a sub-8 GB peak**, from 9.69, needing 1.7 GB: no single
remaining lever delivers it. `TypeValue` interning has the only 2.48 GB
ceiling; the tracked-header work adds ~0.3 GB (step 2) to ~0.9 GB (also
collapsing an intrusive list pair); everything else in §5's table is a
sub-0.5 GB item now that the `ExprInfo` cluster is 0.445 GB. So the target is
interning PLUS header step 2 at minimum, and interning has to deliver ~1.4 GB
of its 2.48 GB ceiling — which is exactly what the `YO_TYPE_INTERN_PROBE`
measurement (distinct vs total retained types) is for. Building it before
that number is in would repeat the value-cell mistake below.

### 0.5 The TypeValue cluster was a leak (2026-09-24)

**Audit of the plan against develop `251522b21`** (every item checked in the
tree, not from the status line):

| item | state |
| --- | --- |
| Phase 0.1 per-type census (`live_census_t.py`) | done |
| Phase 0.2 `peak_histogram.py` | **not built** |
| Phase 0.3a exit census / 0.3b peak composition / 0.3c holder attribution | done / **open** / answered for TypeValue by §0.5 (allocation-site attribution), open for the rest |
| Phase 0.4 `YO_SPEC_REPORT`, 0.5 per-release series | done |
| Phase 0.6 CI memory ratchet | **not built** (no job in `.github/`) |
| Phase 1.1 walk-context release | done (`g_retain_walk_contexts`; `ModuleWalk.env` is still retained) |
| Phase 1.2 `YO_DEBUG_WALKS` assertion build | not built (a released ctx falls back to a file-level reload instead) |
| Phase 1.3 LSP retains only OPEN documents | **not built** — `yo lsp` retains every walk (`set_retain_walk_contexts(true)`) |
| Phase 1.4 `SpecializedFunctionCache.env` removed | done |
| Phase 1.5 registry sweep of the module globals | **not done** |
| Phase 2 (F3) | done (−0.15 GB) |
| Phase 3 `Option(ref)` niche | not started |
| Phase 4 specialization without AST clones | not started (demoted, §0.4′) |
| Phase 5a TypeValue interning | superseded — see below |
| Phase 5b `Symbol` | not started |
| Phase 6 value-cell capacity / header step 2 / `Variable` inline slot | done (60 MB) / not started / not started |
| Phase 7 F8 fix + ExprInfo diet | done |
| `_find_specialization_cache` linear scan (time lever, §0.2d) | not changed |

**Baseline re-measured** (quiet machine, v0.2.41 seed = develop): `check
src/main.yo` **9.86 GB / 120 s**; self-emit (`compile src/main.yo --emit-c
--skip-c-compiler --optimize 2`) **13.04 GB / 206 s** (22.27 GB on 2026-09-20).

**Instrument 1 — exit heap walk** (`scripts/bootstrap/heap_walk_census_t.py`):
walks the GC's tracked-object list at exit and reads each object's
`dispose_fn` to type it, the TypeValue tag, and ArrayList lengths. Same run,
9.77 GB:

| TypeValue variant | live |
| --- | --- |
| `EnumT` | 3,277,418 |
| `Struct` | 2,340,364 |
| `Pointer` | 1,662,837 |
| `Func` | 149,436 |
| `SomeT` | **29,406** |
| everything else | < 12 K |

`ArrayList(ArrayList(TypeValue))` 3.22 M (2.44 M of length 2) and
`ArrayList(TypeValue)` 11.14 M (4.37 M empty, 4.89 M of length 1): the shape of
`Option(T)`-like `EnumT`s, `variant_fields = [[], [T]]`. **The §Phase 5a
conclusion that the unshared population is "the SomeT-bearing families" was
wrong** — SomeT is 0.4 % of the cluster.

**Instrument 2 — allocation sites** (`scripts/bootstrap/alloc_site_census_t.py`
+ `fid_name_map.py`): each TypeValue constructor records its two return
addresses; live objects at exit are histogrammed by (variant, caller).
**7.34 M of the 7.47 M live TypeValues (98 %) were minted by `_substitute_at`
calling itself** (`src/types/substitution.yo`) — the inner nodes of
substituted types.

**Instrument 3 — the intern table** (a probe build): `g_type_intern` held
**9,364 keys (20.6 MB of key strings)** after 12.97 M `intern_type` calls. So
the table was not the holder: the substitute results were canonicalized, and
the 7.3 M fresh nodes were simply never freed. `_substitute_at` returns
`intern_type(match(ty, ...))`; a 50-line reproducer showed any `match`/`cond`
passed directly as a call argument leaked its result (2,000 built, 0
disposed), present since at least v0.2.32. Root cause: codegen declared the
match/cond result temp with a raw type string that bypassed
`declared_c_var_names`, so the deferred-drop pass discarded the evaluator's
scheduled `___drop` as an "undeclared temp".

| compiler | `check src/main.yo` peak | wall |
| --- | --- | --- |
| develop (v0.2.41) | 9.86 GB | 120 s |
| probe: only `_substitute_at` rewritten to bind the match first | 7.59 GB | 97 s |
| **codegen fix, stage-2 compiler** | **6.84 GB** | **93 s** |

The codegen fix is worth 0.75 GB more than the one-site rewrite: other
`f(match(...))` / `f(cond(...))` sites in `src/` leaked too.

**What this changes in the plan:**

- Phase 5a (interning) is superseded: the TypeValue population was leaked
  temporaries, not missed sharing. Re-take the census on the leak-free
  compiler before building anything there; the "SomeT identity" design
  problem stated in 5a is not a memory blocker. `plans/TYPE_SYSTEM_SOUNDNESS.md`
  2.4 (per-call SomeT minting) is correspondingly not a GB-scale memory risk.
- Rule learned: **a retained population whose holder cannot be found is a leak
  until proven otherwise.** Two null interning A/Bs (§5a) measured the holders
  that exist and could not see objects that no holder references; the
  allocation-site census found it in one run.
- The CI memory ratchet (Phase 0.6) is now the most valuable open item: a
  leak like this one is invisible to every functional gate.
- The remaining levers (§0.4′: tracked header, `Variable`, `Option(ref)`)
  must be re-ranked on the post-fix census; their estimates were taken over a
  population that was 40 % leak.

### 0.6 The census re-taken on the leak-free compiler (2026-09-24)

Same recipe as §0.5 on develop `9750f44e8` (instrumented run 7.51 GB):
**45.9 M live objects, 3.75 GB of struct bytes** (from 67.5 M / 6.18 GB in
§0.4′). Live `TypeValue` 7.47 M → **191 K**. Top rows:

| type | live | live bytes |
| --- | --- | --- |
| `Variable` | 4.98 M | 0.96 GB |
| `ExprInfo` | 2.10 M | 0.45 GB |
| `ArrayList(usize)` | 11.18 M | 0.45 GB + buffers |
| `ArrayList(EvalValue)` | 4.61 M | 0.37 GB |
| `ArrayList(u8)` (strings) | 8.49 M | 0.34 GB + buffers |
| `AstExpr` / `Token` | 3.41 M / 1.94 M | 0.22 / 0.20 GB |
| `Environment` + `ArrayList(Frame)` | 1.34 M each | 0.27 GB |

What the new instruments attribute (allocation sites weighted by count and,
for lists, by live capacity):

- **All 11.18 M `ArrayList(usize)` were the frame name index**
  (`_frame_positions`, `src/env.yo`): one positions list per distinct name
  in every indexed frame (64+ bindings), up to 2048 indexes of big frames with
  thousands of names each. **Fixed:** same-named bindings are now chained
  through one `prev` array per index (`FrameNameIndex.last` +
  `FrameNameIndex.prev`); the hot "last binding" and "first binding" lookups
  allocate nothing, and the ascending list the two all-bindings callers need
  is built per call. `check src/main.yo` **6.84 → 5.96 GB (−0.88 GB, −13 %)**,
  wall unchanged (92 s); the compiler's self-emit is byte-identical to
  develop's.
- **Capture snapshots are the largest remaining buffer cost.** Three parallel
  lists of the same live capacity — `ArrayList(Variable)`,
  `ArrayList(TypeValue)`, `ArrayList(EvalValue)`, ~13.6 M slots each — come
  from `try_to_implement_function_by_function_type`'s capture loop, another
  5.8 M-slot triple from `_inject_forall_captures`, ~6 M from
  `create_specialized_function_inline`; plus the parallel `cap_names`
  `ArrayList(String)` (16 B/slot). That is the flat triple
  `plans/backlog/FUNCVAL_ENV_SHARING.md` left as its "endgame deletion": the
  shared `Variable` handles registered under `env_key` already carry the same
  bindings. Estimated ~0.8 GB.
- **Value cells:** 3.38 M of the 4.58 M one-element cells (74 %) hold an
  `UnknownVal` — runtime bindings that still get a private 80 B tracked cell.
  Sharing needs a copy-on-take rule where a cell becomes a `PtrVal` target
  (`builtins/ptr_fns.yo`) or is written in place
  (`initialization_assignment.yo`). Estimated ~0.3 GB.
- **Frame variable lists:** 273 K `ArrayList(Variable)` hold 27.5 M handles
  (5 M distinct `Variable`s) in 42.3 M slots — frames rebuilt per capture/def
  env. Covered partly by the capture work above.

### 0.7 Capture names and types from the shared handles (2026-09-24)

The first half of the `FUNCVAL_ENV_SHARING.md` "endgame deletion": a FuncVal
made at a **definition site** (`try_to_implement_function_by_function_type`,
`evaluate_anonymous_function_implementation`) no longer stores `cap_names` /
`cap_tys`. Its registered `Variable` handles were built by the same walk, in
the same order, as `cap_vals`, so position `i` of the handle list names and
types value `i`. Readers go through `FvCaptureSource` (`src/env.yo`), resolved
once per loop (`fv_capture_source` / `fv_source_name` / `fv_source_ty`, plus
`fv_capture_has_name` and the materializing `fv_capture_names` / `_tys` for
the few sites that pass lists on). `cap_vals`, the def-time value snapshot,
stays on every FuncVal. `check src/main.yo` **5.96 → 5.47 GB (−0.49 GB, −8 %)**,
wall 92 → 90.5 s; the self-emit is byte-identical to develop's.

**Why DERIVED FuncVals keep flat lists (found the hard way).** The first
version dropped the lists at the specialization / ctl / impl-inject sites too,
and stage 1 then failed to compile `src/main.yo` ("Type mismatch for type
member `value`: expected `*(u8)`, got `*(ArrayList(u8))`"). A registered list
only ever grows at its END: `adopt_resolved_definition` appends a forced
definition to the shared capture frame, which aliases the list. A derived site
copies the parent's WHOLE handle list — appended definitions included — and
then appends its own bindings, while its `cap_vals` copies only the parent's
original values. From that point handle position ≠ value position, and the
forall lookup by name read the wrong slot. Definition-site lists stay aligned
(the appended definitions sit after every original position; the two shrink
sites — `comptime_expect_error`'s stranded-variable pop and the c_include /
extern scratch truncation — only undo entries added during the current
evaluation). Derived sites now build flat names/types from the parent's
`FvCaptureSource`.

**Next lever here (~0.5 GB, not built):** derived FuncVals still COPY their
parent's handle list, flat names/types and values (the impl-inject and
specialization sites hold ~12 M live slots of each). Sharing the parent's
capture prefix by reference — `(parent env_key, own appended handles, own
values)` with `capture_env_for` concatenating at first call, which it already
memoises per key — removes all four copies. It needs a `cap_vals`
representation that is not a flat per-FuncVal list, so it is its own step.

### 0.8 Every HashMap rehash leaked its RC entries (2026-09-25)

The LSP plateau failure (`issues/lsp-memory-grows-per-open-edit-close-round.md`)
led here. The holder census (`scripts/bootstrap/holder_census_t.py`) found
~392 K `ExprInfo`s after five LSP rounds that no module global reaches, all of
them leak roots (refcount above what the unreached set explains, ~2 extra
references each), and a full collection freed none. Three instruments
narrowed it:

1. **Conservative scan** (`HOLDER_SCAN=1`): every in-use malloc block, the
   exiting thread's stack and the image's data segments, read word by word.
   67 % of the leaked ExprInfos had **no pointer anywhere**, so this was a
   missing release, not a holder. `check` of an EMPTY file showed the same
   ~28 K, so it was the evaluator in general, not the LSP.
2. **Allocation sites of the marked leak roots** (`alloc_site_census_t.py`
   with `HS_ONLY_MARKED=1`): the ordinary `new_expr_info` sites.
3. **Per-object refcount event log** (`--rc-events`,
   `scripts/bootstrap/rc_event_report.py`): each leaked object went through
   `+,+,−` inside a `HashMap.insert` on behalf of an UNRELATED key, then a
   single release from the table's dispose. That is a rehash: `_resize`
   duplicates every live bucket into the new table and was meant to release
   the old slot with `cond(Type.contains_rc_type(V) => unsafe.drop(...), true => ())`.

The emitted C of that loop was empty. `unsafe.drop` expands to `___drop`,
whose generator returns its statement text, and both `cond` lowerings
discarded the rendered code of a non-control-flow unit arm (`match` never
did). So every map with RC keys or values leaked one reference per entry per
rehash, and the compiler's ExprInfo tables grow through many rehashes. Fix:
`_emit_unassigned_arm_code` in `src/codegen/exprs/cond.yo`. The self-emit
gains exactly the missing releases (61 `(*bucket_ptr).value` drops across the
map instantiations, 15 enum-value drop switches) plus 7 unreachable
placeholder statements after `abort()` of the shape `match` already emits.

| measurement (stage-2 compilers, same tree) | develop | fixed |
| --- | --- | --- |
| `check src/main.yo` peak footprint | 5.54 GB | **2.59 GB** |
| `check src/main.yo` wall | 92 s | 95 s |
| `yo lsp`, 10 std documents × 1 round | 0.61 GB | 0.40 GB |
| `yo lsp`, 10 std documents × 5 rounds | 1.83 GB | 1.14 GB |

The LSP still grows (~0.18 GB per round, down from ~0.30): a second
per-round holder remains, see the issue. The CI memory ratchet baseline (#872,
5,333,612 kB Linux RSS) predates this fix and must be re-recorded.

### 0.9 Missing releases in expression positions: the String leaks (2026-09-25)

After §0.8 the `HOLDER_DEEP` census (`scripts/bootstrap/holder_census_t.py`)
still found **4.65 M `ArrayList(u8)` string buffers alive at `check src/main.yo`
exit (223 MB) with NO pointer anywhere**: a missing release, not a holder.
The unreached-object split marks these zero-hit objects for
`alloc_site_census_t.py --rc-events`. Its event log separates "created and
never touched" from "an increment never matched", and the allocation site
plus the emitted C of the caller then name the shape. Three codegen shapes
leaked a call's argument temp because its drop sat on an enclosing node that
no flush emitted:

| shape | example in the compiler | fix |
| --- | --- | --- |
| struct literal as a bare-expression tail | `new_frame :: (fn(..) -> Frame)(Frame(id : generate_variable_id(String.from(""), String.from("frame")), …))` | #888: the tail is materialized when ANY emittable drop is pending (`has_pending_emittable_drop`) |
| call under an operator in an `if`/`cond` condition | `if(!p.starts_with(String.from("/")), …)` (201 conditions) | #891: `_emit_cond_if_head` materializes the condition and flushes |
| call under an operator in a `cond`/`match` arm value | `c => (get_variables_from_env(env, identifier.clone()).len() > usize(0))` | #891: the arm value is assigned/materialized, then flushed |

Zero-hit `String` buffers in a sample `check` fell 121,976 → 2,636 (−98 %).
`check src/main.yo` Linux max RSS: 2,761,036 → 2,654,636 kB after #888 (the
ratchet baseline moves with each PR), then 2,654,636 → **2,486,124 kB** after
#891 (CI wall 4:32 → 3:18); the stage-2 macOS footprint median fell 2.93 →
2.63 GB with #891's condition part. Zero-hit `String` buffers at
`check src/main.yo` exit: 1,095,546 → 3,873.

### Phase 6 — per-object layout: header and `Variable`

**MEASURED 2026-09-21 — the value-cell BUFFER lever is refuted (60 MB), and
the reason corrects how every census row in §0.4 must be read.**

`value_cell_of` built each comptime value cell with `ArrayList.new()` plus one
`push`, and the first push on an empty list grows capacity to FOUR. Reading
§0.4's `ArrayList(EvalValue)` row (8.09 M live, `sizeof` 96 for `EvalValue`)
as "8 M cells × 4 slots × 96 B" predicted a 2.3 GB buffer saving from
`with_capacity(1)`. A/B on `check src/main.yo`, same tree, same `--std-path`,
develop binary vs the change:

| binary            | peak     |
| ----------------- | -------- |
| develop           | 9.78 GB  |
| capacity-1 cells  | 9.72 GB  |

**−0.06 GB.** The prediction was wrong by ~40x, and not because the
population moved: `EvalValue` is `ref(enum(...))`
(`src/value.yo`), so an `ArrayList(EvalValue)` slot is an 8-byte HANDLE, not
a 96-byte value. The four-slot growth wastes 24 bytes per filled cell, not
288, and macOS malloc buckets 8 and 32 close together besides.

**The rule this establishes for the rest of the plan: a census row's `sizeof`
is that OBJECT's size, never the element size of a list of it.** Every
reference-semantics type in §0.4 — `EvalValue`, `TypeValue`, `AstExpr`,
`Variable`, `ExprInfo`, `Frame` — is stored in lists as an 8-byte handle, so
any lever estimated from "N × list slots × sizeof(row)" is inflated by
sizeof/8. That is `TypeValue` 22x, `ExprInfo` 27x. Buffer-shape levers on
handle lists are worth tens of MB. Levers that delete OBJECTS still pay at
the row's own `sizeof`.

The change ships anyway: capacity 1 is strictly correct for a cell that holds
exactly one element for life, and the same commit closes a latent bug where
the phase-A pre-bound fill path pushed into the SHARED empty cell
(`g_empty_value_cell`) instead of minting its own.



- `RC_HEADER_SPLIT.md` step 2 (tracked header: `traverse_fn`+`dispose_fn` →
  a `u32 type_id` into a static table; the two intrusive lists → one, or an
  array-backed roots buffer): 56 → 32 B on ~30 M tracked objects. GC-touching,
  ASan-gated, layout-only (the fixpoint gate compares the header-normalized
  multiset). Only after Phases 1–4 have settled the tracked count.
- `Variable.value` inline single slot (`value_cell_of` is already the
  accessor choke point; comptime pointers `&(x)` need the cell's identity —
  keep a lazily-created cell for the `PtrVal.target_value` case only).

### Phase 7 — the super-linear compile-cost bug (F8), then the diet

**Steps 1–3 DONE 2026-09-20** (in the Phase 1 PR, because #800 had just made
it a 12 GB regression): the mechanism was the evaluator evaluating a method
receiver twice per call (once to resolve the method, once as `self`) and an
infix operator's first operand likewise, so a left-nested chain cost
2^depth — a template string with N interpolations is a 2N-deep `.+` chain
(`issues/fixed/debug-probe-line-costs-gigabytes-at-compile-time.md`). Fixed
by marking the node pre-evaluated for the call's argument matching; ratchet
in `gates_fast.sh` GATE 0 (a twelve-interpolation repro under 120 s); values
pinned in `tests/template_string_specs.test.yo`. Step 4 (the diet) is now
unblocked and stays sequenced after Phase 3.

The original investigation plan, kept for the record:

1. Distil the repro from the issue: a module-level fn with a gated `eprintln`
   whose template interpolates a match-unwrapped unknown through a large
   recursive formatter; measure seed-compile footprint with/without the line.
2. Attribute with Phase 0's census + `YO_SPEC_REPORT`: which population grows
   (ExprInfo? TypeValue? Variables?) and which function ids gain
   specializations. Hypotheses to kill in order: (a) a fresh unknown lineage
   per interpolation re-specializes `value_to_string` and everything under it;
   (b) template-string lowering evaluates each `${}` in a fresh callee env
   that is retained by a cache; (c) `match` on an unknown scrutinee trial-
   evaluates every arm with fresh bindings retained by F1's walks.
3. Fix the mechanism; add the repro as a test with a footprint ratchet.
4. **DONE 2026-09-21 (branch `perf/exprinfo-diet-v2`).** The `ExprInfoRare`
   diet re-run: 14 read/write-cold fields (`doc_comment`,
   `deferred_dup_expressions`, `capture_type`, `macro_expansion`,
   `original_expr`, `comptime_ref`, the four `index_*`, three `is_*`,
   `comptime_unrolled_bodies`, `early_return_only_deferred_drop_expressions`)
   moved into the rare group behind `expr_info_<f>` / skip-None
   `expr_info_set_<f>` accessors; `origin_type`, `deferred_drop_expressions`,
   `runtime_arg_exprs_in_order`, `control_flow`, `is_accessing_property`,
   `variable_name`, `path_collection`, `source_variable` stay inline (the
   write-rate rule). `ExprInfo` 440 → 216 B. Measured on `check src/main.yo`
   (tree 24fcd192f): **10.01 → 9.61 GB (−0.40 GB, −4 %)**, wall unchanged
   (88 s); emitted C byte-identical to the F3 compiler on the same tree. The
   2026-08-18 refutation ("source costs 3.9 GB to compile") does not
   reproduce: that cost was F8, removed by #805. Two hazards met on the way:
   a mechanical `x.field` → accessor sweep converts same-named fields on
   OTHER records (ClosureCaptureInfo, IndexCallResult, ComptimeFnCallResult,
   AsyncBlockStructInfo, DeferredAsyncBlock, VariableRare) — the type
   checker catches every one; and the open
   `issues/fixed/assignment-to-call-expression-silently-accepted.md` (a
   half-converted write `expr_info_x(ei) = v` was accepted silently) is now
   a check error, fixed on the same branch.

---

### 0.10 After the leak fixes: what is left, and a lever for the counters (2026-09-25)

Deep holder census of `check src/main.yo`, stage-2 of develop plus #904
(`holder_census_t.py`, `HOLDER_SCAN=1 HOLDER_DEEP=1`): **2.25 GB** of RC
objects live at exit. Linux max RSS by the stage-2 compiler: 2.49 GB, held by
the ratchet.

**The missing releases are gone.** Zero-hit leak roots (objects no heap,
stack or global word points at):

| type | before | after |
| --- | --- | --- |
| `ArrayList(ArrayList(String))` | 32,291 | 0 — #893 (a `match` call argument on an explicit `return`) |
| `ArrayList(u8)` | 748 | 4 — #904 (state-machine temps never stored to their slot: `read_dir`'s entries) |
| `Path` | 209 | 0 — #904 |
| `ArrayList(expr)` | 3,705 | 3,747, parked |

The parked root is the lists built in `try_to_convert_to_numeric_type`'s
`__yo_as` lowering. They have zero RC events after allocation, and the expr
dispose does release `FnCall.args`, so the holder that dies without releasing
them is still unknown. They total about 0.3 MB; parked on cost.

**The 303 MB "unreached" group is not a leak.** It survives a full cycle
collection and has heap hits: objects held by the running command's stack
locals (the check driver's contexts) rather than by a module global.

First-reach holders, largest first:

| holder | size |
| --- | --- |
| `_type_trait_methods` (the shared graph) | 546 MB |
| `g_funcval_cap_vars` | 262 MB |
| `g_macro_expansions` | 217 MB |
| `g_method_callee_values` | 217 MB |
| `g_ifc_memo` | 197 MB |
| `g_frame_indexes` | 94 MB (exclusive) |
| `g_emission_occurrence` | 78 MB (exclusive) |
| `g_finished_walks` | 46 MB (exclusive) |

`g_finished_walks` is already context-free outside watch and LSP (F1); what is
left is the definitions the post-walk miss fallback serves.

**The emission-name counters kept 66 MB of key strings.**
`g_emission_occurrence` counted temp and label ordinals under
`"<module path>:<row>:<col>[:<slot>]"` string keys: 428,645 of them.

It is now keyed by the key's FNV-1a hash (`HashMap(u64, usize)`), and the temp
minter passes the hash it already computed. A collision only merges two
counters, and the names built from them also carry the hash (temps) or the
position (labels), so they stay distinct. The compiler's emitted C is
byte-identical to develop's (146.8 MB, `cmp`). The exclusive share drops from
78 MB to the map storage (the Linux ratchet reading is on the PR).

**The frame name index copied every name it keyed.** `_frame_index_refresh`
inserted `v.name.clone()`, and `String.clone` copies the bytes: 723,641
private copies (61 MB of `g_frame_indexes`' 94 MB exclusive share) of names
every `Variable` already holds. The key now shares the binding's buffer.
`HashMap.insert` dups a borrowed key into its `MapEntry`, so ownership is
unchanged. `check src/main.yo` under `MallocScribble` stays clean, and the
fixpoint holds.

**Incremental compilation checked against the campaign (#901).** A per-owner
purge must cover every cache that can hand back the ids it drops. #883's
per-function purge left the specialization cache pointing at deleted function
types. The first `build --watch` round after an edit then emitted an
untranspiled call. Nothing else runs codegen after an invalidation, so nothing
else could see it. The spec cache is now owner-tagged and purged in the same
step (`issues/fixed/build-watch-reuses-a-stale-imported-module.md`; the
testing instructions carry the smoke recipe).

**Next levers, re-ranked on these numbers:**
- **Derived-FuncVal capture sharing (§0.7):** `g_funcval_cap_vars`, 262 MB.
- **The frame name index (#873):** after the key sharing, what remains is
  the per-frame maps and `prev` lists (~33 MB).
- **`g_macro_expansions` / `g_method_callee_values`:** these hold AST and
  FuncVal graphs keyed per call site. Measure their exclusive share with
  `HOLDER_DEEP_LAST` before choosing.

### 0.11 What `compile` keeps that `check` does not: executed CTFE clones (2026-09-25)

`compile src/main.yo` peaked at 6.70 GB in its front half against ~2.7 GB for
`check`. The difference is F1 in reverse. `check` gives each module its own
`ExprInfoTable`, which dies with the module's walk. `compile` shares ONE table
across every module (codegen reads any function's metadata), so everything
the evaluator ever recorded lives until exit.

A probe build that logged codegen's `expr_info_table_get` calls and the live
malloc bytes found the table already at 5.7 GB when codegen started. Of its
2.95 M entries, codegen reads 1.92 M; the other 1.03 M pinned 2.1 GB.
Tagging each `clone_expr_fresh_ids` id with its call site split that 2.1 GB
as follows:
- executed CTFE body clones: 119 K entries, 1.56 GB;
- call-overload trial clones: 286 K entries, 176 MB;
- the rest: under 60 MB.

`evaluate_comptime_fn_call` now drops an executed clone's metadata once the
call's value is out, keeping any subtree that evaluated to a function (a
method or closure defined in the body can outlive the call). Emitted C is
byte-identical, and codegen reads none of the 268 K purged ids. The compile
front half drops **6.70 → 5.07 GB** footprint. Record:
`issues/fixed/ctfe-clone-metadata-outlives-the-call.md`.

Overload-trial clones cannot be purged the same way. A trial that type-checks
a generic callee with a cloned closure argument creates and caches a
specialization that holds the clone, and codegen reads 2,848 of those
entries.

### 0.12 Exclusive shares re-taken; synthesized tokens copied their source (2026-09-25)

The §0.10 ranking was by first reach. Re-taken with `HOLDER_DEEP_LAST` per
root (the root walked last gets exactly its exclusive bytes), on a compiler
with the §0.11 purge, `check src/main.yo`:

| root | first reach | exclusive | what it is |
| --- | --- | --- | --- |
| `_type_trait_methods` | 547 MB | 13 MB | shared graph; the snapshot ring and others reach the rest |
| `g_funcval_cap_vars` | 262 MB | 220 MB | derived FuncVals' flat capture lists (§0.7's next lever) |
| `g_macro_expansions` | 218 MB | 218 MB | 216 MB of it: 14,559 ~15 KB strings under expansion `Token`s |
| `g_method_callee_values` | 217 MB | 4 MB | shared with `g_specialized_fn_caches` |
| `g_ifc_memo` | 198 MB | 198 MB | 3,195 memoized FuncVals, each with ~1–2 K-entry flat capture lists |

**The expansion strings were copies of whole module sources.** Eleven sites
that synthesize a token from a source token wrote `input : tok.input.clone()`
(and the same for `module_path`). `String.clone` copies the bytes, so each
such token carried its own copy of its module's source text, while every
lexed token shares one. The sites: gensym, the `begin` atom `match` builds for
every arm with pattern tests, the numeric/pointer conversion atoms, the `&`
atom of receiver trials and method dispatch, the pattern compiler, two
contract sites and two formatter sites. They share the handles now. `check
src/main.yo` **2,504 → 2,159 MB (−345 MB, −14 %)**, same wall; emitted C
byte-identical (148.3 MB). Record:
`issues/fixed/synthetic-tokens-copy-their-source-text.md`.

**Next, on these numbers:** the derived-FuncVal flat capture lists are now the
largest exclusive holder, in two registries: `g_funcval_cap_vars` 220 MB plus
most of `g_ifc_memo`'s 198 MB (its FuncVals' `cap_names` 91 MB,
`cap_tys` 46 MB, `cap_vals` 46 MB). That is §0.7's prefix-sharing step,
about 0.4 GB.

### 0.13 Derived FuncVals stay aligned with their parent's handles (2026-09-25)

§0.12's largest exclusive holders were the derived-FuncVal capture copies.
Each specialization, ctl instance and impl-generic injection copied four lists
to append one to three bindings: the original's whole handle list,
`cap_names`, `cap_tys` and `cap_vals`. In the compiler's modules, a
module-level function captures ~1,780 bindings.

The flat names/types existed only because the inherited handle list was not
parallel to the values (§0.7). It carried definitions `adopt_resolved_definition`
appended to the original's capture frame after its capture, between the
original's positions and the derived bindings. A derivation now takes only
the parent's first `n_vals` handles, the ones naming the values it copies,
when the parent is aligned: `cap_names` empty and at least that many handles
(`aligned_derived_capture_handles`, `src/env.yo`). It appends one handle per
value it appends, so it is aligned too, and reads names/types through its
handles like a definition-site FuncVal. A definition it leaves out is
re-resolved by a lookup miss in its capture env, as it was for the parent. A
derivation from a flat parent keeps the flat lists.

`check src/main.yo`, A/B on the same base (c0af6bb1f): **2,069 → 1,551 MB
peak footprint (−518 MB, −25 %)**, same wall; emitted C byte-identical (149.1 MB).
Test: `tests/internal/module_invalidation.test.yo` "captures: a specialization of a
handle-backed FuncVal stores no flat capture lists" (13,594 flat names with the
rule disabled, 0 with it).

**Exclusive shares re-taken on this compiler** (`HOLDER_DEEP_LAST`, `check
src/main.yo`): `g_macro_expansions` 218 → 3 MB (#915), `g_ifc_memo` 198 →
77 MB, `g_specialized_fn_caches` 8 MB. `g_funcval_cap_vars` still holds
**218 MB exclusively**, and 207 MB of that is 14,732 `ArrayList(Variable)` of
~1,760 handles each. The `Variable`s are shared (4 MB); the cost is one private
handle list per FuncVal, definition-site ones included.
`try_to_implement_function_by_function_type` (and its twin in
`anonymous_function.yo`) copies every variable of every frame of the defining
env into `cap_vars`, beside a `cap_vals` snapshot of the same length.

**Next lever: frame-slice captures.** A module-level function's capture list
is a prefix of its defining frames' `variables` lists, and so is every other
function's in that module. Recording `(frame list, length)` slices instead of
copies would remove the ~0.2 GB of handle lists, and the `cap_vals` snapshots
next to them if the value side can follow. Four constraints decide the design:
- `cap_vals` is a snapshot. A forward-declared comptime fn filled later reads
  `VarRef` at capture time, so values cannot simply be read from the live
  handles.
- The slice length is the snapshot bound that ordered runtime globals (the
  E0906 forward-reference rule) rely on.
- The `__recur_fn` binder is skipped, which breaks the prefix shape.
- `adopt_resolved_definition` appends to the capture frame through the alias.

## 6. Gates (every phase)

1. `yo check ./src --std-path ./std` and `yo check ./std --std-path ./std`.
2. `yo compile src/main.yo --skip-c-compiler` (async state-machine rules fire
   only in codegen).
3. `S1=<bin> P=<tag> bash scripts/bootstrap/gates_fast.sh` and
   `bash scripts/bootstrap/fixpoint_only.sh` (stage-2 ≡ stage-3).
4. **Emitted C byte-identical** for Phases 1, 2, 4, 5, 6 (corpus diff-test +
   self-emit `cmp`); for Phase 3 the one legitimate shift, then identical.
5. The dup/drop emit-diff gate (per-function dup/drop counts, old vs new
   emit; fewer dups = a new cancellation = potential UAF).
6. Linux ASan run of the fast suite for any layout or GC change (Phases 3, 6).
7. Memory: footprint AND tracked live before/after, on `check src/main.yo`
   and on the self-emit, recorded in §0 of this document with the date.
8. The CI memory ratchet (Phase 0 step 6) stays green.

## 7. Open questions

- Is today's `check` doing codegen-era work (forcing walk / def-time trials /
  contract lowering), or did something regress between 0.2.31 and 0.2.37?
  Phase 0 step 5 answers it; it decides whether a regression fix comes first.
- How much of the 19.3 GB is per-module tables (F1) versus specialization
  structures reachable from the module cache (F2)? Phase 0 step 3's
  holder-attribution answers it and re-ranks levers 1 and 5.
- Does the LSP need `ExprInfo` for closed documents (workspace symbols,
  references)? If yes, Phase 1 step 3 keeps a name-level index instead.
- F8's mechanism. Until it is known, treat every added call in
  `src/evaluator/calls/*.yo` and `types/synthesizer.yo` as a footprint risk
  and measure the seed compile before merging.
