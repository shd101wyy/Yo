# Async State Machine Variable Optimization Plan
> **ARCHIVED 2026-09-04 — NOT IMPLEMENTED.** The async state-machine emitter
> still promotes await-crossing locals the straightforward way (no liveness-based
> field pruning in src/codegen/async/ as of 2026-09-04). Kept as the measured
> proposal; revisit if state-machine memory pressure ever shows in profiles.


## Problem

The Yo compiler currently stores **all** local variables from an async block body as fields in the state machine struct, regardless of whether they cross await boundaries. This wastes memory and harms cache utilization.

### Current behavior

Given:

```rust
task := io.async((using(io : Io)) => {
  a := i32(1);    // used in segment 0 AND segment 2
  b := i32(2);    // used ONLY in segment 0
  io.await(yield());
  c := i32(3);    // used in segment 1 AND segment 2
  d := i32(4);    // used ONLY in segment 1
  io.await(yield());
  e := (a + c);   // used ONLY in segment 2
  return e;
});
```

**Current**: All 5 variables (`a, b, c, d, e`) become struct fields.
**Optimal**: Only 2 variables (`a, c`) need struct fields; `b, d, e` can be C locals.

### Additional optimization: overlapping storage

Variables whose lifetimes don't overlap can share the same struct field (a union or reused slot):

- `b` (live only in segment 0) and `d` (live only in segment 1) are both `int32_t`
- They could share a single `int32_t` field in the struct
- This is the **storage conflict matrix** optimization used by Rust's async generator transform

## How Rust Optimizes This

Rust performs a multi-step optimization during async/generator lowering:

### Step 1: Liveness Analysis

For each variable, determine which **yield points** it is live across:

- A variable is "live across" a yield point if it is defined before the yield and used after it
- Variables only live within a single segment between yields are **not** stored in the generator struct

### Step 2: Storage Conflict Matrix

Build a boolean matrix `conflict[i][j]` where `conflict[i][j] = true` if variables `i` and `j` are both live at some point simultaneously:

- Two variables conflict if there exists any segment where both are live
- Non-conflicting variables can share storage

### Step 3: Slot Assignment (Graph Coloring)

Model the conflict matrix as an interference graph and use graph coloring to assign variables to storage slots:

- Each slot is a union of all variables assigned to it
- The slot's C type is the largest type assigned to it (or a `union` in C)
- This minimizes the total number of struct fields

### Reference

- Tyler Mandry, "How Rust optimizes async/await II: Program analysis" (https://tmandry.gitlab.io/blog/posts/optimizing-await-2/)
- Rust Project Goals: "Async statemachine optimisation" (https://rust-lang.github.io/rust-project-goals/2026/async-statemachine-optimisation.html)

## Implementation Plan for Yo

### Phase 1: Liveness Analysis (Primary optimization)

**Goal**: Only store variables that cross await boundaries in the struct.

#### Algorithm: Per-Segment Variable Liveness

```
Input: body expression, list of await points
Output: set of variables that must be in the struct ("cross-boundary variables")

1. Split body into segments at await points (already done: splitIntoStateSegments)

2. For each variable defined in the body:
   a. Determine the segment where it is DEFINED (first assigned)
   b. Determine all segments where it is USED (referenced)
   c. If max_used_segment > defined_segment (i.e., it crosses at least one await):
      → Mark as "needs struct storage"
   d. Otherwise:
      → Keep as C local variable in its segment's case block

3. Variables marked "needs struct storage" become struct fields
4. Other variables become `<type> <name>` declarations inside the case block
```

#### Implementation Steps

1. **Add segment tracking to suspension analysis** (`suspension-analysis.ts`):

   - During the tree walk, track which "segment index" each variable definition and use falls in
   - A variable definition is a `:=` or `let` expression
   - A variable use is any `Atom` referencing it
   - Segment index = number of suspension points encountered so far in the walk

2. **Compute cross-boundary set**:

   - For each captured variable, check if `definedInSegment < maxUsedInSegment`
   - Only those variables need struct fields

3. **Modify struct generation** (`async.ts:emitAsyncBlockStructDefinition`):

   - Only emit `var_{id}` fields for cross-boundary variables
   - Store the "segment-local" variable list for use during code generation

4. **Modify segment code generation** (`state-code-gen.ts`):

   - For segment-local variables, emit C local declarations (`int32_t a = ...;`) instead of `sm->var_a = ...;`
   - This requires the code generator to distinguish between struct-stored and local variables

5. **Modify variable access** (`atom.ts`):
   - When accessing a variable in state machine context, check if it's struct-stored or segment-local
   - Segment-local variables use plain C name; struct-stored use `sm->var_{id}`

#### Temp Future Variable Deduplication — IMPLEMENTED (Phase 1b)

When `io.await(yield())` creates a temp future, the suspension analysis captures it as a local variable
**and** the await analysis creates a separate `await_future_N` field — both for the same pointer.

**Solution: Field aliasing.** Temp vars stay in the SM variable map (so atom.ts and deferred drops work)
but no struct field is generated. `atom.ts` checks `stateMachineFieldAliases` and redirects lookups
to `sm->await_future_N`. Deferred drops become safe no-ops (await_future_N is already NULLed by the
resume function at the point where drops execute).

Key changes:

- `computeCrossBoundaryVariables()` returns `CrossBoundaryResult` with `awaitFutureTempVarAliases`
- `FunctionGenerationContext.stateMachineFieldAliases` stores the alias map
- `atom.ts` checks aliases before generating SM field access
- Struct definition and dispose function skip aliased vars

### Phase 2: Overlapping Storage (Advanced optimization)

**Goal**: Variables that don't conflict can share the same struct field.

#### Algorithm: Storage Conflict Matrix + Graph Coloring

```
Input: cross-boundary variables with their live segment ranges
Output: slot assignments (variable → slot index)

1. Build conflict matrix:
   For each pair of cross-boundary variables (A, B):
     conflict[A][B] = true if their live ranges overlap
     Live range of A = [definedInSegment, maxUsedInSegment]
     Overlap = ranges intersect

2. Build interference graph:
   - Nodes = cross-boundary variables
   - Edges = conflicting pairs (same-type only; different types can't share)

3. Graph coloring:
   - Use greedy coloring (sufficient for typical async functions)
   - Variables with same color and same C type share a slot

4. Generate struct fields:
   - One field per slot
   - If slot has multiple variables of same type: single typed field
   - If slot has variables of different sizes: use union

   Example:
     slot_0: int32_t (used by variables a, c at different times)
     slot_1: SomeType* (used by variables future1, future2 at different times)
```

#### Implementation Steps

1. After Phase 1 liveness analysis, build the conflict matrix
2. Implement greedy graph coloring for same-type variables
3. Generate `union` fields for mixed-type slots (or just pick the largest)
4. Update variable access to use slot names instead of variable names
5. Update dispose function to know which slot holds which variable at each state

**Note**: Phase 2 is more complex due to the dispose function needing to know what's in each slot at each state. Start with Phase 1 which gives the biggest win.

### Phase 3: Await Result Deduplication (Minor optimization)

**Goal**: Eliminate intermediate `await_result_N` struct fields for linear (non-cond) awaits.

Currently every non-unit await gets an `await_result_N` struct field. The resume function writes `sm->await_result_N = future->result`, then copies to `sm->var_X = sm->await_result_N`. For linear awaits (not inside cond/match branches), this intermediate step is unnecessary:

- **With target variable**: Assign directly to `sm->var_X = [dup](future->result)`, skipping `await_result_N`
- **Without target variable**: Result is unused, skip storage entirely
- **Inside cond**: Keep `await_result_N` because branch continuation code reads from it

## Priority

- **Phase 1** (Liveness): ✅ **IMPLEMENTED**. Segment-local variables in simple linear async blocks are now emitted as C locals.
- **Phase 1b** (Temp future aliasing): ✅ **IMPLEMENTED**. Temp future vars aliased to `await_future_N` fields, eliminating redundant struct fields.
- **Phase 2** (Overlapping storage): ✅ **IMPLEMENTED**. Same-type non-RC value variables with non-overlapping live ranges share struct fields via graph coloring. RC types excluded (deferred drops extend lifetime to function return).
- **Phase 2b** (Cond/while per-segment): ✅ **IMPLEMENTED**. Variables in non-branching segments can be C locals even when other segments have cond/while with await.
- **Phase 3** (Await result dedup): ✅ **IMPLEMENTED**. Linear awaits skip `await_result_N` entirely.

## Implementation Notes (Phase 1)

### What was implemented

The optimization is in the codegen layer (not the evaluator):

1. **`computeCrossBoundaryVariables()`** in `state-machine.ts`:

   - After splitting the body into segments, walks each segment's expression tree to collect variable references
   - Also walks `bodyExpr.$.deferredDropExpressions` (body-level cleanup)
   - Variables appearing in only ONE numbered segment are "segment-local"
   - Variables only in the cleanup segment (deferred drops) are conservatively kept in struct
   - Variables not found by the walker are conservatively kept in struct

2. **Filtered analysis**: In `async.ts:generateDeferredAsyncBlocks`, the `analysis.capturedVariables` is filtered to exclude segment-locals before being passed to the resume function generator. This ensures ALL internal `stateMachineVariables` map-building code automatically excludes segment-locals.

3. **Struct definition**: `emitAsyncBlockStructDefinition` receives `crossBoundaryIds` and only emits struct fields for cross-boundary variables.

4. **Dispose function**: Updated to only drop cross-boundary variables' struct fields on escape (state == -2).

### Limitations / conservative fallbacks

- **Cond/match/while with await (per-segment)**: When a segment's await point is inside a conditional or loop, variables appearing only in that segment are conservatively kept in the struct (because cond/while branch continuations run in separate case blocks). Variables in other non-branching segments are still eligible for C-local optimization.
- **Cleanup-only variables**: Variables that appear only in deferred drop expressions (not in any numbered segment) are kept in the struct.
- **Unresolved variables**: Variables captured by suspension analysis but not found by the expression walker are conservatively kept in the struct.

## Testing Strategy

1. Compile examples with `--emit-c --skip-c-compiler` and verify struct field counts
2. Run existing `tests/async_await.test.yo` to ensure no regressions
3. Add new tests for edge cases:
   - Variables used in only some segments
   - Variables reassigned after await
   - Variables in conditional branches with await
   - Variables in while loops with await
   - RC-typed variables (Box, String) that need dup/drop

## Implementation Notes (Phase 3)

### What was implemented

The optimization eliminates `await_result_N` intermediate struct fields for linear awaits:

1. **Struct definition** (`async.ts:emitAsyncBlockStructDefinition`):

   - `await_result_N` fields are only emitted when `awaitPoint.isInsideCond` is true
   - Linear awaits (not inside cond) skip the field entirely

2. **Resume function** (`state-machine.ts:generateAsyncBlockResumeFunction`):
   - For linear awaits with `targetVariableId`: assigns directly to `sm->var_X = [dup](future->result)`
   - For linear awaits without target: skips result storage (unused)
   - For cond awaits: writes to `sm->await_result_N` as before, then copies to target

### Files modified

- `src/codegen/exprs/async.ts`: Struct field generation filtered by `isInsideCond`
- `src/codegen/async/state-machine.ts`: Direct assignment in resume function

## Implementation Notes (Phase 2b)

### What was implemented

Replaced the global conservative fallback (which disabled the optimization entirely when ANY await was inside cond/while) with per-segment analysis:

1. **`computeCrossBoundaryVariables()`** in `state-machine.ts`:

   - Builds `branchingAwaitSegmentIndices`: the set of segment indices whose `awaitPoint` has `isInsideCond || isInsideWhile`
   - For variables appearing in exactly 1 segment: if that segment is in the branching set, the variable stays in the struct; otherwise it becomes a C local
   - Variables in 2+ segments are still cross-boundary (unchanged)
   - Variables only in cleanup or not found by walker are still conservative (unchanged)

### Why branching-segment variables must stay in struct

When a cond/while has an await inside a branch, `generateCondWithAwait`/`generateWhileWithAwait` emit separate case blocks for the branch continuation. These case blocks are NOT represented in `splitIntoStateSegments`. A C local declared in the segment's case block would not be accessible in the continuation's case block, so variables in branching segments must remain as struct fields.

### Improvement over Phase 1

**Before Phase 2b**: Any cond/while with await forces ALL variables in ALL segments to be struct fields.
**After Phase 2b**: Only variables in the specific branching segment are forced to struct fields. Variables in other segments benefit from Phase 1 C-local optimization.

### Files modified

- `src/codegen/async/state-machine.ts`: Replaced early-return `hasBranchingAwait` check with per-segment `branchingAwaitSegmentIndices` logic

## Implementation Notes (Phase 2)

### What was implemented

Phase 2 enables overlapping storage for same-type non-RC value variables with non-overlapping live ranges, using greedy graph coloring. Variables that can share get a single `slot_N` struct field instead of separate `var_X` fields.

1. **`computeOverlappingSlots()`** in `state-machine.ts`:

   - Filters to non-RC value-type variables that are in `crossBoundaryIds`
   - Builds live ranges `[min_segment, max_segment]` from `variableSegments` (excluding cleanup segment -1)
   - Groups by C type string — only same-type variables can share a slot
   - Builds interference graph: two variables conflict if ranges overlap (`minA <= maxB && minB <= maxA`)
   - Greedy graph coloring assigns each variable a color; variables with same color share a slot
   - Only creates slot aliases when 2+ variables actually share a color

2. **Struct definition** (`async.ts:emitAsyncBlockStructDefinition`):

   - Accepts `overlappingSlotAliases` and `overlappingSlots` parameters
   - Local variables in the slot alias map are skipped (no individual `var_X` field)
   - Slot fields emitted as `<cType> slot_N; // shared: varA, varB`

3. **Alias wiring** (`async.ts:generateDeferredAsyncBlocks`):

   - Slot aliases merged into `stateMachineFieldAliases` alongside Phase 1b temp future aliases
   - `atom.ts` (already alias-aware) automatically redirects `sm->var_X` lookups to `sm->slot_N`

4. **Field name resolution** (`state-machine.ts:getStateMachineFieldName`):

   - Extended with optional `aliases` parameter for alias-aware resolution
   - All call sites in `state-machine.ts` pass `context.stateMachineFieldAliases`

5. **Raw `sm->var_` pattern fixes**:

   - `state-code-gen.ts`: 2 match-destructuring patterns now use `getStateMachineFieldName` with aliases
   - `initialization-assignment.ts`: 4 patterns updated
   - `match.ts`: 3 patterns updated
   - `dyn.ts`: 1 pattern updated

### Why RC types are excluded

RC types (object, String, Box, dyn, etc.) have body-level deferred drops that execute at function return. This means their effective lifetime extends from definition to function end, regardless of when they were last referenced. Two RC variables almost always have overlapping lifetimes.

If we did share RC slots, assigning variable B to a slot holding variable A would overwrite A's pointer, causing a memory leak (A is never dropped). Fixing this would require inserting explicit drops before slot reuse and modifying the deferred drop system — too complex for the benefit.

Since only non-RC types are shared, no changes to the dispose function are needed (it only drops RC types).

### Files modified

- `src/codegen/async/state-machine.ts`: Added `variableSegments` to `CrossBoundaryResult`, `computeOverlappingSlots()`, `OverlappingSlot`/`OverlappingStorageResult` interfaces, alias parameter on `getStateMachineFieldName`
- `src/codegen/exprs/async.ts`: Struct definition with slot fields, alias merging, all 3 call sites updated
- `src/codegen/async/state-code-gen.ts`: Raw pattern fixes (2 locations)
- `src/codegen/exprs/initialization-assignment.ts`: Raw pattern fixes (4 locations)
- `src/codegen/exprs/match.ts`: Raw pattern fixes (3 locations)
- `src/codegen/exprs/dyn.ts`: Raw pattern fix (1 location)
- `tests/async_await.test.yo`: 4 new tests (114 total)

## C Output Size Reduction

After the SM optimization phases, additional work was done to reduce generated C output size:

### Static linkage (all generated C functions)

All generated C functions (both user-facing and internal helpers like `___dup`, `___drop`, RC helpers) are now declared `static`. This enables the C compiler's dead code elimination to strip unused functions, dramatically reducing binary size.

**Impact**: Non-async hello world dropped from ~84KB to ~33KB (stripped binary).

### Conditional async runtime emission

The async runtime (~8K C lines) is only emitted when `context.usesAsync` is true. Detection is based on:

- `isIoAsyncCall(expr)`, `isIoAwaitCall(expr)`, `isIoSpawnCall(expr)` during codegen scan
- Extern "yo" calls matching `ASYNC_RUNTIME_EXTERN_PREFIXES`: `__yo_poll_*`, `__yo_fs_event_*`, `__yo_async_*`

Parallelism runtime (~450 lines) is separately gated by `context.usesParallelism`.

### Platform sync/async split

Each platform runtime file was split into:

- `generatePlatformSysRuntime{Platform}(emitter)` — sync helpers (pipe, dup, mmap, fcntl, socket, stat, signal, TTY), always emitted
- `generateAsyncRuntimeIO{Platform}(emitter)` — async I/O (IOCP, io_uring, kqueue), conditionally emitted

### Consistent `__yo_async_*` naming

All `yo_async_*` identifiers renamed to `__yo_async_*` for consistency with other internal C helpers.

### Commits (C output size reduction)

1. `5e7bac89` — Conditional async runtime emission
2. `e97d3fe8` — Conditional parallelism runtime emission
3. `e8d1c778` — Static linkage for user-facing functions
4. `42a3f569` — Static linkage for ALL internal C helpers
5. `41233a7f` — Fix: add errno.h to base C includes
6. `af57b323` — Refactor: extract non-async sys helpers
7. `29763eae` — Extract platform sync helpers + restore conditional usesAsync detection
8. `66e3fa69` — Fix: Windows sync helpers use lightweight WSA init
9. `81746ed3` — Fix: remove duplicate \_\_yo_win_stat_t from async section
10. `7f8253b4` — Fix: move Windows signal operations to sync section
11. `32fd7f76` — Fix: move Windows TTY operations to sync section
12. `742c8af5` — Rename `yo_async_*` to `__yo_async_*` for consistent naming
13. `cd66e94c` — Fix: associate sockets with IOCP in async send/recv on Windows
