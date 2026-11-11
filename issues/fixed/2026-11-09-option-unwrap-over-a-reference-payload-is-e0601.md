# `Option(&T).unwrap()` is E0601 inside std

**Severity:** S2. A valid program is rejected: `unwrap()` on any `Option(&T)` fails to type-check, so a by-value
`Option` of a reference can be read only with `match`.

Found 2026-11-09 while writing the tests for
`issues/fixed/2026-11-08-a-match-binding-of-a-reference-payload-carries-its-own-place-as-origin.md`. Present in the
v0.2.76 seed and on develop e769f6b0d.

## Reproducer

```yo
{ assert } :: import("std/assert");
_p :: (fn(r : &i32) -> Option(&i32))(.Some(r));
test("unwrap of a reference payload", {
  x := i32(4);
  o := _p(&x);
  v := o.unwrap();
  assert(v.* == i32(4), "u");
});
```

```
error[E0601]: Incompatible type with expected type:
- Expected: *(i32)
- Actual  : i32
note: raised here, inside the standard library
     --> std/prelude.yo:8214:23
8214 |       .Some(value) => value,
```

The `match` spelling, `match(_p(&x), .Some(v) => (v.* == i32(4)), .None => false)`, is accepted and runs.

## Root cause

It shares the root cause of `issues/fixed/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md` (VERDICTS-23 R3) and is fixed with it.


`unwrap : (fn(self : Self) -> T)(match(self, .Some(value) => value, …))` specialized at `T := &i32`. The arm binds
`value` as a reference payload binding (decision 43 step 3), whose name has the pointee's type. The arm's value is
then checked against the result `T`, the reference, and is read as the pointee instead of the reference value. The
expected type prints as `*(i32)`, so the specialization's result is lowered to a pointer before the check. That
suggests the read rule (R1, N1e-2b) does not see a generic result slot bound to a reference as a position that
expects one.

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

Shares R3's root cause with `issues/fixed/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md`: the result `T` at `T := &i32` was the projection's `*(i32)`.
