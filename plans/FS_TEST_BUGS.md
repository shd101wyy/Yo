# FS Test Suite — Remaining Bugs

Bugs discovered while making the `tests/fs/` test suite work. Items marked ✅ are already fixed.

## ✅ Fixed

### 1. Match arm variable scoping (codegen)

- **File**: `src/codegen/exprs/match.ts`
- **Symptom**: `.Ok(e)` and `.Err(e)` in same match cause C compilation error — `bool e` conflicts with `IOError e`
- **Root cause**: Generated C `switch/case` bodies were not wrapped in `{ }`, so all case arms shared the same scope
- **Fix**: Added `{ }` block scoping around every case body (6 locations in match.ts)

### 2. Async return skipping deferred drops (codegen)

- **File**: `src/codegen/functions/generation.ts`
- **Symptom**: Memory leaks in async functions (e.g., `write_file`, `File.open`) — ASan reports leaked `Path` temporaries
- **Root cause**: When async function bodies return, codegen did `return resultCode;` and exited early without emitting deferred drop expressions
- **Fix**: Save async result to temp variable, emit deferred drops, then return

### 3. Frame level merge with temp variables (evaluator)

- **File**: `src/expr.ts` (`mergeAndCheckEnvs`)
- **Symptom**: `cond(e => i32(1), true => i32(0))` used inline as function argument causes "Frame level N has different variable names for different cases" error
- **Root cause**: Different cond branches create temp variables with different counter names (e.g., `_temp_24758` vs `_temp_24759`)
- **Fix**: Allow name mismatches when both names are temp variables (`isTempVariableName` check)

### 4. "field 'value' has incomplete type" (codegen — type ordering)

- **File**: `src/codegen/types/generation.ts`
- **Symptom**: C compilation error: `field 'value' has incomplete type` for `Option(DirEntry)`, `Option(WalkEntry)`, etc.
- **Root cause**: The enum variant dependency builder in the topological sort only handled newtypes, enums, and tuples by value — it was missing the case for value structs (non-object, non-newtype) like `DirEntry`. So `Option(DirEntry)` was emitted before `DirEntry` had its full definition.
- **Fix**: Added the missing value-struct dependency case to the enum variant dependency builder, analogous to the struct field handler

---

## Open Bugs

### ~~5. Async await in while loop hangs (`create_dir_all`)~~ — FIXED

- **Affects**: `create_dir_all` test in `dir.test.yo` (1 test)
- **Symptom**: `create_dir_all` hangs when creating nested directories (e.g., `a/b/c`)
- **Root cause**: Multiple interrelated bugs in async state machine code generation for `cond` expressions nested inside `while` loops:
  1. **Missing while loop remaining body expressions** — `generateWhileBodyWithAwait` returned empty `remainingExprs` when the await-containing expression was a `cond` or `match`, missing expressions like loop counter increments (`i = (i + 1)`)
  2. **Nested cond `asyncCondBranchInfo` overwrite** — When multiple nested `cond` expressions share the same `awaitPoint.index`, the outer conds' `asyncCondBranchInfo.set()` call overwrites the inner cond's entry. The inner cond has actual remaining code (error check, deferred drops), which is lost.
  3. **`cond_branch_N` field conflict** — All nested conds write to the same `sm->cond_branch_N` field. The innermost cond's value overwrites the outer cond's value, making post-while-loop code guards (`if (sm->cond_branch_N == branchIdx)`) and downstream state switch guards always fail.
- **Fix**:
  - `src/codegen/async/state-code-gen.ts`:
    - Collect remaining body expressions after `generateCondWithAwait`/`generateMatchWithAwait` in `generateWhileBodyWithAwait`
    - Don't overwrite `asyncCondBranchInfo` when an inner cond already stored an entry with non-empty `remainingExprs`
    - Detect nested cond conflict and set `skipCondBranchCheck: true` on `condBranchPostWhileExprs`
  - `src/codegen/async/state-machine.ts`:
    - Skip `if (sm->cond_branch_N == branchIdx)` guard for post-while code when `skipCondBranchCheck` is set
    - Propagate `condBranchFieldIndex: -1` (sentinel for "unconditional") to chained branch entries
    - Handle `condBranchFieldIndex === -1` in standard switch generation — emit code without switch/case wrapping
  - `src/codegen/functions/context.ts`: Added `skipCondBranchCheck` flag to `condBranchPostWhileExprs` type

### ~~6. Heap-use-after-free in read_dir / walker / temp (dup/drop)~~ — PARTIALLY FIXED

- **Affects**: ~~`read_dir` in `dir.test.yo`~~, all `walk` tests in `walker.test.yo` (5 tests), 5 tests in `temp.test.yo` (TempDir/TempFile)
- **Symptom**: ASan reports heap-use-after-free — accessing memory after it's been freed
- **Root cause**: Short-circuit `||` and `&&` expressions in loops generated if-chains for side-effectful args but left all temp drops at the enclosing begin block unconditionally. On loop iterations where the short-circuit was taken, drops ran on uninitialized/stale memory.
- **Fix** (commit `8dd2c190`): Added `emitDropsForConditionalBranch` in `and-or.ts` — drops for conditionally-created temps are now emitted inside the if-blocks, and marked in `shortCircuitHandledDropVarNames` so `begin.ts` skips them. Changes:
  - `src/codegen/exprs/and-or.ts` — `collectCreatedVarNamesFromExpr`, `emitDropsForConditionalBranch`
  - `src/codegen/exprs/begin.ts` — skip drops in `shortCircuitHandledDropVarNames` set
  - `src/codegen/functions/context.ts` — added `shortCircuitHandledDropVarNames` field
- **Status**: `read_dir lists directory entries` now passes with ASan clean. Walker/temp tests may still have separate issues — to be confirmed.

### ~~7. SEGV in async cond implicit return (non-await branch value not stored)~~ — FIXED

- **Affects**: `create_dir_all on existing directory succeeds`, `read_dir on nonexistent returns error` in `dir.test.yo`
- **Symptom**: SEGV in `__yo_incr_rc`/`__yo_decr_rc` at null pointer — accessing zero-initialized `sm->result` with tag=OK pointing to NULL
- **Root cause**: When a `cond` expression in an async function has one branch with awaits and one without, the non-await branch's value was computed as a local variable but never stored in `sm->result`. The state machine jumped to the next state via `goto`, leaving `sm->result` zero-initialized. On dup, this read `.Ok.value = NULL` and crashed.
- **Fix**: Proper codegen-level fix in the async state machine code generator:
  - `src/codegen/async/state-machine.ts`: Detects when the segment's last expression IS the async body's implicit return value and sets `context.asyncBodyReturnExpr` on the generation context
  - `src/codegen/async/state-code-gen.ts`:
    - `generateCondWithAwait`: Non-await branches check `shouldEmitAsyncCompletion` — when the cond IS the body's implicit return, the non-await branch generates: value → `sm->result = value` → drop pending deferred drops → `emitAsyncFutureCompletion` → `return;`
    - `generateCondBranchWithAwait`: Propagates `asyncBodyReturnExpr` to nested conds/matches that are the last expression in the branch (transitive tail position)
    - Added `exprContainsReturnStatement` helper to avoid double-completion when a branch already has explicit `return`
  - `src/codegen/functions/context.ts`: Added `asyncBodyReturnExpr?: Expr` field
  - `std/fs/dir.yo`: Reverted all explicit `return ret;` workarounds — non-await branches now use natural implicit return values (`.Ok(())`, `.Err(...)`)
- **Note**: The `canOptimizeToDirect` path in `generateCondWithAwait` and match-with-await branches have the same theoretical gap but are not triggered by current std library code. Can be addressed separately.

### 8. `i32(bool)` type conversion not supported

- **Affects**: Test convenience — had to use `cond(val => i32(1), true => i32(0))` instead of `i32(val)`
- **Symptom**: Cannot convert bool to i32 directly
- **Root cause**: No implicit or explicit bool→i32 conversion implemented
- **Severity**: Low — workaround exists (`cond`)

---

## Test Suite Status

| Test file        | Passing | Total  | Blocking bugs |
| ---------------- | ------- | ------ | ------------- |
| file.test.yo     | 13      | 13     | —             |
| metadata.test.yo | 6       | 6      | —             |
| dir.test.yo      | 12      | 12     | —             |
| temp.test.yo     | 2       | 7      | TBD           |
| walker.test.yo   | 1       | 6      | TBD           |
| **Total**        | **34**  | **44** |               |

## Suggested Fix Order

1. **#8 — i32(bool)** (quality of life)
2. **Walker/temp TBD bugs** (check walker and temp tests for remaining issues)
