# A generic function's result at `T := &U` is lowered as a projection, and its C does not compile

**Severity:** S2: a program the checker accepts fails in the C compiler. A
generic function returning `T`, specialized at `T := &U`, is lowered as a
`-> &T` projection, so its C returns `T*` from a function declared to return
`const T**`.

> Found 2026-11-06 while testing N1e-2b PR 2b (decision 43 step 2, the R1
> read rule). PR 2b makes `id(r)` with `r : &i32` bind `T := &i32` (before it,
> E0926 rejected the call outside the exempt trees). VERDICTS-23 assigns this
> case to N2c as R3.

## Reproducer

```yo
rr_id :: (fn(generic(T : Type), v : T) -> T)(v);
main :: (fn() -> unit)({
  y := i32(6);
  r := &y;
  _s := rr_id(r);
  ()
});
export(main);
```

`yo check` accepts this program on PR 2b. `yo compile` fails:

```text
error: incompatible pointer types returning 'int32_t *' (aka 'int *') from a function with result type 'const int32_t **' (aka 'const int **') [-Werror,-Wincompatible-pointer-types]
yo: error: compile: C compiler failed (exit 1)
```

The binding is also mistyped. `_s` becomes a projection's reference binding
of type `&&i32`, so a later `type_of(_s)` reads it whole (E0926).

## Root cause

`fn_result_is_ref` holds for the specialized function type, because its
result slot is the reference type `&i32`. That type is a `T := &U` VALUE, but
every reader treats the call as a projection:

- the call site reads its result through (`(*call)`);
- the callee's lowering returns `&(body)`;
- `_bind_projection_result` binds `_s` as a reference binding.

A result typed `&U` because the declaration spells `-> &T` is a projection. A
result that is `&U` only because a type parameter was bound to it is a value.
That distinction is not kept in the function type.

## Fix

VERDICTS-23 R3 (N2c): keep the declared result's shape (a spelled `&` versus
a type parameter) through specialization, and lower a `T := &U` result as a
pointer value. Test: `tests/origins/reference_read_rule.test.yo`'s
`rr_id_of_reference` gains a call with `rr_read(_s)` at runtime.

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
