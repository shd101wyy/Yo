# A closure or `io.async` body capturing `&mut` of an `Option(&T)` or origin-parameterized holder local crashes codegen

**Severity:** S1 — compiler crash on a valid program (`get_type_string: … type not collected before lowering`)

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-closure-capturing-an-origin-carrying-local-crashes-codegen.yo`.

`yo check` accepts it; `yo compile` aborts in `src/codegen/utils/index.yo` with `get_type_string: no C type name found for <struct:capture_…>`. Also `h2_closure_param_into_capture_string.yo`, `h2b_closure_fnmut_slot.yo`, `p37_async_store_local.yo`.

## Root cause

A capture list's borrow entry is a pointer field of the capture struct (`s : &mut slot` is `*(Option(&i32))`).
`origin_beyond_n2b` (`src/types/utils.yo`) reads a pointer to an origin-carrying type as storage outside the
composite, a container's element buffer or a cell (N2c/N2d), so the capture struct was "beyond N2b" and
`collect_type` (`src/codegen/types/collection.yo`) skipped its C type; lowering the closure then found no C name
for it. The check side never walls a closure value, so `yo check` accepted the program.

## Fix

`_any_field_beyond_n2b` skips a capture struct's borrow entries (`capture_struct_borrows`): such a field is a
reference by another spelling (decision 38 A), an inline position exactly like a `&T` field, so it walls nothing by
itself. The other fields are walked as before.

## Test that pins it

`tests/closure_capture_list.test.yo`, "a closure capturing `&mut` of an origin-carrying local compiles and writes
through": a closure capturing `&mut slot : Option(&i32)` and writing `.None`, compiled and run.
