# An `inout` parameter of a `Dyn` vtable slot is spelled by value: slot, wrapper and call site disagree on pointer level

**Severity:** S2 — a `Dyn(Fn(...))` or `Dyn(Trait)` whose call signature has an `inout(...)` parameter fails to compile in clang (valid program rejected), and it blocked a `Dyn(Fn)` callback with an `inout` collection parameter in the compiler's own self-compile.
**Status:** FIXED 2026-10-04.

## Symptom

```rust
{ println } :: import("std/fmt");
Holder :: struct(cb : Dyn(Fn(inout(n) : i32) -> unit));
main :: (fn() -> unit)({
  h := Holder(cb : dyn((inout(n)) => {
    n = (n + i32(1));
  }));
  (x : i32) = i32(41);
  h.cb(x);
  println(x);
});
export(main);
```

`yo check` passes; `yo compile` (seed v0.2.50 and a develop-built compiler) fails in clang:

```
error: incompatible integer to pointer conversion passing 'int32_t' (aka 'int') to parameter of type 'int32_t *' (aka 'int *'); take the address with & [-Wint-conversion]
 1170 |   return closure_yo_id_12558307967229682859000001((void*)&box->_u42_, arg1);
error: incompatible pointer to integer conversion passing 'int32_t *' (aka 'int *') to parameter of type 'int32_t' (aka 'int'); dereference with * [-Wint-conversion]
 2358 |   (__yo_v_h.__yo_v_cb).vtable->call((__yo_v_h.__yo_v_cb).data, (&(__yo_v_x)));
```

With a collection parameter (`Dyn(Fn(inout(xs) : ArrayList(i32)) -> unit)`) the
same two errors come out one pointer level up: the wrapper passes `T*` where the
closure takes `T**`, and the call site passes `T**` where the slot takes `T*`.

A `Dyn(Trait)` method with an `inout` parameter after `self`
(`bump : (fn(self : Self, inout(n) : i32) -> unit)`) had the same slot and
wrapper defect, and its call site (`d.bump(x)`) passed `x` BY VALUE, so the
wrapper handed an `int32_t` to the impl's `int32_t*`.

`Impl(Fn(inout(n) : i32) -> unit)` and plain fns were correct throughout.

## Root cause

A Dyn's vtable slot, and the wrapper the slot points at, were typed from the
parameter TYPES alone; the per-parameter `inout` flags (`FnTraitT.call_param_is_ref`
for the Fn `call` slot, the trait method's `param_is_ref` for a trait slot) were
never consulted:

- `src/codegen/types/generation.yo` `generate_dyn_declaration` (the Fn `call`
  member) and `_dyn_vtable_method_line` (a trait method member) rendered each
  parameter with `get_type_string(t)`;
- `src/codegen/functions/dyn.yo` `_wrapper_params` did the same for the
  wrapper's signature (and the trait wrapper's impl-vs-slot cast comparison).

Everything around them honours the flag: the closure / impl prototype
(`functions/declarations.yo`) spells an `inout` parameter `T*`, and the Dyn(Fn)
call site goes through the general call path, whose `_apply_ref_amp` takes the
address of the place (or forwards an `inout` parameter's pointer unchanged). The
Dyn TRAIT-method call site (`src/codegen/exprs/other_fn_call.yo`, the
`dm_has_slot` branch) deliberately did not amp ("A slot's own `inout`
parameters are not amped here").

## Fix

- `dyn_slot_param_type_string` (`src/codegen/utils/index.yo`): one spelling of a
  slot parameter, `T*` for an `inout` one, used by both vtable member builders
  and by `_wrapper_params` (which now takes the flags) for both the Fn `call`
  wrapper and trait-method wrappers.
- `dyn_vtable_slot_param_is_ref` (`src/types/utils.yo`): the slot's `inout`
  flags, indexed like the method call's runtime arguments. The Dyn
  trait-method call site materializes each explicit argument with its flag and
  runs them through `_apply_ref_amp`, as the registered-call path does.

## Test

`tests/dyn.test.yo`:

- "Dyn(Fn) with an inout parameter writes through to the caller's place" — a
  local `i32`, an `inout` parameter forwarded to a `Dyn(Fn)` field and to a
  `Dyn(Fn)` parameter, and a local `ArrayList(i32)` pushed through the callback
  directly and forwarded through an `inout` parameter.
- "Dyn(trait) method with an inout parameter writes through to the caller's
  place" — a local `i32` and a forwarded `inout` parameter through a
  `Dyn(Trait)` method slot.
