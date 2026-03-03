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

### 5. Async await in while loop hangs (`create_dir_all`)

- **Affects**: `create_dir_all` test in `dir.test.yo` (1 test)
- **Symptom**: `create_dir_all` hangs when creating nested directories (e.g., `a/b/c`)
- **Root cause**: Likely an issue with async await inside a while loop — the state machine may not advance correctly or the loop condition doesn't terminate
- **Severity**: Medium — blocks 1 test, may affect other async-while patterns

### 6. Heap-use-after-free in read_dir / walker / temp (dup/drop)

- **Affects**: `read_dir` in `dir.test.yo` (2 tests), all `walk` tests in `walker.test.yo` (5 tests), 5 tests in `temp.test.yo` (TempDir/TempFile)
- **Symptom**: ASan reports heap-use-after-free — accessing memory after it's been freed
- **Root cause**: Likely incorrect dup/drop generation for complex types containing `String` fields. The `from_cstr` function in `read_dir` accesses freed memory. Similar issues in TempDir/TempFile.
- **Severity**: High — blocks 12 tests across 3 test files

### 7. `i32(bool)` type conversion not supported

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
| dir.test.yo      | 9       | 12     | #5, #6        |
| temp.test.yo     | 2       | 7      | #6            |
| walker.test.yo   | 1       | 6      | #6            |
| **Total**        | **31**  | **44** |               |

## Suggested Fix Order

1. **#6 — Heap-use-after-free** (unblocks up to 12 tests across dir, walker, temp)
2. **#5 — Async while loop** (unblocks 1 test)
3. **#7 — i32(bool)** (quality of life)
