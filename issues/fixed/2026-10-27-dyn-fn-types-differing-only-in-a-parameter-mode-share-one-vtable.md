# Two `Dyn(Fn(...))` types that differ only in a parameter's mode share one C vtable

**Severity:** S2 — a program that boxes a `Fn(x : &mut i32) -> unit` and a `Fn(x : i32) -> unit` behind `Dyn` fails the C compile (incompatible function pointer types), because both trait objects get one vtable struct.

**Status:** fixed on branch `fix/dyn-fn-mode-vtable` (2026-10-29). Found 2026-10-27 by the adversarial
review of decision 43 step 1 (`vbd/d43-step1-reference-type`). The bug predated that branch: the v0.2.70
seed, develop 476cfb700 and the branch failed the same way. That branch did not fix it, because its gate
was byte-identical emitted C, and the fix changes C type names.

## Evidence

Reproducer: `issues/repros/2026-10-27-dyn-fn-mode-only-difference-shares-a-vtable.yo`.

```
yo compile issues/repros/2026-10-27-dyn-fn-mode-only-difference-shares-a-vtable.yo -o a.out
a.out.c:1038:11: error: incompatible function pointer types initializing 'void (*)(void *, int32_t *)' with an expression of type 'void (void *, int32_t)'
a.out.c:2169:44: error: incompatible integer to pointer conversion passing 'int32_t' to parameter of type 'int32_t *'
```

## Root cause

A `Dyn`'s C vtable type is keyed by `type_key`, which falls back to `type_to_string` for a
trait object. `type_to_string`'s `FnTraitT` arm (`src/types/string.yo`, the `call_param_types`
loop) prints each parameter's pointee only:

- `Fn(x : &mut i32) -> unit` prints as `Fn(i32) -> unit`.
- `Fn(x : i32) -> unit` also prints as `Fn(i32) -> unit`.

The two types then share one `type_key` and one vtable struct. Each slot's C signature, however,
does follow the mode (`int32_t*` vs `int32_t`, `dyn_slot_param_type_string`).

`closure_signature_key` (`src/evaluator/utils/closure.yo`) has the same blind spot: it keys a
closure's capture struct by the `type_key` of each parameter's pointee. Two mints that differ only
in a parameter's mode would therefore share a capture struct.

Before decision 43 step 1 the mode lived in `call_param_is_ref`, which the printer never read.
After step 1 it lives in the slot (`Reference(T, true, _)`), and the printer strips it with
`t_slot_pointee`. Behaviour is identical on both sides.

## Fix direction

Print the mode in the `FnTraitT` key, the way the `Func` arm does with `format_param_with_mode`.
Do the same in `closure_signature_key`, for example by keying the slot instead of its pointee.
Both change emitted C names, so the fix ships as its own PR with an expected emit-diff rather
than inside a no-C-change refactor. The reproducer becomes a `tests/` case that compiles and runs.

## Fix

- `type_to_string`'s `FnTraitT` arm prints each slot whole, through the `Reference` arm: `&mut T`,
  `&T`, or bare `T` by value. That arm prints no origin, so origins stay out of every key (decision 43
  step 1's rule). `Fn(x : &mut i32) -> unit` now prints and keys as `Fn(&mut i32) -> unit`, and a
  `Fn` type whose slots are all by value prints exactly as before.
- `closure_signature_key` prefixes each parameter's `type_key` with its mode (`&mut `, `&`, nothing
  by value).

The second half is a real bug, not a hypothetical one. One closure literal in a generic body, boxed
with `dyn(...)` at a `Dyn(Fn(x : &mut i32) -> unit)` slot in one instantiation and at a
`Dyn(Fn(x : i32) -> unit)` slot in another, gets one capture struct for both mints. The `Dyn`
boxing then resolves both vtable instances to the same closure function through
`impl_closure_call_map` (`src/codegen/functions/dyn.yo`). A probe build that keyed the vtable but
not the capture struct still failed that program in the C compiler (`passing 'int32_t *' to
parameter of type 'int32_t'`).

## Test

`tests/dyn.test.yo`: "Dyn(Fn(...)) types differing only in a parameter mode get their own vtables"
(the reproducer, plus a `&` slot) and "one closure literal boxed at a &mut slot and at a by-value
slot" (the capture-struct half). Both fail to C-compile on develop d25241bdf and pass with the fix.
