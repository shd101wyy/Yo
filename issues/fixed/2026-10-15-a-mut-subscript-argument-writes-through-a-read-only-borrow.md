# A `&mut` subscript argument writes through a read-only borrow

**Severity:** S2 — `f(&mut xs(i))` passes `yo check` and writes the caller's element when `xs` is a `&` (read-only) borrow, though the same write as `xs(i) = v` is E0908.

**Status:** FIXED 2026-10-15 on `feat/vbd-v2b-projection-calls-rebased` (#1368). Regression test: `_v2b_mut_elem_arg_through_shared` in `tests/index.test.yo`.

**Found:** 2026-10-15, by #1368's Tier 1: the PR's `_v2b_mut_arg_through_read` expectation (a read projection's place lent bare to a `&mut` parameter) was not rejected, and the same gap covers the subscript.

## Reproducer

Develop at 31ef8d7a3 (V2b Generation B, #1361, made a subscript write through a read-only binding E0908):

```yo
{ ArrayList } :: import("std/collections/array_list");
bump :: (fn(v : &mut i32) -> unit)({
  v = (v + i32(1));
});
run_borrowed :: (fn(target : &ArrayList(i32)) -> unit)({
  bump(&mut target(usize(0)));
});
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(41));
  run_borrowed(&xs);
});
export(main);
```

`yo check` reports `evaluator OK`. `target(usize(0)) = i32(1)` in the same body is E0908 ("`target` is a read-only borrow").

## Root cause

A write position re-dispatches an element access to `IndexMut.index_mut`, whose `&mut Self` receiver must be writable (`promote_index_places_for_write`, `src/evaluator/calls/index_trait.yo`). For a `&mut` argument that promotion runs in `check_if_function_parameter_matches_argument` (`src/evaluator/calls/helper.yo`). A call of a known function value takes the `FuncVal` arm of `_evaluate_function_call_unanchored` (`src/evaluator/calls/function.yo`), which evaluates its arguments in its own loop and never ran it, so `&mut xs(i)` stayed a read dispatch through the read-only binding.

## Fix

The `FuncVal` arm's argument loop promotes a `&mut` parameter's argument as `check_if_function_parameter_matches_argument` does. `tests/ref_field_borrow.test.yo`'s unwind test wrote an element through a `&ArrayList(i32)` parameter this way; its `run_borrowed` now takes `&mut ArrayList(i32)`.
