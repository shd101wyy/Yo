# A method called through a `&Dyn(Trait)` local ignores its vtable slot's reference flags

**Severity:** S1 — safe code passes `yo check` and the emitted C is wrong: called through a local `d : &Dyn(T)`, a
method's `&mut i32` argument is passed by value (the callee writes through the integer as a pointer: SEGV), and a
`-> &i32` result is stored as an `i32` (the program prints the pointer's bits). A struct-typed reference result
(`-> &String`, `-> &Rc(X)`) fails the C compile instead.

Filed 2026-11-24 by the test 7 rehearsal lane (`plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6, leg (b)),
while attributing the C compile failure of `probes/cells/tip/dv06_dyn_ref_generic_id.yo` in
`scripts/test7/audit-corpus.tar.gz`. Pre-existing: the reproducer below segfaults the same way on stage 1 binaries of `4cdc10d31` and `5768498fd`, and
the `-> &i32` shape prints the same wrong value on `4cdc10d31` and `8c2424568`.

## Reproducer

`issues/repros/2026-11-24-a-method-called-through-a-dyn-reference-local-ignores-its-vtable-slots-reference-flags.yo`:

```yo
{ println } :: import("std/fmt");
Bump :: trait(bump : (fn(self : &Self, x : &mut i32) -> unit));
Cat :: struct(n : i32);
impl(
  Cat,
  Bump(
    bump : (fn(self : &Self, x : &mut i32) -> unit)({
      x.* = (x.* + self.n);
    })
  )
);
main :: (fn() -> unit)({
  c := Cat(n : i32(3));
  (d : &Dyn(Bump)) = dyn(&c);
  mut(k) := i32(10);
  d.bump(&mut k);
  println(`OUT: ${k.to_string()}`);
});
export(main);
```

```bash
yo check repro.yo --std-path ./std        # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
```

```text
dv9.bin.c:2472:51: warning: incompatible integer to pointer conversion passing 'int32_t' (aka 'int') to parameter of type 'int32_t *' (aka 'int *'); take the address with & [-Wint-conversion]
==738748==ERROR: AddressSanitizer: SEGV on unknown address 0x00000000000a (pc 0x5555556ccb0c bp 0x7bfff3ffed70 sp 0x7bfff3ffeca0 T1)
SUMMARY: AddressSanitizer: SEGV (.../t+0x178b0c)
```

The emitted call passes `k`'s value where the slot takes its address:

```c
(__yo_v_d).vtable->__yo_v_bump((__yo_v_d).data, __yo_v_k);   /* should be &(__yo_v_k) */
```

| Shape (develop `964a9c2d6`) | Result |
| --- | --- |
| `(d : &Dyn(Bump)) = dyn(&c); d.bump(&mut k)` (`x : &mut i32` slot) | SEGV: `k`'s value used as the pointer |
| `(x : &Dyn(Name)) = dyn(&c); n := x.get(); n.*` (`-> &i32` slot) | prints the pointer's low bits, not `3` (`int32_t n = vtable->get(...)`, a `-Wint-conversion` warning) |
| `x.get().*` on the same local | same wrong value |
| `-> &String` or `-> &Rc(X)` slot through the local | C compile error (struct from a pointer, incompatible pointer types) |
| `fn(d : &Dyn(Name)) -> i32 (d.get().*)`: the receiver is a `&Dyn` PARAMETER | right (`3`) |

## Root cause

The Dyn dispatch in `src/codegen/exprs/other-fn-call.yo` (the `dm_has_slot` branch) finds the receiver's Dyn type
with `dyn_dispatch_receiver_type`, which unwraps one reference level because "a `&Dyn` LOCAL records its type as the
reference; a `&Dyn` parameter records the pointee". The two slot-shape lookups that follow do not use that unwrapped
type: they pass the receiver's raw `rvi.ty()`:

- `dm_slot_pir := … dyn_vtable_slot_param_is_ref(&rvi.ty(), <method>)` (the per-parameter pointer flags), and
- `dyn_vtable_slot_result_is_ref(&rvi.ty(), <method>)` (the projection result that is emitted as `(*call)`).

Both (`src/types/utils.yo`) match only `Rc(.DynT(...))`, so for a `&Dyn` local, whose type is the `Reference`, they
return "no pointer parameters" and "not a reference result". The arguments then go by value, and the result is
declared at the call's ExprInfo type (the pointee) and initialized from the pointer the slot returns. For a
parameter receiver, `rvi.ty()` is already the `DynT` and both lookups are right.

## Expected

All three print the right value (`OUT: 13`, `OUT: 3`, the string's length). Pass `dm_recv_dyn_ty` (the unwrapped Dyn)
to both lookups.

## Test

The three shapes on a `&Dyn` local (a `&mut` argument, a `-> &i32` result read through `.*`, a `-> &String` result's
`.len()`) as a case in `tests/dyn.test.yo`, which fails today (SEGV, a wrong
value, a C compile error) and passes with the fix; `probes/cells/tip/dv06_dyn_ref_generic_id.yo` then compiles.

## Fixed

Fixed 2026-11-24 on branch `v0280/s1-dyn-ref-local` (`src/codegen/exprs/other-fn-call.yo`, the `dm_has_slot` branch):

- Both slot lookups take `dm_recv_dyn_ty`, the Dyn `dyn_dispatch_receiver_type` unwrapped, so a `&Dyn` local, a
  `&mut Dyn` local and `dd.*` over a `dd : &(&Dyn(T))` read the slot's own flags: a `&mut` argument (and a
  projection's `&` argument) passes its place's address, and a `-> &T` / `-> &mut T` result is the place `(*slot(...))`.
- The receiver's fat pointer is read by type (`_dyn_receiver_fat_code`): a receiver typed as the Dyn is a place
  `(*F)` and folds to `F`; a receiver typed as a reference to the Dyn is `F` already. The old textual fold turned
  `dd.*`'s `(*dd)` into the pointer `dd` and dispatched through it (a C compile error).
- An unsized projection result (`-> &[T]`, `-> &Dyn(U)`) is the fat pair, as on the direct-call path, held in the
  call's temp when it has one. Through a `&Dyn` local such a result had been declared at its pointee type
  (`Slice(i32) t = ...`, "Unknown type"); through a `&Dyn` parameter a `-> &Dyn(U)` result used as a receiver was
  called twice (`(slot(...)).vtable->m((slot(...)).data)`).

Siblings, each a row of `tests/dyn.test.yo` run under ASan, against the develop `ea49fbb42` binary (before) and the
fixed one (after):

| Row | Before | After |
| --- | --- | --- |
| `&Dyn` local: `&mut` and projection `&` arguments, `-> &i32` bound and in place, `-> &String`, `-> &[i32]`, by value | C compile error | pass |
| `&mut Dyn` local: `&mut` arguments, `-> &mut i32` written through, `-> &i32`, `-> &String` | C compile error | pass |
| `Box(Dyn)` through `&` (`rb.*.*.m(...)`) | pass (the receiver is the Dyn place) | pass |
| `&&Dyn` local (`dd.*.m(...)`) and parameter | C compile error | pass |

`probes/cells/tip/dv06_dyn_ref_generic_id.yo` now compiles and prints `OUT: 72` ASan-clean.

A neighbour outside the slot path stays open:
`issues/2026-11-24-a-reference-to-a-dyn-reference-binding-passed-to-a-reference-to-reference-parameter-passes-the-pair.md`
(`f(&d)` at `f : fn(dd : &(&Dyn(T)))` passes `d`'s pair instead of its address; the test row spells `&dd.*`).
