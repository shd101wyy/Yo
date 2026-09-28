# `consume(p.* = v)` loads the uninitialized old value (undefined behavior)

**Status: FIXED 2026-09-28** (found by the first CI run of
`.github/workflows/ubsan.yml`, run 36374633260; branch
`safe-mode/union-read-gate`).

## Symptom

On ubuntu-latest, 7 of 4523 language tests failed under
`YO_TEST_SANITIZE=undefined` with, for example:

```
runtime error: load of value 64, which is not a valid value for type 'bool'
```

The failing tests were in `rand`, `imm_threading`, `closure`,
`string/string_byte_index` and `sync/channel`. Each one grows a container of
`bool`, as in `ArrayList(bool).push`. macOS passed the same suite, because a
fresh allocation there happens to be zeroed. With `MallocScribble=1`, which
fills every allocation with 0xAA, macOS reproduces it deterministically: the
same five files report 11 invalid loads.

## Root cause

`ArrayList.push` writes the new slot with `consume(target_ptr.* = value)`:
the slot is uninitialized, so its old value must not be dropped. But
`consume(...)` only suppresses the drop. The assignment underneath still saved
the old value into its result temp with a typed load:

```c
bool _file____User_temp_176… = (*target_ptr); // Save old value for later use
(*target_ptr) = value;
```

That load reads the uninitialized slot. For `bool` (and any type with invalid
bit patterns) it is undefined behavior, and for a reference type it
materializes a garbage pointer. The drop is correctly skipped, but the read
has already happened.

## Fix

`generate_consume` (`src/codegen/exprs/consume.yo`) sets
`consume_assignment_saves_by_bytes` for an assignment argument, and
`generate_assignment` reads and clears the flag before emitting anything. The
consumed assignment saves its old value with `memcpy`:

```c
bool _file____User_temp_176…; memcpy(&_file____User_temp_176…, &((*target_ptr)), sizeof(_file____User_temp_176…));
```

Copying indeterminate bytes is defined, and no typed load occurs unless the
consumed old value is actually used. The value `consume(...)` hands out is
unchanged. Every other assignment's C is byte-identical, because the flag is
set only for `consume`'s own argument.

## Verification

- `MallocScribble=1 YO_TEST_SANITIZE=undefined yo test` over the five files:
  11 invalid-`bool` reports with the pre-fix compiler, 0 after.
- A minimal `ArrayList(bool)` push/read program aborts under
  `--sanitize undefined` + `MallocScribble=1` before the fix (value 170, the
  scribble byte) and runs clean after.
- The weekly `.github/workflows/ubsan.yml` run is the regression gate.
