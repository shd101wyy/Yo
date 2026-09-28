# `Result.expect_err` escapes the class-1 panic ban

**Status: FIXED 2026-09-28** (branch `safe-mode/class1-governance`,
`plans/SAFE_MODE.md` §14 R7).

## Symptom

`Result.expect_err(msg)` returns the `Err` payload and traps on `Ok`. The
failure information is already in the receiver's type, so by D7's criterion it
is class 1, the same as `unwrap_err`. Yet a safe file calls it without a
diagnostic. Measured on v0.2.45:

```rust
{ println } :: import("std/fmt");

parse :: (fn(ok : bool) -> Result(i32, i32))({
  return(
    cond(
      ok => Result(i32, i32).Ok(i32(7)),
      true => Result(i32, i32).Err(i32(3))
    )
  );
});

main :: (fn() -> unit)({
  e := parse(false).expect_err("expected a failure");
  println(`e=${e}`);
});
export(main);
```

`yo check main.yo` → `evaluator OK`, and `yo compile main.yo --skip-c-compiler`
exits 0. The same file with `.unwrap_err()` fails with E0611.

## Root cause

The ban is a name list, `is_class1_panic_method_name` in
`src/evaluator/memory_safety.yo`: `unwrap`, `expect`, `unwrap_err`. Phase 0c
built it from the H12 inventory (`Option.unwrap`/`expect`,
`Result.unwrap`/`unwrap_err`), which missed `Result.expect_err`
(`std/prelude.yo`, the second `Result(OkType, ErrorType)` impl). Nothing
compared the list with the prelude, which is the governance check §3 0c
specified and §14 R7 left open.

## Fix

- `expect_err` joins the name list. No safe file in `std/`, `src/` or `vendor/`
  called it, so no migration was needed. Its only callers are in
  `tests/prelude.test.yo`, which the `*.test.yo` exemption covers.
- `src/public_safe_report.yo` gains `scan_class1_extractions`. It lists every
  method of an `Option(...)`/`Result(...)` impl whose body reaches
  `__yo_panic`, marked `gated`, `comptime` (a `comptime(self)` method, whose
  panic is already a compile error: R2), or `UNGATED`. `yo public-safe-report`
  prints the section, and the JSON gains `class1Extractions` and
  `totals.class1Ungated`.
- `tests/internal/memory_safety_paths.test.yo` runs the scanner over the real
  `std/prelude.yo` and fails on any `UNGATED` method. It also asserts that the
  known methods are seen, so a scanner that finds nothing cannot pass
  vacuously. A new or renamed trapping extraction now fails a test instead of
  opening a silent hole.

## Verification

- cli-case `safe-mode-expect-err-rejected`: rc 0 under the v0.2.45 seed (red),
  rc 1 with the E0611 diagnostic under the fixed binary.
- The prelude test reports `UNGATED: Result.expect_err` against the old list
  and passes against the new one.
