# A unit-returning `Dyn(FnOnce(...))` call slot declares a `void` temp

**Severity:** S2 — a valid `Dyn(FnOnce(...) -> unit)` built from a closure or a named `fn` passes `check` and dies in the C compiler; `-> unit` is the common callback shape.

**Status:** FIXED 2026-10-14 (stacked on #1339, decision 44).
**Found:** 2026-10-14, reviewing the `dyn(named_fn)` fix
(`issues/fixed/dyn-of-a-named-function-value-emits-invalid-c.md`), whose
code-pointer branch copied the closure branch's `FnOnce` epilogue. The closure
branch predates it.

## Repro

```yo
{ println } :: import("std/fmt");
say :: (fn() -> unit)({
  println("said");
});
bump :: (fn(x : &mut i32) -> unit)({
  x = (x + i32(1));
});
main :: (fn() -> unit)({
  (a : Dyn(FnOnce() -> unit)) = dyn(say);
  a();
  (c : Dyn(FnOnce(x : &mut i32) -> unit)) = dyn(bump);
  (x : i32) = i32(1);
  c(&mut x);
  (w : Dyn(FnOnce() -> unit)) = dyn(() => say());
  w();
});
export(main);
```

`yo check` passes; `yo compile` fails in the C compiler:

```
error: variable has incomplete type 'void'
  void __yo_once_r = ((void (*)())box->_u42_)();
error: variable has incomplete type 'void'
  void __yo_once_r = ((void (*)(int32_t* __yo_v_x))box->_u42_)(arg1);
error: variable has incomplete type 'void'
  void __yo_once_r = closure_yo_id_...((void*)&box->_u42_);
```

## Root cause

`generate_dyn_wrapper_functions` (`src/codegen/functions/dyn.yo`) emits the
`Fn`-trait `call` slot of each `Dyn` impl. A `Dyn(FnOnce(...))` call consumes
the `Dyn`, so the slot keeps the result in `__yo_once_r`, releases the box and
returns the temp. It decided whether there is a result with
`is_void_type(&call_result)`, which is false for `unit`, though `unit` lowers
to C `void` (the slot's own return type, `return_str`). The zeroed stub at the
end of the same function already special-cased `return_str == "void"`; the
closure branch and the code-pointer branch did not.

## Fix

`is_void` is `is_void_type(&call_result) || (return_str == "void")`, so every
branch of the slot (closure capture struct, code pointer, fat pointer, stub)
calls a unit-returning payload as a statement and keeps no result.

Test: `tests/dyn.test.yo` "a unit-returning Dyn(FnOnce) of a named fn and of a
closure" (a no-argument named `fn`, a `&mut` named `fn`, a `&mut` closure
literal and a no-argument closure, each called once through a
`Dyn(FnOnce(...) -> unit)`). Before the fix its batch failed to compile with
the four errors above.
