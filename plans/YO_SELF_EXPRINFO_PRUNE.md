# ExprInfo retention — the last multi-GB memory lever in `yo-self`

Status: **DESIGN, not implemented — but the payoff is MEASURED, not estimated:
codegen reads 843,691 of the table's 3,390,355 entries (24.9%), so 75% of it is
pure retention worth ~3.5–4 GB (§4b).** Measurements below are from 2026-08-04 at
`2b6aa1db7` + the round-15 layout diets. Read
`plans/YO_SELF_STAGE2_HANDOFF.md` §"Memory footprint of a self-emit" first —
this document is the detail behind the last bullet there.

## 1. The problem in one paragraph

TypeScript attaches evaluation metadata to the AST node itself (`expr.$`), so
when `clone_expr_fresh_ids` output is discarded, V8 collects the clone, its
`$` record, and the `Environment` that `$` pointed at. `yo-self` cannot do that
(the AST is immutable), so it keeps a side table —
`ExprInfoTable :: newtype(data : HashMap(ExprId, ExprInfo))` — and **that table
is a permanent GC root**. Nothing an evaluation ever records is released.

The retention chain, measured with `scripts/bootstrap/live_census.py`:

```
ExprInfoTable (1 shared HashMap)
  └─ 3.35 M ExprInfo               (1476 MB at 440 B; 1527 MB at the final 456 B)
       └─ env : snapshot_env(...)  →  3.33 M Environment (373 MB)
            └─ frames             →  3.32 M ArrayList(Frame) (266 MB)
                 └─ Frame         →  7.43 M Variable (1664 MB at 224 B)
                      ├─ value    →  6.33 M ArrayList(EvalValue) (506 MB)
                      └─ name/…   →  a large share of 8.00 M ArrayList(u8) (640 MB)
```

Totals 7.17 GB accounted against 8.32 GB measured RSS (86%); the rest is the raw
`malloc`'d backing arrays of those ArrayLists/HashMaps plus allocator overhead.
(An earlier partial census run reported ~30% lower counts — 2.36 M ExprInfo /
6.74 M Variable / 6.06 GB — and accounted for only 74% of RSS. Prefer the
numbers above; re-measure rather than trusting either if the input changes.)

**7.43 M live `Variable`s is one per binding EVER MADE during the compile.**
TypeScript makes a comparable number of bindings (8.34 M `addVariableToEnv`
calls, `YO_DEBUG_CALL_PROFILE=1`) but retains only what is still reachable.

## 2. Two hard measurements that constrain any fix

### 2.1 The peak is at the END of evaluation, not during codegen

RSS sampled once per second through a stage-1 emit (`compile yo-self/main.yo
--release --emit-c --skip-c-compiler`, libc allocator):

| t (s) | 0–20                     | 20–55        | 55–68                    | 69          | 69–82                  | 82–103               |
| ----- | ------------------------ | ------------ | ------------------------ | ----------- | ---------------------- | -------------------- |
| RSS   | 1.5 GB flat (parse/load) | 1.5 → 6.0 GB | 6.0 → 7.6 GB, dip to 7.2 | jump to 7.8 | 7.8 → **8.16 GB peak** | decline to 7.8, exit |

The dip-then-jump at t≈68/69 is the eval→codegen transition. So a prune placed
at the boundary (`codegen/codegen_c.yo:357`, after all collection) frees
gigabytes **for the codegen phase but cannot lower the peak**, which is already
~7.6 GB when evaluation ends. **Any fix that is supposed to move the peak must
run DURING evaluation.**

### 2.2 `check` already proves most of it is droppable

`check` peaks at **3.78 GB / 69 s**; `compile --emit-c` peaks at **8.32 GB /
98.8 s** on the same input. The difference is not the codegen work — it is that
`eval_context_new` (`evaluator/context.yo:368`) gives every context a FRESH
`ExprInfoTable` that dies with the context, while the compile path overwrites
every context's table with one process-lifetime `g_shared_expr_info_table`
(`main.yo:1100` publishes it; `main.yo:1130` entry module, `main.yo:558` every
demand-loaded module, `main.yo:782` prelude). `check` therefore drops each
module's infos at module completion. Compile keeps all of them because codegen
needs a subset spanning every module.

## 3. What codegen actually needs (audited 2026-08-04)

### 3.1 Readers

- `expr_info_table_get` directly under `yo-self/codegen/`: 10 real sites —
  `codegen/functions/collection.yo:84,117,480,568,577,626,682,853,1140` and
  `codegen/types/collection.yo:520`.
- `CodeGenContext.get_expr_info` (`codegen/utils/index.yo:347`): **226 call
  sites across 37 files**. Everything goes through this accessor, which makes
  it the single instrumentation point (see §5).

### 3.2 Mark roots

1. `base.function_order` → `base.get_function_entry(fid).value` →
   `FuncValData.body` (`codegen/utils/index.yo:89,135,142`) — every collected
   function body AST. This is the dominant root.
2. `get_module_level_init_exprs()` (`expr_info.yo:1025`), read at
   `codegen/types/collection.yo:657` and `codegen/functions/generation.yo:717`.
3. Specializations minted _during_ collection —
   `codegen/functions/collection.yo:979,989,1138,1150` (trace/dispose methods).
   Their bodies are `clone_expr_fresh_ids` clones, so they carry fresh ids that
   did not exist when the module finished evaluating. **A per-module prune must
   not assume the id space is closed.**
4. ExprId-keyed side tables that codegen reads and that hold ASTs:
   - `g_macro_expansions : HashMap(ExprId, AstExpr)` (`expr_info.yo:1005`) —
     read at `codegen/types/collection.yo:567`,
     `codegen/exprs/generation.yo:422`, `codegen/functions/collection.yo:514`.
   - `g_method_callee_values : HashMap(ExprId, EvalValue)`
     (`expr_info.yo:577`) — a resolved method `FuncVal`, so its body is an AST
     root; read at `codegen/exprs/other_fn_call.yo:1027,1045,1244`,
     `codegen/functions/collection.yo:671`.
   - `g_closure_await_analysis : HashMap(String, AwaitAnalysisResult)`
     (`evaluator/async/await_analysis.yo:639`) — keyed by func_id, holds
     `AwaitPoint → AstExpr`; read at `codegen/exprs/async.yo:1446,1465`.

### 3.3 The mark must be TRANSITIVE through ExprInfo

An `ExprInfo` that survives can itself name AST nodes that are NOT in any body
AST (synthesized `___dup`/`___drop` calls, unrolled loop bodies, macro
expansions). Fields to follow:

- Direct `AstExpr`: `runtime_arg_exprs_in_order`, `deferred_dup_expressions`,
  `deferred_drop_expressions`, `consumed_variable_drop_expressions`,
  `async_stack_size`, `macro_expansion`, `original_expr`,
  `comptime_unrolled_bodies`, `early_return_only_deferred_drop_expressions`.
- Through `EvalValue` (`value.yo:24` `FuncVal(FuncValData.body)`, `:191`
  `ExprVal(expr)`): `value`, `dyn_call_trait_values`,
  `primitive_pattern_values`, `closure_function_value`, `index_method_value`,
  `comptime_ref`.
- Through analysis results: `await_analysis` / `effect_analysis` both embed
  `SuspensionPoint` (`evaluator/shared/suspension_analysis_types.yo:36,53`)
  which holds `expr : AstExpr` and `enclosing_while_expr : Option(AstExpr)`.

After round 15 nine of those live behind `ExprInfo.rare` and must be read via
the `expr_info_<field>` accessors.

`AstExpr` itself is trivial to walk — `ref(enum(Atom(id, token),
FnCall(id, func, args, is_infix, token)))` (`expr.yo`), so children are `func`
plus `args`.

**Not AST-bearing** (do not follow): `env`, `ty`, `path_collection`,
`RuntimeDestructuring` (plain strings + TypeValue), every `TypeValue` field —
`types/definitions.yo` contains no `AstExpr`.

## 4. Recommended shape: release the ENV, keep the entry

Two variants were considered.

|                                 | frees                                                                                                                           | failure mode if a root is missed                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `table.data.remove(id)`         | ExprInfo (624 B) **and** the chain below it                                                                                     | codegen reads `.None` where it expected an info — can crash or silently emit wrong C |
| **`info.env = g_released_env`** | everything below `ExprInfo` (~2.6–3.0 GB: Variables, cells, Environments, frame lists, name strings) — but not the 624 B record | a `.env` read yields an empty env; `.ty` / `.value` / drop lists all still correct   |

**Take the second.** It captures the large majority of the prize with a much
narrower failure surface, and it can be upgraded to full removal later once the
mark is trusted. Note codegen reads `.env` at 96 sites, so the mark still has
to be right — it just degrades less violently when it is not.

Placement: at each module's completion (the demand loader, `main.yo:558`, and
the entry module at `main.yo:1135`), not at the codegen boundary — see §2.1.

Bookkeeping needed:

- `g_info_ids_since_mark : ArrayList(ExprId)`, appended in
  `expr_info_table_set`, cleared after each prune (peak ~48 MB for 6 M ids).
- a mark set `HashMap(ExprId, bool)` + an explicit worklist (NOT recursion —
  see the 1 GiB-stack note in `AGENTS.md`).
- one shared empty `Environment` global, mirroring `g_empty_value_cell` and
  `g_empty_path_collection`.

## 4b. MEASURED: codegen reads only a quarter of the table

Instrumenting `CodeGenContext.get_expr_info` (`codegen/utils/index.yo:347`) to
record every id it is asked for, over a full self-emit:

```
RETENTION_DIAG read_ids=843691 table_entries=3390355
```

**843,691 of 3,390,355 entries — 24.9%. Codegen never looks at the other
2,546,664 (75.1%).** That is the size of the prize, and it is the number that
justifies this whole arc:

| dropped if the mark is tight                                | bytes                                  |
| ----------------------------------------------------------- | -------------------------------------- |
| 2.55 M ExprInfo @ 456 B                                     | 1.16 GB                                |
| their Environments @ 112 B                                  | 0.29 GB                                |
| their ArrayList(Frame) @ 80 B                               | 0.20 GB                                |
| the Frames → Variables/cells/name strings they were pinning | a large share of 1.66 + 0.51 + 0.64 GB |

So **~3.5-4 GB**, against a **9.08 GB** peak footprint (after r15+r16) and a
6.05 GB TS target. This is the only remaining lever of that size, and after r15+r16
the layout diets are exhausted — everything still inline in `ExprInfo` and
`Variable` is a field that IS set often.

Two caveats on the number. It counts ids codegen ASKED for, through the accessor
that covers 226 of the 236 reader sites, so the true read set is marginally
larger. And the read set is not itself a usable mark: it is only known after
codegen, and the mark must additionally cover anything the EVALUATOR reads from a
finished module. Treat 24.9% as the ceiling on what must be kept, not as the
keep-set.

## 4c. Use the PARSED-ID-RANGE trick — it removes a whole class of missed roots

A pure reachability walk has to rediscover every source-level root, and getting
that wrong is silent. But **parsed node ids are CONTIGUOUS per module**: `parse()`
mints them from `g_next_global_expr_id` (`expr.yo:316`) with no evaluation
interleaved, so each `parse(...)` call owns one `[lo, hi)` id range. Capture the
watermark around the three parse sites on the compile path (the demand loader, the
prelude load, the entry module), treat every parsed id as permanently kept, and
the only prune candidates left are ids minted DURING evaluation — clones,
synthesized `___dup`/`___drop` calls, and specialization bodies.

That reduces the mark to one question — "which evaluation-minted trees are still
live?" — whose roots are just the stored function values plus
`get_module_level_init_exprs()`. It also means a bug in the walk cannot silently
drop a source expression's info.

Sketch (full draft, including the worklist and the per-field lists, was written
during the round-16 session):

```rust
current_global_expr_id :: (fn() -> ExprId)(g_next_global_expr_id);   // expr.yo
(g_info_id_log : ArrayList(ExprId)) = ArrayList(ExprId).new();       // expr_info.yo
(g_parsed_id_ranges : ArrayList(usize)) = ArrayList(usize).new();    // flat lo,hi pairs
(g_released_env : Environment) = Environment.new(String.from(""));
// expr_info_table_set gains: g_info_id_log.push(id);
// prune(table, roots, from): mark roots -> for id in log[from..]:
//   if !_is_parsed_id(id) && !marked(id) -> info.env = g_released_env
```

Hook the prune in the demand loader right after `register_module(...)`
(`main.yo:~576`), guarded on `g_shared_expr_info_table` being `.Some` — on the
check/test path each context already drops its own table, so pruning there is pure
overhead. Use an EXPLICIT worklist, never recursion (see the `-O0` 1 GiB stack
ceiling note in `AGENTS.md`).

## 5. Validate the mark empirically BEFORE trusting it

`codegen/utils/index.yo:347` is a single choke point for 226 of the 236 reads.
Step 1 (recording the read set) is DONE — see §4b. The instrumentation that
produced it is preserved in the throwaway git worktree used for the measurement;
to reproduce, apply these three edits and rebuild:

1. `yo-self/expr_info.yo`: a `(g_codegen_read_ids : HashMap(ExprId, bool))`
   global plus `note_codegen_info_read(id)` / `codegen_read_id_count()` /
   `expr_info_table_len(table)`, all exported.
2. `yo-self/codegen/utils/index.yo:347`: `get_expr_info` calls
   `note_codegen_info_read(ast_expr_id(expr))` before delegating.
3. `yo-self/main.yo`: `eprintln` the two counts just before writing the `.c`
   (i.e. right after the `compile_module` call at `main.yo:1164`).

Step 2 is the one that still matters: **once the mark exists, assert
`mark ⊇ reads` on the same input.** A mark that misses even one read id is a bug
the corpus may not surface.

## 6. Gates (non-negotiable, same as every prior round)

`S1=<bin> P=<tag> bash scripts/bootstrap/gates_fast.sh` (battery, corpus
diff-test 155, `check ./std` 153) then `bash scripts/bootstrap/fixpoint_only.sh`
for the byte-identical stage-2 ≡ stage-3 check. The fixpoint is the gate that
catches "gates pass but output changed" — it is what caught the frame-index
regression in `issues/yo-self-frame-index-bound-breaks-fixpoint.md`.

## 7. Ruled out — do not re-derive these

- **Sharing one `snapshot_env` between expressions in the same scope
  (copy-on-write).** Audited 2026-08-04: **40+ sites use a recorded
  `ExprInfo.env` as a LIVE evaluation env** (e.g. `evaluator/utils.yo:725`
  `evaluate_expression_raw(dup_expr, ei.env, …)`, and the whole
  `evaluator/builtins/*` `cur_env := <info>.env` idiom), **4 sites
  `pop_env_frame` a recorded env in place** (`evaluator/exprs/match.yo:368,
659, 1592, 2222`), and **52 sites alias the frame LIST out of a recorded env
  into a live env** (`dst.frames = <info>.env.frames` —
  `evaluator/calls/closure_type.yo:262`, `calls/iso.yo:122,297`,
  `calls/array_type.yo:136`, `calls/type.yo:311`, …). Sharing would re-open
  `issues/fixed/yo-self-recorded-env-aliasing.md`. The 614 MB it would save is
  not worth it and the change is not safely possible.
- **Bounding `g_frame_indexes` wholesale.** Frees 1.8 GB, passes every gate,
  **breaks the fixpoint** — see
  `issues/yo-self-frame-index-bound-breaks-fixpoint.md`. Only the capture-frame
  half is safe (landed as r12).
