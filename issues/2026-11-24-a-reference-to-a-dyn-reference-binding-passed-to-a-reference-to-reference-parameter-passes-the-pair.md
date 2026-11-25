# `&d` of a `&Dyn` binding passed to a `&(&Dyn(T))` parameter passes the binding's fat pair, not its address

**Severity:** S2 — a program `yo check` accepts fails the C compile: the call casts the `&Dyn` fat pair to a pointer to it.

Filed 2026-11-24 by the `s1-dyn-ref-local` lane while covering the `&&Dyn` sibling of
`issues/fixed/2026-11-24-a-method-called-through-a-dyn-reference-local-ignores-its-vtable-slots-reference-flags.md`.
Pre-existing: develop `ea49fbb42`. The same shape over a sized pointee (`(r : &i32) = &x; f(&r)` at
`f : fn(rr : &(&i32))`) is right: it passes `&(r)`.

## Reproducer

`issues/repros/2026-11-24-a-reference-to-a-dyn-reference-binding-passed-to-a-reference-to-reference-parameter-passes-the-pair.yo`:

```yo
{ println } :: import("std/fmt");
Vl :: trait(val : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Vl(val : (fn(self : &Self) -> i32)(self.n)));
via :: (fn(dd : &(&Dyn(Vl))) -> i32)(dd.*.val());
main :: (fn() -> unit)({
  c := Cat(n : i32(3));
  (d : &Dyn(Vl)) = dyn(&c);
  println(`L1 via: ${via(&d).to_string()}`);
});
export(main);
```

```bash
yo check repro.yo --std-path ./std    # rc 0
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
```

```text
t.c:2478:118: error: operand of type '__yo_t_9031534213166897228' where arithmetic or pointer type is required
```

```c
yo_id_13992686022112059088000000((__yo_t_9031534213166897228*)(__yo_v_d));   /* should be &(__yo_v_d) */
```

Spelling the argument `&dd.*` over a bound `(dd : &(&Dyn(Vl))) = &d` emits the right C (`dd`); `via(dd)` is E0601 by design (a `&T` slot takes a place).

## Root cause

`_apply_ref_amp` (`src/codegen/exprs/other-fn-call.yo`) decides `fat_arg` from the ARGUMENT's type alone: an
argument typed as a reference to an unsized pointee (`t_slot_is_borrow(ty) && !type_is_sized(pointee)`, here `d :
&Dyn(Vl)`) is "the fat pair it is" and is passed as is. That is right at a `&Dyn` slot and wrong at a `&(&Dyn)`
slot, whose pointee (`&Dyn`) is sized: the argument is then a place the slot lends, and needs its address like any
sized place.

## Expected

`L1 via: 3`. `fat_arg` should hold only when the parameter's own pointee is unsized (the slot's `t_slot_pointee`), so
a `&(&Dyn)` slot takes `&(d)`.

## Test

A row in `tests/dyn.test.yo` passing `&d` to a `&(&Dyn(T))` parameter, which fails the C compile today. The
`&&Dyn` row the fix of
`issues/fixed/2026-11-24-a-method-called-through-a-dyn-reference-local-ignores-its-vtable-slots-reference-flags.md`
added (`a method through a &&Dyn reads its slot's reference flags`) spells the argument `&dd.*` and can take `&d`
once this is fixed.
