# A `Dyn` clone of a boxed `Rc` payload reads the cell as the handle

**Severity:** S2 — a program that erases `Box.new(Rc.new(v))` into a `Dyn` listing `Clone` (every `AnyError`) fails to build: the C compiler rejects the clone thunk

**Status:** FIXED (found 2026-11-19 by the R7 lane while porting `tests/dyn.test.yo`'s boxed-`ref` row to `Rc`; develop `d8f0d89fa` has the same failure)

## Reproducer

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");
{ AnyError, Error } :: import("std/error");
{ ToString } :: import("std/fmt");
_DrsObjInner :: struct(n : i32);
_DrsObj :: Rc(_DrsObjInner);
impl(_DrsObj, ToString(to_string : (fn(self : &Self) -> String)(String.from("drs"))));
impl(_DrsObj, Error());
main :: (fn() -> unit)({
  (e : AnyError) = dyn(Box.new(Rc.new(_DrsObjInner(n : i32(7)))));
  assert(e.to_string() == String.from("drs"), "dispatches");
});
export(main);
```

`yo compile` stops in the C compiler:

```text
error: passing '__yo_t_7274730901591522626' (aka 'struct __yo_t_7274730901591522626_struct')
to parameter of incompatible type '__yo_t_9609255737449283638' (aka 'struct __yo_t_5448743270547310278_struct *')
  __yo_t_5448743270547310278* out = __yo_new___yo_t_5448743270547310278(__yo_scope_of_object(self_ptr), __yo_fs_12390766011701742988(box->_u42_));
```

## Root cause

`dyn(Box.new(x))` registers its impl with `payload_convention : true`: the
data word points AT the payload, here the `Rc` handle. The method wrappers
(`generate_dyn_wrapper_functions`) and the slot functions
(`_emit_payload_address`) test `payload_convention` first and read
`*(Rc*)self_ptr`. `_emit_dyn_clone_function` (`src/codegen/functions/dyn.yo`)
did not: it tested `is_boxed_type(data_type)` first, which is true for a cell
handle, so it read the data word as the `Rc`'s CELL, passed the cell's payload
field (`_DrsObjInner`) to the impl's `clone` (which takes the handle), and
wrapped the result in a fresh cell.

## Fix

`_emit_dyn_clone_function` takes the impl's `payload_convention`; a
payload-convention impl is never read as a boxed cell, and its clone lands in
fresh payload storage (`*out = clone(*(Rc*)self_ptr)`), as a value payload's
does. Test: `tests/dyn.test.yo`, "a downcast of a boxed Rc payload reads the
object" (it failed to build before the fix and clones the `AnyError` after it).
