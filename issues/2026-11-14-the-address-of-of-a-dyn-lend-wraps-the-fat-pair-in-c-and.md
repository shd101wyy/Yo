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

## Root cause (found 2026-11-14 21:00)

Under decision 49 a `&Dyn(T)`/`&mut Dyn(T)` VALUE is the fat pair itself.
`generate_address_of` (`src/codegen/exprs/ptr_fns.yo`) still treated every
operand as an addressable place:

- a `dyn(&v)` lend (or any `&Dyn` expression) whose address-of is spelled by
  a `&Dyn` binding or an `Option(&Dyn)` payload emitted `&(( fat ))` — a
  pointer to a compound literal, assigned/cast where the pair BY VALUE is
  expected;
- the flip's dyn-cell IDENTITY places (`h.*` over a handle, `cell.*` —
  property_access returns `(storage)`) fell past the existing `(*F)`-strip
  arm (they start `((`, not `(*`), so `&h.*` and `Rc._payload_mut`'s
  `addr_of(self._cell.*)` kept the wrap.

## Fix (commit e297c8f73)

Two arms beside the slice strip: a reference to an UNSIZED pointee returns
the operand's code as-is (it already IS the pair); an unsized place in the
identity form `(storage)` strips the one paren layer.

## Test

`tmp/p/p6b.yo` (`_speak_via(&h.*)`, `Rc.get_mut`), `tmp/p/p6c.yo` (the named
`&Dyn` local, `_ret_mut`, `_opt_ret`), and the flipped rows of
`tests/dyn_pointer_kinds.test.yo`.
