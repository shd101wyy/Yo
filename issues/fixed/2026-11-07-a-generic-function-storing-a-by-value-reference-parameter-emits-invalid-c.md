# A generic function storing a by-value `T := &String` parameter emits C that re-borrows the parameter

**Severity:** S2 — the C compiler refuses the program (`incompatible pointer types`), no binary

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-generic-function-storing-a-by-value-reference-parameter-emits-invalid-c.yo`.

`yo check` accepts it; clang rejects the emitted C: `incompatible pointer types initializing 'const … *'`. Also `p04b_generic_store_binding.yo`.

## Root cause

The parameter half of `issues/fixed/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md` (VERDICTS-23 R3): a `T := &U` by-value slot is lowered as a borrowed place.

## Fix

with that issue (N2c/R3) (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

the R2 runtime canary of VERDICTS-23 §4 extended to a `store_g` call that reads the stored reference after the call.

## Resolution (R3, VERDICTS-23)

The three reports are one root: a function type's slot was either a borrow (`Reference`) or the bare by-value type,
and a by-value slot whose type became a reference at a specialization (`T := &U`) was the same `Reference` node as a
borrow. So `-> T` at `T := &U` was lowered as a projection (`-> &T`), a `v : T` at `T := &U` as a borrowed place, and
`Option(&T).unwrap`'s body `.Some(value) => value` was checked against the projection's `*(T)`.

- `TypeValueNode.ValueSlot(inner)` is a by-value slot of a reference type. `t_slot` and `t_slot_with_pointee` build it
  and substitution builds it for a bare slot that becomes a reference (`_subst_slot_at`); `t_slot_pointee` reads through
  it and `t_slot_is_borrow` is false for it, so every reader of a slot keeps its meaning. It prints parenthesized
  (`(&i32)`) and keys apart from the borrow `&i32` (`VS` in the intern key).
- A specialization whose by-value result is a reference (`!fn_result_is_ref(declared) && spec_ret_ty` is a reference)
  rewrites its result positions with `rewrite_value_reference_tails`: a bare name becomes the marked `addr_of(name.*)`
  (`VALUE_*_READ_PATH`), which reads a reference binding (a `match` payload binding, a `&T` parameter) as the reference
  value. The root rule of decision 24 does not apply to it: the result is a value.
- The enum-literal C no longer takes the address of a reference payload that is already a reference value (a by-value
  parameter, a call's result); only a place or a recorded lend does.

Tests: `tests/origins/reference_read_rule.test.yo`, "a generic result at T := &U is a reference value", "a generic
function stores its by-value reference parameter", "Option(&T).unwrap returns the reference".
