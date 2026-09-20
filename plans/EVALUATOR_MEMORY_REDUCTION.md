# Evaluator memory reduction — audit and implementation plan

**Status: ACTIVE 2026-09-20 — audit complete, nothing implemented.** Written
after measuring the current tree (§0) and re-reading every earlier memory
campaign (§3). Companion research: `backlog/ARENA_ALLOCATOR_FEASIBILITY.md`
(whether an arena allocator can help; short answer: not with this problem).

The one-paragraph version: the evaluator's footprint is **retention of live
metadata, not allocation churn**. Every expression ever evaluated leaves a
456 B `ExprInfo` plus its own `Environment` snapshot in a table that is a
process-lifetime root; every specialization re-evaluates a fresh-id clone of
its body and adds a full set of them; every binding ever made leaves a 224 B
`Variable`; every one of those objects carries a 56 B cycle-collector header
and a handful of 40 B `ArrayList` cells. `yo check src/main.yo` — evaluator
only, no C emitted — now peaks at **19.3 GB** on this tree (§0.1). The plan
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
| 2026-08-24 | one 5-line debug probe               | seed compile 17.5 → 29.1 GB, +2.9× wall, probe never fires   | `issues/debug-probe-line-costs-gigabytes-at-compile-time.md` |
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

## 1. Where the bytes are: the data model

Sizes are `sizeof` on the emitted C (arm64), taken from the 2026-08 censuses and
re-derived from the field lists in the current source; the 56 B / 16 B header
choice is read from the constructors in the emitted C (§1.3). Phase 0 re-counts
them with the durable census; treat the counts as ceilings until then.

### 1.1 The core objects

| type (file)                               | sizeof | header | why it is this size                                                                                                                                         | population per self-compile (last census) |
| ----------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ExprInfo` (`src/expr_info.yo`)           | 456 B  | 56 B   | 3 required handles + **24 `Option(...)` fields at 16 B each** (tag + payload; no niche for ref handles); 19 of 24 are ≤2.5% occupied at exit               | 5.65 M live (2.40 GB)                     |
| `Environment` (`src/env.yo`)              | 112 B  | 56 B   | `frames : ArrayList(Frame)` + 2 Strings + `Option(usize)`; **one per `ExprInfo`** — `new_expr_info` calls `snapshot_env`, which allocates a fresh list too | 5.68 M live (0.59 GB) + 5.68 M frame lists |
| `Variable` (`src/env.yo`)                 | 224 B  | 56 B   | 10 handles/ints + `ArrayList(EvalValue)` value cell + 10 grouped bools; `value` is a separate 40 B object when the binding has a comptime value             | 10.4 M live (1.86 GB)                     |
| `TypeValue` (`src/types/definitions.yo`)  | 168 B  | 56 B   | `ref(enum)`, ~40 variants; the size is the largest variant's payload (`TraitT`/`SomeT`: 10-11 handles)                                                       | 13 M → 11.6 M after `substitute` interning |
| `AstExpr` (`src/expr.yo`)                 | ~64 B  | 56 B   | `FnCall(id, func, args, is_infix, token)`; specialization deep-clones bodies with fresh ids (`clone_expr_fresh_ids`, 54 call sites)                        | 4.9 M live                                |
| `Token` (`src/token.yo`)                  | 136 B  | 56 B   | 8 fields incl. 3 Strings (`value`, `module_path`, `input`); `Token.clone` returns self                                                                       | 2.2-3.6 M live                             |
| `ArrayList(T)` (std)                      | 40 B   | 16 B   | `_ptr, _length, _capacity` + small header; **the majority class**: strings, value cells, type child lists, frame lists                                       | 114 M live blocks at peak (4.0 GB)         |
| `String` (std) = `newtype(Option(ArrayList(u8)))` | 16 B inline | — | a String FIELD is 16 B (tag + handle) plus its 40 B `ArrayList(u8)` object plus the byte buffer: **three allocations' worth of overhead per name**   | 8-43 M `ArrayList(u8)` live                |

Two consequences follow from the table alone:

1. **One evaluated expression costs ≈ 456 + 112 + 40 (+ 8·frames) ≈ 650 B
   before its type or any child list.** At 5.65 M `ExprInfo`s that is ~3.7 GB
   of pure per-node bookkeeping, of which the `Environment` + frame list share
   (~150 B/node) is 100% redundant within a scope (§2 F3).
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
evaluator object is tracked**, so the split's win landed almost entirely on
`ArrayList`/`String` cells. The tracked header is 12% of an `ExprInfo`, 25% of
a `Variable`, 33% of a `TypeValue`, 50% of an `Environment`. `RC_HEADER_SPLIT.md`
step 2 (type-id registry instead of two function pointers, roots list as an
array: 56 → 24-32 B) is still open; §5 Phase 6.

---

## 2. Findings

Each finding states the mechanism, the evidence, and what it implies. F1–F4
are new to this audit; F5–F9 consolidate what earlier plans measured so the
lever ranking in §4 has one source.

### F1. One-shot commands retain every module's whole evaluation context

`begin_module_walk` stores `ModuleWalk(ctx : copy_eval_context(ctx), env, defs,
…)` and `end_module_walk` moves it into `g_finished_walks`, where nothing removes
it except a re-walk of the same path. `copy_eval_context` shares the
`expr_info_table` handle (`context.yo:1545`). The registry exists for the LSP
and `check --watch` (`mm_revalidate_plan`/`mm_revalidate_apply`, per-definition
revalidation — `reference/INCREMENTAL_COMPILATION.md`), and for `yo check`
without `--watch`, `yo compile`, `yo build`, `yo test`, `yo doc`, `yo verify` it
is dead weight: the walk is never consulted after the module finishes.

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

Evidence: §0.2; `clone_expr_fresh_ids` (54 call sites, 9 in `calls/function.yo`,
7 in `calls/helper.yo`, 12 in `builtins/contracts.yo`); `g_fid_specs` /
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
5.68 M `Environment` ≈ 5.65 M `ExprInfo` in the census — a 1:1 population.

Implication: a scope-version memo (bump a counter on every `push_env_frame` /
`pop_env_frame` / direct `frames` mutation; `new_expr_info` reuses the last
snapshot when the version and the env identity match) deletes most of 5.68 M
`Environment` + 5.68 M list objects (~1.2-1.5 GB tracked live) with **no
semantic change and byte-identical C**. This is the cheapest multi-hundred-MB
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

`backlog/TYPEVALUE_HASH_CONSING.md` measured 13 M live `TypeValue`s (~2.5 GB
with their child lists), landed interning at `substitute()` (−1.45 M) and made
`TypeValue.clone` return self. The remaining population is construction-site
minted (25 variants, ~86 sites). Recursive interning at the constructor
factories is designed there and not built; the construction-site memo is the
only form that also cuts the transient peak.

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
compile (`issues/debug-probe-line-costs-gigabytes-at-compile-time.md`, open).
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

---

## 4. Levers, ranked

"Saving" is the best available estimate with its provenance; Phase 0 replaces
every estimate with a measurement before the phase that spends it starts.
"C identical" = the emitted C must stay byte-identical (the gate that caught
the prune).

| #  | lever                                                                  | est. saving                                | risk   | C identical | phase | evidence            |
| -- | ---------------------------------------------------------------------- | ------------------------------------------ | ------ | ----------- | ----- | ------------------- |
| 1  | Drop `ModuleWalk.ctx`/`env` retention outside watch/LSP (F1)           | up to the per-module tables — measure      | LOW    | yes         | 1     | §1.2, F1            |
| 2  | Drop `SpecializedFunctionCache.env` (never read back) (F2a)            | one callee `Environment` + list per spec   | LOW    | yes         | 1     | `helper.yo:1571`    |
| 3  | Scope-version env-snapshot sharing in `new_expr_info` (F3)             | ~1.2-1.5 GB tracked live (5.7 M envs + lists) | LOW  | yes         | 2     | census 1:1 counts   |
| 4  | `Option(ref)` niche in codegen (F4)                                    | ≥0.5 GB `ExprInfo` alone; every String field −8 B | MED (layout) | NO — full battery + ASan | 3 | §1.1             |
| 5  | Specialization without AST cloning; drop generic-body trial infos (F2b/c) | up to 4.9 M `AstExpr` + a share of `ExprInfo` — measure | HIGH | should be | 4 | F2               |
| 6  | Recursive `TypeValue` interning at constructors (F5)                    | multi-GB ceiling per its plan; measure count first | MED | yes         | 5a    | `TYPEVALUE_HASH_CONSING.md` |
| 7  | `Symbol` interning for names/ids (F7)                                  | strings population — measure               | HIGH (broad) | yes   | 5b    | F7                  |
| 8  | Tracked RC header 56 → 24-32 B (type-id registry, roots array)          | ~1 GB at ~30 M tracked objects             | HIGH (GC) | layout-only | 6  | `RC_HEADER_SPLIT.md` step 2 |
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

1. **`scripts/bootstrap/live_census_t.py`** — the per-type live census for the
   current `__yo_tN` naming (a working draft exists in this session's
   scratchpad: +1 at each `__yo_new___yo_tN` definition; −1 at the entry of
   the `yo_id_K` the constructor installs as `header.dispose_fn`; dump
   `live gross sizeof name` per type from a destructor; types with no
   `dispose_fn` are labelled as ceilings). Input: `yo compile src/main.yo
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
   `check src/main.yo` and on `check ./src/types`: (a) per-type live at exit;
   (b) peak composition; (c) **retention by holder** — extend the census with
   a second counter keyed by the ROOT that retains the object at exit (walk
   `g_finished_walks` → tables → count reachable `ExprInfo`/`Environment`/
   `Variable`; walk `g_specialized_fn_caches`; walk the module cache; the
   remainder is "other roots"). This is the measurement the prune post-mortem
   asked for and never got. Record the result in this document's §0.
4. **Specialization counts**: a `YO_SPEC_REPORT=1` env knob (read once at exit
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
   `(g_retain_finished_walks : bool) = false` with `set_retain_finished_walks`;
   `end_module_walk` inserts into `g_finished_walks` only when the flag is
   set, and otherwise stores a SLIM record (`module_path`, `defs`, hashes —
   everything `mm_changed_definitions` / `finished_walk_for` callers on the
   non-watch path actually read; audit each `finished_walk_for` site in
   `module_manager.yo:437-1202` and list what it dereferences). Set the flag
   in `run_check` when `--watch`/`--watch-once` is given and in `yo lsp`'s
   server start. `yo compile`/`build`/`test`/`doc`/`verify` never set it.
2. **Prove the walk is dead on the one-shot path**: an assertion build
   (`YO_DEBUG_WALKS=1`) that panics if `finished_walk_for` returns a slim
   record and the caller touches `.ctx`/`.env`; run `check ./src`,
   `check ./std`, `compile src/main.yo --skip-c-compiler`, the fast suite.
3. **LSP: retain only open documents.** `mm_forget_open_document` drops that
   document's walk `ctx` (keeping the slim record); `mm_set_open_document`
   restores full retention on the next walk. Gate with the LSP tests under
   `tests/internal/` and a long-lived `yo lsp` session (open/edit/close 50
   documents, footprint must plateau).
4. **`SpecializedFunctionCache.env`**: confirm by grep + the assertion build
   that no reader exists besides `_store_specialization_cache`; delete the
   field (and the parameter). If a reader exists, store the frame COUNT it
   needs, not the env.
5. **Registry sweep**: for each of the 288 module-level globals, classify
   {bounded, per-module (purgeable by owner), per-function (purgeable by
   owner), process}. Record the table in this document. For the per-function
   `g_func_*` side tables, add the owner tag the B2 purge already uses for
   trait methods/impls so `mm_invalidate_document` can purge them too
   (LSP steady-state leak; measure with step 3's long session).
6. Measure `check src/main.yo` and the self-emit (footprint + tracked live);
   update §0.

### Phase 2 — env-snapshot sharing (F3): byte-identical C

1. **Re-audit mutation of stored snapshots by instrumentation, not grep**: a
   debug build where `snapshot_env` marks the returned `Environment` frozen
   (a bool field, debug-only) and `push_env_frame`/`pop_env_frame`/every
   `env.frames.<mutator>` site panics on a frozen env. Run the fast suite,
   `check ./src`, `check ./std`. Fix any hit by copying before mutating.
2. **Scope version.** Add `(snapshot_version : usize)` to `Environment`
   (bumped by `push_env_frame`, `pop_env_frame`, `add_variable_to_env`
   creating a new frame, `clone_env`, and every direct `frames.push/pop`
   found in step 1) and a per-env memo `(last_snapshot : Option(Environment),
   last_snapshot_version : usize)`. `snapshot_env(env)` returns the memoized
   snapshot when the version matches, else builds one and memoizes it.
   Adding fields to `Environment` changes `sizeof` by 8-32 B — net negative
   once 5 M snapshots collapse; confirm with the census.
   Note the memo must hold a handle to the snapshot (an RC bump), and the
   snapshot must not point back at the live env (no cycle).
3. Prove: emitted C byte-identical on the corpus (`scripts/cli-diff-test.sh`
   + the self-emit diff), `fixpoint_only.sh`, `gates_fast.sh`. Measure:
   `Environment` live count should fall by the share of consecutive
   same-scope infos (expect >80%); footprint and tracked live recorded here.
4. **Frame list buffers**: with snapshots shared, the remaining per-snapshot
   `ArrayList(Frame)` is per SCOPE; leave it.

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

Gated on Phase 0 step 4's counts. Two candidate designs, both "should be
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
- **5b** `Symbol :: newtype(u32)` + a global intern table (`std`-free, in
  `src/utils.yo`): start with `Variable.name` and the frame index keys (one
  lookup path, `get_variables_from_frame`/`_frame_positions`), measure, then
  `Token.value` for identifiers (diagnostics render through the table). Each
  step is a broad mechanical refactor; land per field, byte-identical C.

### Phase 6 — per-object layout: header and `Variable`

- `RC_HEADER_SPLIT.md` step 2 (tracked header: `traverse_fn`+`dispose_fn` →
  a `u32 type_id` into a static table; the two intrusive lists → one, or an
  array-backed roots buffer): 56 → 32 B on ~30 M tracked objects. GC-touching,
  ASan-gated, layout-only (the fixpoint gate compares the header-normalized
  multiset). Only after Phases 1–4 have settled the tracked count.
- `Variable.value` inline single slot (`value_cell_of` is already the
  accessor choke point; comptime pointers `&(x)` need the cell's identity —
  keep a lazily-created cell for the `PtrVal.target_value` case only).

### Phase 7 — the super-linear compile-cost bug (F8), then the diet

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
4. Then re-run the `ExprInfoRare` diet from branch `perf/exprinfo-diet`
   (the salvage list in `RC_HEADER_SPLIT.md`: occupancy data, the write-rate
   rule — a field goes to the rare group only if read-cold AND write-cold —
   and `origin_type` stays inline). With F4 landed the inline cost is already
   halved; re-measure before deciding whether the group is still worth it.

---

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
