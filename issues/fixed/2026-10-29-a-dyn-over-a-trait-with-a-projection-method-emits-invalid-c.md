# A Dyn over a trait with a projection method emits invalid C

**Severity:** S2: a valid `Dyn(Trait)` whose trait has a projection method (`-> &T`, decision 24) passes `yo check` and then fails in the C compiler, so a reference-returning trait method cannot be called through a `Dyn`.

**Status:** FIXED 2026-10-29 (`vbd/d43-step2-n1c`). **Found:** 2026-10-29, writing decision 43 step 2 N1c's O7 test (a `Dyn` call maps its result origin from the trait's signature). The develop-built binary at `086b01a7e` fails the same way, so the bug predates N1c.

## Reproducer

```yo
Pk :: trait(pick : (fn(self : &Self, other : &i32) -> &i32));
One :: struct(v : i32);
impl(One, Pk(pick : (fn(self : &Self, other : &i32) -> &i32)(&self.v)));
rd :: (fn(x : &i32) -> i32)(x + i32(0));
main :: (fn() -> unit)({
  (d : Dyn(Pk)) = dyn(One(v : i32(22)));
  o := i32(2);
  r := d.pick(&o);
  _ := rd(r);
  ()
});
export(main);
```

```text
n1c_dynproj.c:984:42: error: passing '__yo_t_6214725344943446224' (aka 'struct __yo_t_6214725344943446224_struct') to parameter of incompatible type '__yo_t_6214725344943446224 *' (aka 'struct __yo_t_6214725344943446224_struct *'); take the address with &
  984 |   return yo_id_7857630652130810617000000(box->_u42_, arg1);
```

## Root cause

A projection passes its `&T` parameters by pointer and returns its result by pointer (decision 34, `fn_abi_param_is_ptr`; the result is the place). The `Dyn` vtable slot (`_dyn_vtable_method_line`, `src/codegen/types/generation.yo`) and the per-impl wrapper (`src/codegen/functions/dyn.yo`) spelled each parameter with `dyn_slot_param_type_string`, which only gives `&mut T` a pointer, and the result as its pointee type. The wrapper then handed the impl its payload by value, with `arg1` and the return value at the wrong C types. The call site (`src/codegen/exprs/other_fn_call.yo`, the `Dyn` method dispatch) had the same gap: its pointer flags (`dyn_vtable_slot_param_is_ref`) covered only `&mut T`, so `&o` was passed as a value, and it stored the returned pointer in a `T` temp.

## Fix

Two helpers in `src/codegen/utils/index.yo`, `dyn_slot_param_abi_string` and `dyn_slot_result_abi_string`, spell a slot's parameter and result by the method type's C ABI (`fn_abi_param_is_ptr`, `fn_result_is_ref`). The vtable slot, the wrapper's parameter list, its argument and return casts use them, and the wrapper passes the payload by address when the impl's `self` is a pointer parameter. At the call site `dyn_vtable_slot_param_is_ref` flags a projection's `&T` parameters too (`fn_param_is_ptr_borrow`), and a projection slot's call is the place `(*slot(...))` (`dyn_vtable_slot_result_is_ref`), as a direct projection call is. A non-projection method's slot is unchanged (its ABI strings are the old ones), so the emitted C of every other `Dyn` is byte-identical.

Test: `tests/borrow_spelling.test.yo`, "a Dyn over a trait with an elided-origin projection method".
