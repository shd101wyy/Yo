# A closure or `io.async` body capturing `&mut` of an `Option(&T)` or origin-parameterized holder local crashes codegen

**Severity:** S1 — compiler crash on a valid program (`get_type_string: … type not collected before lowering`)

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-closure-capturing-an-origin-carrying-local-crashes-codegen.yo`.

`yo check` accepts it; `yo compile` aborts in `src/codegen/utils/index.yo` with `get_type_string: no C type name found for <struct:capture_…>`. Also `h2_closure_param_into_capture_string.yo`, `h2b_closure_fnmut_slot.yo`, `p37_async_store_local.yo`.

## Root cause

The capture-struct type of an origin-carrying captured local is not registered for codegen (N2b's composites against the capture path).

## Fix

O-3, v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

a POSITIVE test (a closure capturing `&mut slot : Option(&i32)` and writing `.None`) in `tests/closure_capture_list.test.yo`, compiled and run.
