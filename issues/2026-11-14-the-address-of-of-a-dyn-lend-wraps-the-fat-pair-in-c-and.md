# The address-of of a `&Dyn` wraps the fat pair in C `&` (and the dyn-cell identity place keeps a paren too many)

**Severity:** S1 (blocks the flipped `&h.*` dispatch row, `Rc.get_mut` on
`Rc(Dyn)`, and `(d : &Dyn) = dyn(&c)` / `Option(&Dyn)` payloads — the
`dyn_pointer_kinds` rows 1-5 and `dyn`/`error` rows)

**Date:** 2026-11-14

## Verbatim error

```text
tmp/p/p6b.c:2577:85: error: used type '__yo_t_10496396222587666537' where arithmetic or pointer type is required
tmp/p/p6c.c:2444:31: error: initializing '__yo_t_11132070332284571586' with an expression of incompatible type '__yo_t_11132070332284571586 *'; dereference with *
```

## Reproducer (minimized)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
_via :: (fn(d : &Dyn(Speak)) -> i32)(d.speak());
main :: (fn() -> unit)({
  (h : Rc(Dyn(Speak))) = dyn(Rc.new(Cat(n : i32(4))));
  _via(&h.*);            // p6b: (&(( fat ))) cast to the pair by value
  c := Cat(n : i32(6));
  (d : &Dyn(Speak)) = dyn(&c);  // p6c: pair_t d = (&(( fat )));
});
export(main);
```

## Root cause (found 2026-11-14 21:00-22:10; three sites, one class)

Under decision 49 a `&Dyn(T)`/`&mut Dyn(T)` VALUE is the fat pair itself.
Three emitters still treated a reference-typed operand as a PLACE to address:

1. `_apply_ref_amp`'s N2b arm (`src/codegen/exprs/other_fn_call.yo`): a
   by-value parameter whose argument's converted runtime type is a Reference
   got `pref = true` ("the argument is the place") — `_speak_via(&h.*)`
   passed `(&(h))` where the `&Dyn` parameter takes the pair.
2. The enum-ctor payload arm (same file, `f_takes_addr`): a borrow payload
   addressed its argument — `Option(&Dyn).Some(x)` stored `&(pair)` in the
   payload slot.
3. `_reference_value_rhs` (`src/codegen/exprs/assignment.yo`): a reference
   RHS wrapped `&(code)` — `(d : &Dyn) = dyn(&c)` declared the pair-typed
   local with a pointer initializer.

(`generate_address_of` in ptr_fns.yo gained the matching arms for the same
class — a reference to an unsized pointee returns the operand's code; the
dyn-cell identity place strips its paren layer — commit e297c8f73, which
alone did NOT reach these three sites.)

## Fix (commits e297c8f73 + b120032b1)

All reference-to-UNSIZED-pointee cases keep the operand's code: no amp, no
payload address, no assignment wrap.

## Test

`tmp/p/p6b.yo` (`_speak_via(&h.*)`, `Rc.get_mut`), `tmp/p/p6c.yo` (the named
`&Dyn` local, `_ret_mut`, `_opt_ret`), and the flipped rows of
`tests/dyn_pointer_kinds.test.yo`.
