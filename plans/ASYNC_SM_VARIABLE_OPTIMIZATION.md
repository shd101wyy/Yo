# Async State Machine Variable Optimization Plan

## Problem

The Yo compiler currently stores **all** local variables from an async block body as fields in the state machine struct, regardless of whether they cross await boundaries. This wastes memory and harms cache utilization.

### Current behavior

Given:

```yo
task := io.async((using(io : IO)) => {
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

#### Temp Future Variable Deduplication

As a sub-task of Phase 1, also fix the temp future duplication issue:

- During suspension analysis, skip capturing temp variables that are direct arguments of `io.await()` calls
- These futures are already stored in `await_future_N` fields

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

**Goal**: Don't store `await_result_N` if the result is never used.

This is a minor optimization. Currently `await_result_N` is emitted for every non-unit await. If the result of an await is never assigned to a variable (e.g., `io.await(yield())`), the `await_result` field is unnecessary.

## Priority

- **Phase 1** (Liveness): ✅ **IMPLEMENTED**. Segment-local variables in simple linear async blocks (no cond/while with await) are now emitted as C locals.
- **Phase 2** (Overlapping): Medium priority. More complex, diminishing returns for typical async functions.
- **Phase 3** (Await result): Low priority. Minor savings.

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

- **Cond/match/while with await**: When any await point is inside a conditional or loop, the optimization is **disabled** for the entire async block. This is because cond/while branch continuations generate additional case blocks not represented in `splitIntoStateSegments`, making the segment-based analysis insufficient.
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
