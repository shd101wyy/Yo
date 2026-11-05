# V5 part B — the per-declaration classification

**Status: ACTIVE** (2026-11-04). The table that drives V5 part B, the
`ref`-declaration migration (`plans/VALUES_BY_DEFAULT.md` V5, "Part B: the
three classes"; schedule §5f decision 30). Measured on develop `5aa0e1800`.
It is regenerated on the tip before each batch; the class column changes only
with a reason recorded here.

## Method

The classes and the procedure are Fable consultation #18 §C (confirming #13
Task 4): **R** never written after construction (a plain struct), **L**
written and threaded (an owned value lent as `&mut`), **S** semantically
shared (`Rc(RefCell(S))`, or `Rc(S)` with at most two `RefCell` fields).

1. **Written?** Two sources, both read-only on the tree:
   - the typed census `YO_AUDIT_RC_WRITE=1 yo compile src/main.yo
     --skip-c-compiler` (v0.2.74 seed, 30 min, 2,178 `src/` lines): every
     assignment, `&mut` argument and mutating receiver whose place crosses a
     `ref` handle, with the handle's type and root (`fresh`/`shell`: the
     function that allocated it; `param`, `rooted`, `capture`: anywhere else);
   - a syntactic scan for `x.f = …`, `&mut x.f` and mutating receivers
     (`x.f.push(…)`), counted only for a field name that one declaration
     owns. A name several types share (`ty` is declared by 37) counts only
     through the typed census.

   No write: **R**. The typed census covers what codegen emits from
   `src/main.yo`, so a type written only in dead code or in
   `tests/internal` shows up through the syntactic scan.
2. **Stored?** The type named in another declaration's field or enum payload,
   a module `::`/`=` binding's type, or a type alias, directly or under
   `Rc`/`Option`/`ArrayList`/`HashMap`. Not stored: **L**.
3. **Reachability, by hand** for the 39 written-and-stored declarations
   (the "Why" column). A value held by an L or R owner, or an element of a
   module `RefCell` registry written in place, is L; a record that two owners
   reach at once, or that outlives every caller holding it, is S.

## Numbers

| | R | L | S | total |
| --- | --- | --- | --- | --- |
| `src/` | 142 | 45 | 19 | 206 (203 `ref(struct)`, 3 `ref(enum)`) |
| `std/` | 13 | 22 | 1 | 36 |

- Fable's estimate (R ≈ 86, L ≈ 100, S ≈ 15–20) counted a type as written
  whenever one of its field names was assigned anywhere. The typed census
  moves 56 of those to R: the name belonged to another type (`ty`, `value`,
  `env`, `token`, …).
- The three `ref(enum)` trees (`AstExpr`, `EvalValue`, `VcSort`) are V4's
  shared trees: read-only `Rc`, R here.
- Order (VERDICTS-18 §C): R and L per file first, every L before any S; each
  S type on the evaluator's path is perf-gated (ABBA `check ./src`, ≤ 3 %
  wall and max RSS, plus the fixpoint). Part B lands after W6b, so the S
  types (all in `src/env.yo`, `src/expr_info.yo`, `src/codegen/`,
  `src/evaluator/builtins/build.yo` and the module walk) wait for it.

## Reclassifications during the migration

The tables below keep the census verdicts; these rows changed by hand while
migrating.

- `_State` (`src/resolver.yo`): **S**, not L. The `io.async` bodies that
  resolve packages capture it, so a stored handle outlives the caller's
  borrow. `_Package` moves with it.
- `DocState` (`src/lsp/server.yo`): stays `ref` for now. Its target is L, an
  owned map threaded `&mut`, not S; every `docs.get` copies it out today,
  so it moves with the LSP server's batch.
- `EffectCapturedVariable`: a recursive `Option(Self)` field, which a value
  struct cannot have. It stays `ref` and becomes a read-only `Rc`.
- `EffectAnalysisResult`: the `ExprInfo` accessor copies it out, and its
  readers are in W6b files. It waits for the `ExprInfo` (S) batch.
- The `EvalContext` / `FunctionGenerationContext` field types
  (`LoadModuleResult`, `FuncOrAsyncBlockCtx`, `LoopBodyCtx`,
  `CapturedVarInfo`, `SpecializingFunctionInfo`, `ImplConcreteTypeInfo`,
  `InAsyncStateMachine`, `InlineSuspension`) wait for their owner's batch,
  because the owners are copied today.
- `VerifyResult`, `VerifyFnReport` and `VerifyFnObligation`
  (`src/verifier/driver.yo`) stay `ref` until W6b merges: `src/main.yo`, a
  W6b file, reads them by element copy.
- Types that are a `HashMap` value stay `ref` until the HashMap
  plain-data-value fix lands. Today `insert` rejects a `V` that is
  neither Copy nor `ref`.
- `HttpServer` (`std/http/server.yo`): **S**, not L. A handler calls `stop()` while
  `serve` runs on the same server (VERDICTS-20 §4).
- `CodeGenContext`, `Emitter`, `ArrayStructInfo`: **L**, not S (step 3,
  coordinator-approved 2026-11-05). The S verdict assumed one
  `FunctionGenerationContext` per generated function. There is one per
  compile: its only construction is `FunctionGenerationContext.new` in
  `compile_module` (`src/codegen/codegen_c.yo:357`), threaded down through
  371 `&FunctionGenerationContext` parameters and stored nowhere.
  `CodeGenContext`'s only store is `FunctionGenerationContext.base`, and
  `Emitter`'s is `CodeGenContext.emitter`. The other four `Emitter.new()`
  are scratch emitters swapped into `context.base.emitter` and back
  (`drop_dup.yo`, three in `async.yo`), which become `replace(&mut …)`
  pairs. Every stored use therefore has the context on its path as a
  parameter. The 216 alias bindings (`em := context.base.emitter;`,
  `cg := context.base;`) are rewritten to the place. None of the three is
  on the evaluator's path. Their gate is the fixpoint, byte-identical C
  for `src/main.yo`, and the wall time and RSS of
  `yo compile src/main.yo --skip-c-compiler`.
- `InProcessCompileSlot`: **removed**, not S. `main.yo` sets the in-process
  compile callback once, before `run_build` builds the `ExecutionContext`,
  and nothing writes it afterwards. The slot is now a plain module global
  (`g_in_process_compile_fn`), and the execution context takes its value at
  construction. The slot only existed to keep a fn value out of an async
  state machine, which was fixed on 2026-09-29
  (`issues/fixed/async-sm-fn-typed-local-across-suspension.md`).
- `BuildRegistry`, `BuildArtifact`, `BuildStep`, `BuildModuleEntry`: **L**,
  not S. The builtins write the registry while a build file is evaluated,
  and the runner reads it afterwards. It becomes a value in a module cell
  (`g_build_registry : RefCell(BuildRegistry)`) that the builtins write in
  place through `with_mut`. The runner `seed`s, `swap`s, `restore`s and
  `take`s it, and from then on owns it. The future that merges dependency
  artifacts takes the registry by value and returns it. Whether a build
  file is being evaluated is now an explicit flag
  (`g_build_registry_live`); it used to be read off the `Option`. The
  element types are values written in place by index or name.
- `_State` (`src/resolver.yo`), as built: `Rc(_State)`. The inputs
  (`manifest`, `options`, `cache_root`, `old_lock`) are read-only, and the
  two parts written during the run are cells: `packages :
  RefCell(ArrayList(_Package))` and `remote : RefCell(_RemoteCache)`
  (shape 2). `_Package` is a value that the futures read by snapshot and
  write back by index.
- `PendingDef`, `ModuleWalk` (`src/evaluator/context.yo`), as built:
  shape 2. `PendingDef :: Rc(PendingDefData)`, with `name`, `index` and
  `is_impl` read-only and every field the walk writes in one
  `live : RefCell(PendingDefLive)` read and written through accessor
  methods. `ModuleWalk :: Rc(ModuleWalkData)`, with `begin_exprs` and `ctx`
  as its two cells; the frame, env and def lists are read-only after
  construction. `DeferredAsyncBlock` (`src/codegen/functions/context.yo`)
  is a read-only `Rc(DeferredAsyncBlockData)` (R), and `ClosureParamSlot`
  is a plain value.
- `Environment`, `Frame`, `FrameNameIndex`, `Variable`, `VariableRare`,
  `WhereClauseConstraints`, `ExprInfo`, `ExprInfoRare`: **stay `ref`,
  pending VERDICTS-22**. `RefCell` boxes its slot
  (`std/sync/refcell.yo`), so each cell costs one more allocation
  (+31 B per object for shape 2, +47 B for `Rc(RefCell(S))`, measured on
  4 M Variable-shaped objects under mimalloc). With about 8 M Variables
  and 3.2 M ExprInfos alive, that is about +15 % `check ./src` RSS, five
  times the 3 % gate. An inline borrow word costs nothing when the layout
  stays in its allocator bin. That needs `&T` parameters of cell-containing
  types to pass by address (decision 34's ABI, `fn_param_is_ptr_borrow`)
  before `RefCell` can drop the `Box`. The measurement and options are in
  the consult input for VERDICTS-22.
- `Md5`, `Sha1`, `Sha512`, `NfaCompiler`: **L**, not R. They are written
  through `self`, and the syntactic scan does not count receiver writes.

## `src/`

| Declaration | Site | Kind | Typed writes (audit roots) | Stored in | Class | Why |
| --- | --- | --- | --- | --- | --- | --- |
| `BuildOptions` | `src/build_runner.yo:75` | struct | param 1 | – | **L** | written, never stored |
| `DAGNode` | `src/build_runner.yo:112` | struct | – | – | **R** | never written |
| `StepResult` | `src/build_runner.yo:120` | struct | capture 1 | – | **L** | written, never stored |
| `InProcessCompileSlot` | `src/build_runner.yo:143` | struct | rooted 1 | ExecutionContext field in_process_compile_slot; g_in_process_compile_slot module binding | **S** | a module-level slot (`g_in_process_compile_slot.f`) set once and read by every in-process compile: a module `RefCell` |
| `ExecutionContext` | `src/build_runner.yo:155` | struct | – | – | **R** | never written |
| `CrossBoundaryResult` | `src/codegen/async/state_machine.yo:43` | struct | rooted 4 | – | **L** | written, never stored |
| `_LiveVar` | `src/codegen/async/state_machine.yo:61` | struct | param 6 | _LiveWalk field vars | **L** | element of `_LiveWalk.vars` (L); written through the walk |
| `_LiveWalk` | `src/codegen/async/state_machine.yo:70` | struct | param 12, rooted 1 | – | **L** | written, never stored |
| `_SlotRange` | `src/codegen/async/state_machine.yo:707` | struct | – | – | **R** | never written |
| `OverlappingSlot` | `src/codegen/async/state_machine.yo:710` | struct | – | AsyncBlockStructInfo field overlapping_slots; OverlappingStorageResult field slots | **R** | never written |
| `OverlappingStorageResult` | `src/codegen/async/state_machine.yo:724` | struct | rooted 2 | – | **L** | written, never stored |
| `ChunkAssembly` | `src/codegen/chunk_assembly.yo:41` | struct | – | – | **R** | never written |
| `DeclSplit` | `src/codegen/chunk_assembly.yo:262` | struct | – | – | **R** | never written |
| `ParsedOperand` | `src/codegen/exprs/asm.yo:197` | struct | – | – | **R** | never written |
| `EffectFieldMapping` | `src/codegen/exprs/async.yo:107` | struct | – | – | **R** | never written |
| `SyncParamSlot` | `src/codegen/exprs/async.yo:361` | struct | – | – | **R** | never written |
| `AsyncBlockStructInfo` | `src/codegen/exprs/async.yo:477` | struct | – | – | **R** | never written |
| `_FutureEffect` | `src/codegen/exprs/await.yo:64` | struct | – | – | **R** | never written |
| `_MatchLabels` | `src/codegen/exprs/match.yo:1768` | struct | param 1 | – | **L** | written, never stored |
| `ClosureParamSlot` | `src/codegen/functions/context.yo:20` | struct | – | AsyncBlockStructInfo field closure_param_slots; DeferredAsyncBlock field closure_param_slots | **R** | never written |
| `DeferredAsyncBlock` | `src/codegen/functions/context.yo:38` | struct | – | FusedAwaitSite field block; FunctionGenerationContext field deferred_async_blocks | **R** | never written |
| `InAsyncStateMachine` | `src/codegen/functions/context.yo:67` | struct | – | FunctionGenerationContext field in_async_state_machine | **R** | never written |
| `InlineSuspension` | `src/codegen/functions/context.yo:74` | struct | – | g_inline_suspensions module binding; InlineSmLowering field suspensions | **R** | never written |
| `InlineSmLowering` | `src/codegen/functions/context.yo:88` | struct | param 8, rooted 8 | FunctionGenerationContext field sm_inline_lowering | **L** | held by `FunctionGenerationContext.sm_inline_lowering` (L) |
| `EvidenceParameter` | `src/codegen/functions/context.yo:126` | struct | – | FunctionGenerationContext field current_evidence_params | **R** | never written |
| `FunctionGenerationContext` | `src/codegen/functions/context.yo:135` | struct | param 212 | – | **L** | written, never stored |
| `EvidenceParameter` | `src/codegen/functions/declarations.yo:21` | struct | – | FunctionGenerationContext field current_evidence_params | **R** | never written |
| `_TypeWalkEntry` | `src/codegen/types/generation.yo:1547` | struct | – | – | **L** | written, never stored |
| `CodegenTypeEntry` | `src/codegen/utils/index.yo:115` | struct | – | CodeGenContext field types | **R** | never written |
| `CodegenExternFnEntry` | `src/codegen/utils/index.yo:116` | struct | – | CodeGenContext field extern_functions | **R** | never written |
| `CodegenFunctionEntry` | `src/codegen/utils/index.yo:121` | struct | – | CodeGenContext field functions | **R** | never written |
| `ImplClosureCallInfo` | `src/codegen/utils/index.yo:124` | struct | – | CodeGenContext field impl_closure_call_map | **R** | never written |
| `ArrayStructInfo` | `src/codegen/utils/index.yo:135` | struct | – | CodeGenContext field array_struct_types | **S** | element of `CodeGenContext.array_struct_types`: a value inside its S owner |
| `DynImplEntry` | `src/codegen/utils/index.yo:140` | struct | – | CodeGenContext field dyn_impls | **R** | never written |
| `ChunkRange` | `src/codegen/utils/index.yo:157` | struct | – | CodeGenContext field chunk_fn_ranges; CodeGenContext field chunk_header_ranges | **R** | never written |
| `CodeGenContext` | `src/codegen/utils/index.yo:159` | struct | param 207, rooted 15 | FunctionGenerationContext field base | **S** | held by every `FunctionGenerationContext.base` and written through it (VERDICTS-13) |
| `RuntimeStructField` | `src/codegen/utils/index.yo:823` | struct | – | – | **R** | never written |
| `Emitter` | `src/emitter.yo:288` | struct | param 54, rooted 2 | CodeGenContext field emitter | **S** | held by `CodeGenContext.emitter` (follows its owner, VERDICTS-13) |
| `VariableRare` | `src/env.yo:104` | struct | param 8 | Variable field rare | **S** | held by `Variable.rare`: a value inside its S owner |
| `Variable` | `src/env.yo:201` | struct | param 26, rooted 97 | Frame field variables; CaptureSlice field vars; ExprInfo field source_variable (+11) | **S** | held by frames, capture slices, `ExprInfo.source_variable` and the scope logs at once (V4 PR 1 `ValueCell` shape) |
| `WhereClauseConstraints` | `src/env.yo:608` | struct | rooted 2 | Frame field where_clause_constraints | **S** | held by `Frame.where_clause_constraints`: a value inside its S owner |
| `Frame` | `src/env.yo:625` | struct | param 8 | g_func_parameters_frame module binding; Environment field frames; ModuleWalk field module_frame | **S** | held by `Environment.frames`, `ModuleWalk.module_frame` and `g_func_parameters_frame`; closures keep their defining frames |
| `FrameNameIndex` | `src/env.yo:860` | struct | param 9 | g_frame_indexes module binding | **S** | the `g_frame_indexes` registry, keyed by frame |
| `Environment` | `src/env.yo:1082` | struct | param 13, rooted 1, shell 1 | ModuleLoadOutcome field env; CaptureEnvEntry field env; SharedCaptureEnvEntry field env (+47) | **S** | held by closure values, `ExprInfo.env`, the scope husks and the snapshot ring past the creating call |
| `CaptureEnvEntry` | `src/env.yo:2672` | struct | – | g_capture_envs module binding | **R** | never written |
| `SharedCaptureEnvEntry` | `src/env.yo:3082` | struct | – | g_shared_capture_envs module binding | **R** | never written |
| `YoError` | `src/error.yo:288` | struct | rooted 2, shell 1 | g_mat_default_err module binding; g_reeval_closure_err module binding; _DeferredSiblingRule field err (+1) | **L** | written only while a fresh error is assembled (`diagnostics`), then thrown or stored once |
| `ExitWith` | `src/error.yo:324` | struct | – | – | **R** | never written |
| `AwaitPointExtra` | `src/evaluator/async/await_analysis.yo:67` | struct | – | – | **R** | never written |
| `AwaitPoint` | `src/evaluator/async/await_analysis_types.yo:38` | struct | – | AwaitAnalysisResult field await_points | **R** | never written |
| `CapturedVariable` | `src/evaluator/async/await_analysis_types.yo:65` | struct | – | AwaitAnalysisResult field captured_variables; FunctionGenerationContext field state_machine_variables | **R** | never written |
| `AwaitAnalysisResult` | `src/evaluator/async/await_analysis_types.yo:80` | struct | – | ExprInfoRare field await_analysis; g_closure_await_analysis module binding; AsyncBlockStructInfo field analysis (+2) | **R** | never written |
| `AsmOperand` | `src/evaluator/builtins/asm.yo:75` | struct | – | – | **R** | never written |
| `BuildArtifact` | `src/evaluator/builtins/build.yo:68` | struct | capture 6, param 2, rooted 1 | ResolvedDep field Artifact.value; BuildRegistry field artifacts | **S** | element of `BuildRegistry.artifacts` and `ResolvedDep.Artifact`, written by build closures |
| `BuildTestSuite` | `src/evaluator/builtins/build.yo:113` | struct | – | ResolvedDep field Test.value; BuildRegistry field test_suites | **R** | never written |
| `BuildRunStep` | `src/evaluator/builtins/build.yo:125` | struct | – | ResolvedDep field Run.value; BuildRegistry field run_steps | **R** | never written |
| `BuildStep` | `src/evaluator/builtins/build.yo:132` | struct | param 1 | ResolvedDep field Step.value; BuildRegistry field steps | **S** | element of `BuildRegistry.steps` and `ResolvedDep.Step` |
| `BuildSystemLibrary` | `src/evaluator/builtins/build.yo:139` | struct | – | BuildRegistry field system_libraries | **R** | never written |
| `DependencyArtifactRef` | `src/evaluator/builtins/build.yo:148` | struct | – | BuildRegistry field dependency_artifacts | **R** | never written |
| `BuildModuleEntry` | `src/evaluator/builtins/build.yo:157` | struct | param 1 | BuildRegistry field modules | **S** | element of `BuildRegistry.modules` |
| `BuildDocConfig` | `src/evaluator/builtins/build.yo:163` | struct | – | ResolvedDep field Doc.value; BuildRegistry field doc_configs | **R** | never written |
| `BuildVerifyConfig` | `src/evaluator/builtins/build.yo:178` | struct | – | ResolvedDep field Verify.value; BuildRegistry field verify_configs | **R** | never written |
| `BuildDeclaredOption` | `src/evaluator/builtins/build.yo:187` | struct | – | BuildRegistry field declared_options | **R** | never written |
| `BuildRegistry` | `src/evaluator/builtins/build.yo:206` | struct | capture 5, param 27, rooted 1 | ExecutionContext field registry | **S** | the build registry (VERDICTS-13), held by `ExecutionContext.registry` and written by build closures |
| `GhostFnDef` | `src/evaluator/builtins/contracts.yo:414` | struct | – | g_ghost_fn_defs module binding | **R** | never written |
| `VerifyTask` | `src/evaluator/builtins/contracts.yo:1381` | struct | – | g_frame_tasks module binding; g_verify_tasks module binding | **R** | never written |
| `RecursiveTypeRef` | `src/evaluator/calls/comptime_fn.yo:351` | struct | – | g_recursive_type_refs module binding | **R** | never written |
| `PendingDefEval` | `src/evaluator/calls/function_type.yo:202` | struct | rooted 1 | g_pending_def_evals module binding | **L** | element of the `g_pending_def_evals` registry; the one write is on an entry taken out and re-pushed |
| `CheckParamResult` | `src/evaluator/calls/helper.yo:529` | struct | – | – | **R** | never written |
| `LoadModuleResult` | `src/evaluator/context.yo:78` | struct | – | EvalContext field load_module | **R** | never written |
| `FuncOrAsyncBlockCtx` | `src/evaluator/context.yo:103` | struct | – | EvalContext field is_evaluating_function_body_or_async_block | **R** | never written |
| `LoopBodyCtx` | `src/evaluator/context.yo:140` | struct | param 2 | EvalContext field is_evaluating_loop_body | **L** | held by `EvalContext.is_evaluating_loop_body` (L) |
| `ExpectedTypeCtx` | `src/evaluator/context.yo:161` | struct | – | EvalContext field expected_type | **R** | never written |
| `CapturedVarInfo` | `src/evaluator/context.yo:175` | struct | – | EvalContext field captured_variables | **R** | never written |
| `SpecializingFunctionInfo` | `src/evaluator/context.yo:186` | struct | – | EvalContext field currently_specializing_function; EvalContext field currently_specializing_function_stack | **R** | never written |
| `ImplConcreteTypeInfo` | `src/evaluator/context.yo:229` | struct | – | EvalContext field function_return_impl_concrete_type | **R** | never written |
| `CalledComptimeFnCache` | `src/evaluator/context.yo:244` | struct | – | ComptimeFnCacheEntry field caches | **R** | never written |
| `ComptimeFnCacheEntry` | `src/evaluator/context.yo:256` | struct | rooted 6 | EvalContext field comptime_fn_caches; g_comptime_fn_caches module binding | **L** | element of the `g_comptime_fn_caches` registry and `EvalContext.comptime_fn_caches`; `entry.caches.push` on a looked-up entry: write in place through the owner |
| `SpecializedFunctionCache` | `src/evaluator/context.yo:271` | struct | – | SpecializedFunctionCacheEntry field caches | **R** | never written |
| `SpecializedFunctionCacheEntry` | `src/evaluator/context.yo:292` | struct | rooted 2 | g_specialized_fn_caches module binding | **L** | element of the `g_specialized_fn_caches` registry; `entry.caches.push` on a looked-up entry: write in place through `with_mut` |
| `EvalContext` | `src/evaluator/context.yo:302` | struct | param 487, rooted 18 | ModuleLoadOutcome field ctx; ModuleWalk field ctx; ImplInFlight field ctx | **L** | L with restructuring (VERDICTS-13): `ImplInFlight.ctx`, `ModuleWalk.ctx` and `ModuleLoadOutcome.ctx` stop storing the handle (pass the context at use time; return the value) |
| `ArgEntry` | `src/evaluator/context.yo:526` | struct | rooted 1 | ArgValues field forall_args; ArgValues field args; ArgValues field implicit_args | **L** | element of `ArgValues`; the one write (`self_ae.value`) goes through an element copy: write in place |
| `VarArgEntry` | `src/evaluator/context.yo:534` | struct | – | ArgValues field variadic_args | **R** | never written |
| `ArgValues` | `src/evaluator/context.yo:540` | struct | – | FuncCallResult field arg_values | **R** | never written |
| `FuncCallResult` | `src/evaluator/context.yo:551` | struct | – | CallResultKind field FunctionResult.result | **R** | never written |
| `ComptimeFnCallResult` | `src/evaluator/context.yo:570` | struct | – | – | **R** | never written |
| `TypeCallResult` | `src/evaluator/context.yo:583` | struct | – | CallResultKind field TypeResult.result | **R** | never written |
| `ModuleTypeCallResult` | `src/evaluator/context.yo:598` | struct | – | CallResultKind field ModuleTypeResult.result | **R** | never written |
| `TraitTypeCallResult` | `src/evaluator/context.yo:604` | struct | – | CallResultKind field TraitTypeResult.result | **R** | never written |
| `TraitSpecializationResult` | `src/evaluator/context.yo:610` | struct | – | CallResultKind field TraitSpecializationResult.result | **R** | never written |
| `MacroFuncCallResult` | `src/evaluator/context.yo:616` | struct | – | – | **R** | never written |
| `NumericTypeCallResult` | `src/evaluator/context.yo:623` | struct | – | CallResultKind field NumericTypeResult.result | **R** | never written |
| `PointerTypeCallResult` | `src/evaluator/context.yo:629` | struct | – | CallResultKind field PointerTypeResult.result | **R** | never written |
| `IndexCallResult` | `src/evaluator/context.yo:635` | struct | – | CallResultKind field IndexResult.result | **R** | never written |
| `FunctionToCall` | `src/evaluator/context.yo:685` | struct | – | – | **R** | never written |
| `PendingDef` | `src/evaluator/context.yo:1236` | struct | param 9, rooted 15 | DefDiff field changed; RevalPlan field changed; ModuleWalk field defs (+3) | **S** | one definition is reachable from `ModuleWalk.defs`, `ModuleWalk.by_index`, `ImplPendingField.def` and `g_forcing_stack` at once, and its state is written through each |
| `ModuleWalk` | `src/evaluator/context.yo:1284` | struct | rooted 4 | g_module_walks module binding; g_finished_walks module binding | **S** | in `g_module_walks` and `g_finished_walks`, read by the demand loader while no caller holds it; `walk.ctx` is rewritten (provisional: L if the finished map only moves walks) |
| `ImplPendingField` | `src/evaluator/context.yo:3337` | struct | param 6, rooted 3 | ImplInFlight field fields | **L** | element of `ImplInFlight.fields`; written through the impl loop that owns it |
| `ImplInFlight` | `src/evaluator/context.yo:3359` | struct | param 3, rooted 8 | g_impls_in_flight module binding | **L** | L with restructuring (VERDICTS-13): the `g_impls_in_flight` entry is synced around each field; write it in place, and pass `ctx` at use time instead of storing it |
| `EffectCallPointExtra_` | `src/evaluator/effects/effect_analysis.yo:71` | struct | – | – | **R** | never written |
| `EffectCallPoint` | `src/evaluator/effects/effect_analysis_types.yo:31` | struct | – | EffectAnalysisResult field effect_call_points | **R** | never written |
| `EffectCapturedVariable` | `src/evaluator/effects/effect_analysis_types.yo:57` | struct | – | EffectAnalysisResult field captured_variables | **R** | never written |
| `EffectHandlerInfo` | `src/evaluator/effects/effect_analysis_types.yo:72` | struct | – | EffectAnalysisResult field effect_handler_infos | **R** | never written |
| `EffectAnalysisResult` | `src/evaluator/effects/effect_analysis_types.yo:89` | struct | – | ExprInfoRare field effect_analysis | **R** | never written |
| `ParamMutationMask` | `src/evaluator/effects/mutation_summary.yo:765` | struct | fresh 1, param 6, rooted 23 | _MspAnalysis field mask | **L** | held by `_MspAnalysis.mask`; written by the analysis that owns it |
| `_MspCtx` | `src/evaluator/effects/mutation_summary.yo:1076` | struct | param 10, rooted 2 | – | **L** | written, never stored |
| `_GrCtx` | `src/evaluator/effects/mutation_summary.yo:4103` | struct | – | – | **R** | never written |
| `DupCallsResult` | `src/evaluator/exprs/begin.yo:144` | struct | param 5, rooted 2 | – | **L** | written, never stored |
| `_ICScan` | `src/evaluator/exprs/begin.yo:1825` | struct | param 20, rooted 4 | – | **L** | written, never stored |
| `BindingResult` | `src/evaluator/exprs/binding.yo:65` | struct | – | – | **R** | never written |
| `DestructuringResult` | `src/evaluator/exprs/destructuring_assignment.yo:56` | struct | – | – | **R** | never written |
| `_ArmOwnership` | `src/evaluator/exprs/match.yo:877` | struct | param 8 | – | **L** | written, never stored |
| `BindInfo` | `src/evaluator/exprs/pattern_compile.yo:79` | struct | – | PatternCtx field binds; _ArmOwnership field unbound; _ArmOwnership field keeps (+1) | **R** | never written |
| `PatternCtx` | `src/evaluator/exprs/pattern_compile.yo:89` | struct | param 10 | – | **L** | written, never stored |
| `Evaluator` | `src/evaluator/index.yo:133` | struct | – | – | **R** | never written |
| `SuspensionPointDetector` | `src/evaluator/shared/suspension_analysis.yo:59` | struct | – | – | **R** | never written |
| `SuspensionPoint` | `src/evaluator/shared/suspension_analysis_types.yo:24` | struct | rooted 10 | AwaitPoint field base; EffectCallPoint field base; SuspensionPointDetector field detect (+1) | **L** | the `base` value of `AwaitPoint`/`EffectCallPoint` and an element of the analysis results; written while the analysis holds it |
| `SuspensionCapturedVariable` | `src/evaluator/shared/suspension_analysis_types.yo:79` | struct | – | CapturedVariable field base; EffectCapturedVariable field base; SuspensionAnalysisResult field captured_variables | **R** | never written |
| `SuspensionAnalysisResult` | `src/evaluator/shared/suspension_analysis_types.yo:104` | struct | – | – | **R** | never written |
| `SynthesizeResult` | `src/evaluator/types/expr_synthesizer.yo:19` | struct | – | – | **R** | never written |
| `GadtEntry` | `src/evaluator/types/gadt_registry.yo:26` | struct | – | g_gadt_entries module binding | **R** | never written |
| `GadtTcaEntry` | `src/evaluator/types/gadt_registry.yo:71` | struct | – | g_gadt_tca_entries module binding | **R** | never written |
| `SynthesizeOptions` | `src/evaluator/types/synthesizer.yo:83` | struct | – | – | **R** | never written |
| `SynthesizeResult` | `src/evaluator/types/synthesizer.yo:95` | struct | – | – | **R** | never written |
| `TypePair` | `src/evaluator/types/synthesizer.yo:105` | struct | – | – | **R** | never written |
| `LocalBorrowInfo` | `src/evaluator/utils.yo:5979` | struct | rooted 6 | LocalBorrowPatternBinding field borrow; LocalBorrowMatchPlace field borrow; g_local_borrows module binding | **L** | element of the `g_local_borrows` stack; lookups copy the handle and write it (`p.end`, `info.places`): write in place through `with_mut` |
| `AnonModuleResult` | `src/evaluator/values/anonymous_module.yo:92` | struct | – | – | **R** | never written |
| `MethodEntry` | `src/evaluator/values/type_trait_methods.yo:175` | struct | param 1, rooted 5 | _type_trait_methods module binding; _provisional_trait_methods module binding; ReceiverMethodResult field all_hits | **L** | element of the method registries; the writes go through looked-up entries: write in place through `with_mut` |
| `AstExpr` | `src/expr.yo:465` | enum | – | FuncValData field body; EvalValue field ExprVal.expr; DefDiff field fresh_exprs (+135) | **R** | V4's shared tree: read-only `Rc` (VERDICTS-18 §C) |
| `ExprInfoRare` | `src/expr_info.yo:358` | struct | param 24 | ExprInfo field rare | **S** | held by `ExprInfo.rare`: a value inside its S owner |
| `ExprInfo` | `src/expr_info.yo:404` | struct | param 3, rooted 483, shell 1 | ExprInfoTable field data; g_scope_log_infos module binding; g_scope_shadow_objs module binding | **S** | held by `ExprInfoTable.data` and the scope logs; read and written by codegen after evaluation |
| `BranchInitRecord` | `src/expr_info.yo:2108` | struct | – | g_branch_init_log module binding | **R** | never written |
| `FetchedPackage` | `src/fetch.yo:47` | struct | – | – | **R** | never written |
| `_HashWorkItem` | `src/fetch.yo:181` | struct | – | – | **R** | never written |
| `GcReport` | `src/fetch.yo:975` | struct | – | – | **R** | never written |
| `ClosureCaptureInfo` | `src/function_value.yo:109` | struct | – | g_closure_capture_info module binding; g_closure_capture_by_source module binding | **R** | never written |
| `InitOptions` | `src/init.yo:28` | struct | – | – | **R** | never written |
| `AddOptions` | `src/install_command.yo:256` | struct | – | – | **R** | never written |
| `InstallOptions` | `src/install_command.yo:516` | struct | – | – | **R** | never written |
| `LockEntry` | `src/lock_file.yo:44` | struct | – | LockFile field packages | **R** | never written |
| `LockFile` | `src/lock_file.yo:100` | struct | – | LockRead field lock; _State field old_lock | **R** | never written |
| `LockRead` | `src/lock_file.yo:266` | struct | – | – | **R** | never written |
| `AnalyzeOutcome` | `src/lsp/diagnostics.yo:470` | struct | – | DocState field outcome | **R** | never written |
| `AtomRoles` | `src/lsp/hover.yo:275` | struct | param 3 | – | **L** | written, never stored |
| `JsonObjBuilder` | `src/lsp/protocol.yo:26` | struct | param 2 | – | **L** | written, never stored |
| `DocState` | `src/lsp/server.yo:72` | struct | param 2 | – | **L** | written, never stored |
| `PendingAnalysis` | `src/lsp/server.yo:267` | struct | param 3 | – | **L** | written, never stored |
| `CcArgv` | `src/main.yo:6606` | struct | param 1 | – | **L** | written, never stored |
| `ManifestModule` | `src/manifest.yo:123` | struct | – | Manifest field modules | **R** | never written |
| `ManifestDependency` | `src/manifest.yo:155` | struct | – | Manifest field dependencies | **R** | never written |
| `Manifest` | `src/manifest.yo:165` | struct | – | _State field manifest; _ClosureEntry field manifest | **R** | never written |
| `ImportRoot` | `src/manifest.yo:644` | struct | – | ImportRoots field roots | **R** | never written |
| `UnavailableImport` | `src/manifest.yo:654` | struct | – | ImportRoots field unavailable | **R** | never written |
| `ImportRoots` | `src/manifest.yo:665` | struct | param 3, rooted 1 | – | **L** | written, never stored |
| `_ClosureEntry` | `src/manifest.yo:736` | struct | – | – | **R** | never written |
| `DefDiff` | `src/module_manager.yo:582` | struct | – | – | **R** | never written |
| `RebindEntry` | `src/module_manager.yo:1026` | struct | – | RevalPlan field rebinds | **R** | never written |
| `RevalPlan` | `src/module_manager.yo:1036` | struct | – | – | **R** | never written |
| `RevalOutcome` | `src/module_manager.yo:1615` | struct | – | – | **R** | never written |
| `Arm` | `src/pattern.yo:131` | struct | rooted 1 | g_match_arms module binding | **L** | element of the `g_match_arms` registry; the one write (`fa.classic`) goes through an element copy: write in place by index |
| `PkgConfigResult` | `src/pkg_config.yo:12` | struct | param 10, rooted 6 | – | **L** | written, never stored |
| `PublicSafeFinding` | `src/public_safe_report.yo:28` | struct | – | PublicSafeReport field findings | **R** | never written |
| `Class1Extraction` | `src/public_safe_report.yo:46` | struct | – | PublicSafeReport field class1 | **R** | never written |
| `PublicSafeTotals` | `src/public_safe_report.yo:60` | struct | – | PublicSafeReport field totals | **R** | never written |
| `PublicSafeReport` | `src/public_safe_report.yo:68` | struct | – | – | **R** | never written |
| `_FnDecl` | `src/public_safe_report.yo:94` | struct | – | – | **R** | never written |
| `SemVer` | `src/resolver.yo:55` | struct | – | ChosenRef field Tag.sv | **R** | never written |
| `_Comparator` | `src/resolver.yo:266` | struct | – | VersionReq field comparators | **R** | never written |
| `VersionReq` | `src/resolver.yo:277` | struct | – | – | **R** | never written |
| `Requirement` | `src/resolver.yo:695` | struct | – | _Package field requirements | **R** | never written |
| `ResolveOptions` | `src/resolver.yo:910` | struct | – | _State field options | **R** | never written |
| `_Package` | `src/resolver.yo:921` | struct | capture 5, param 5 | _State field packages | **L** | element of `_State.packages`; moves with `_State` (S) |
| `_State` | `src/resolver.yo:950` | struct | capture 6, param 1 | – | **S** | captured by the `io.async` bodies that resolve packages, which outlive the caller's borrow (hand verdict, overrides step 2) |
| `SkillEntry` | `src/skills_command.yo:21` | struct | – | SkillsInstallResult field skills | **R** | never written |
| `SkillsInstallResult` | `src/skills_command.yo:30` | struct | – | – | **R** | never written |
| `SkillCopyCounters` | `src/skills_command.yo:41` | struct | param 2 | – | **L** | written, never stored |
| `TargetInfo` | `src/target.yo:51` | struct | – | CodeGenContext field target_info | **R** | never written |
| `HostInfo` | `src/target.yo:63` | struct | – | – | **R** | never written |
| `Token` | `src/token.yo:34` | struct | rooted 1 | Parser field tokens; TokenAndError field token; TokenAndWarning field token (+53) | **R** | the one write (`mark.module_path` in `_projection_tail`) is on a freshly synthesized token: fold it into the construction. 939 references: `Rc(S)` candidate if the copies cost |
| `_Scan` | `src/toml_edit.yo:93` | struct | param 4 | – | **L** | written, never stored |
| `_KeyPath` | `src/toml_edit.yo:188` | struct | – | – | **R** | never written |
| `_Line` | `src/toml_edit.yo:292` | struct | – | – | **R** | never written |
| `_Range` | `src/toml_edit.yo:405` | struct | – | – | **R** | never written |
| `FlowOptions` | `src/types/flowability.yo:171` | struct | – | – | **R** | never written |
| `AdoptedExternCType` | `src/types/guards.yo:142` | struct | – | g_adopted_extern_c_types module binding | **R** | never written |
| `Substitution` | `src/types/substitution.yo:22` | struct | param 13, rooted 5 | – | **L** | written, never stored |
| `IntRange` | `src/types/utils.yo:104` | struct | – | – | **R** | never written |
| `UnsafeFinding` | `src/unsafe_report.yo:27` | struct | – | UnsafeReport field findings | **R** | never written |
| `UnsafeTotals` | `src/unsafe_report.yo:46` | struct | – | UnsafeReport field totals | **R** | never written |
| `ExternCallee` | `src/unsafe_report.yo:60` | struct | – | UnsafeReport field top_extern_callees | **L** | element of `UnsafeReport.top_extern_callees`; the count is written while the report is built |
| `UnsafeReport` | `src/unsafe_report.yo:66` | struct | – | – | **R** | never written |
| `OwnedKeys` | `src/utils.yo:1077` | struct | param 3 | _inherent_method_site_owned module binding; _trait_default_owned module binding; g_ifc_memo_owned module binding (+1) | **L** | value of four module `RefCell` bindings; written only inside `with_mut` |
| `EvalValue` | `src/value.yo:46` | enum | – | ValueCell alias; EvalResult field value; g_no_values module binding (+70) | **R** | V4's shared tree: read-only `Rc` (VERDICTS-18 §C) |
| `EvalResult` | `src/value.yo:1038` | struct | – | – | **R** | never written |
| `VerifyResult` | `src/verifier/driver.yo:97` | struct | – | – | **R** | never written |
| `VerifyFnObligation` | `src/verifier/driver.yo:477` | struct | – | VerifyFnReport field obligations | **R** | never written |
| `VerifyFnReport` | `src/verifier/driver.yo:501` | struct | – | – | **R** | never written |
| `VerifySummary` | `src/verifier/driver.yo:605` | struct | – | – | **R** | never written |
| `VcSort` | `src/verifier/terms.yo:24` | enum | – | VcTermNode field Var.sort; VcTermNode field Quant.sorts; VcTermNode field ArrConst.sort (+11) | **R** | V4's shared tree: read-only `Rc` (VERDICTS-18 §C) |
| `VcQuery` | `src/verifier/terms.yo:237` | struct | param 2, rooted 7, shell 1 | VcObligation field query | **L** | held by `VcObligation.query`; written while the obligation is built |
| `VcObligation` | `src/verifier/vc.yo:694` | struct | – | VcBodyResult field obligations; VcCtx field obligations | **R** | never written |
| `VcSubsetError` | `src/verifier/vc.yo:718` | struct | – | VcBodyResult field error; VcCtx field subset_error | **R** | never written |
| `VcBodyResult` | `src/verifier/vc.yo:725` | struct | – | – | **R** | never written |
| `VcCtx` | `src/verifier/vc.yo:742` | struct | param 138, rooted 14 | – | **L** | written, never stored |
| `_MatchPhi` | `src/verifier/vc.yo:2627` | struct | param 3 | – | **L** | written, never stored |
| `VerifyFnInput` | `src/verifier/vc.yo:7407` | struct | – | – | **R** | never written |

## `std/`

The std types are public API: each one's documentation changes with it, and
the README projects that use them (`Path`, `Url`, `HttpRequest`,
`HttpResponse`, `Regex`, `Command`) migrate by hand against the same two
questions. The typed census covers only what the compiler itself uses
(`Command`, the TOML and JSON parsers, `Sha256`, `RegexParser`, `NfaVm`);
the rest rests on the syntactic scan.

| Declaration | Site | Typed writes | Class | Why |
| --- | --- | --- | --- | --- |
| `ArgDef` | `std/cli/arg_parser.yo:50` | – | **R** | never written |
| `ParsedArgs` | `std/cli/arg_parser.yo:77` | – | **L** | written, never stored |
| `ArgParser` | `std/cli/arg_parser.yo:91` | – | **L** | written, never stored |
| `Md5` | `std/crypto/md5.yo:213` | self | **L** | written through `self` (the census misses receiver writes), never stored |
| `Sha1` | `std/crypto/sha1.yo:90` | self | **L** | written through `self` (the census misses receiver writes), never stored |
| `Sha256` | `std/crypto/sha256.yo:175` | param 19 | **L** | written, never stored |
| `Sha512` | `std/crypto/sha512.yo:170` | self | **L** | written through `self` (the census misses receiver writes), never stored |
| `_Parser` | `std/encoding/json.yo:561` | fresh 2, param 13 | **L** | written, never stored |
| `_Parser` | `std/encoding/toml.yo:445` | fresh 2, param 13 | **L** | written, never stored |
| `ErrorChain` | `std/error.yo:350` | – | **L** | written, never stored |
| `Metadata` | `std/fs/metadata.yo:53` | – | **R** | never written |
| `GlobPattern` | `std/glob.yo:224` | – | **R** | never written |
| `FetchOptions` | `std/http/client.yo:69` | param 3 | **L** | written, never stored |
| `HttpRequest` | `std/http/http.yo:213` | param 3, rooted 1 | **L** | written, never stored |
| `HttpResponse` | `std/http/http.yo:440` | rooted 3 | **L** | held by `_DeadlineOutcome.Done` while the client builds it |
| `HttpServer` | `std/http/server.yo:59` | – | **S** | `stop()` runs inside a handler while `serve` runs on the same server (two owners that outlive each other's calls): `Rc(TcpListener)` plus `Rc(RefCell(bool))` `stopped`, `derive(Clone)`, `serve(self : Self)` (VERDICTS-20 §4) |
| `Path` | `std/path.yo:51` | – | **R** | the census's "written" hits are other types' `.path`/`.parent` fields; no typed write: a plain value (provisional) |
| `__BorrowGuard` | `std/prelude.yo:11069` | – | **R** | never written |
| `Output` | `std/process/command.yo:143` | – | **R** | never written |
| `Command` | `std/process/command.yo:172` | param 2 | **L** | written, never stored |
| `Rng` | `std/rand.yo:85` | fresh 1, param 2 | **L** | written, never stored |
| `NfaProgram` | `std/regex/compiler.yo:330` | param 5, rooted 1 | **L** | held by the compiler, then by `NfaVm`/`Regex` read-only after compilation |
| `NfaCompiler` | `std/regex/compiler.yo:357` | self | **L** | written through `self` (the census misses receiver writes), never stored |
| `Regex` | `std/regex/index.yo:56` | – | **R** | never written |
| `RegexMatchIter` | `std/regex/index.yo:450` | – | **L** | written, never stored |
| `RegexMatch` | `std/regex/match.yo:35` | – | **R** | never written |
| `RegexNode` | `std/regex/node.yo:113` | – | **R** | never written |
| `RegexParser` | `std/regex/parser.yo:80` | param 41 | **L** | written, never stored |
| `NfaThread` | `std/regex/vm.yo:62` | param 1 | **L** | element of the VM's thread lists |
| `NfaVm` | `std/regex/vm.yo:147` | param 4 | **L** | held by `RegexMatchIter._vm`, written by the iterator that owns it |
| `__MutexUnlocker` | `std/sync/mutex.yo:191` | – | **R** | never written |
| `__RwLockReadUnlocker` | `std/sync/rwlock.yo:92` | – | **R** | never written |
| `__RwLockWriteUnlocker` | `std/sync/rwlock.yo:110` | – | **R** | never written |
| `__SemaphoreReleaser` | `std/sync/semaphore.yo:62` | – | **R** | never written |
| `Interval` | `std/time/sleep.yo:87` | – | **L** | written, never stored |
| `Url` | `std/url/index.yo:196` | – | **L** | written, never stored |
