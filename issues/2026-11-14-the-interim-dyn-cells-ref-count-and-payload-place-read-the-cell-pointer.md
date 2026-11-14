# The interim dyn cell's `ref_count` and payload place read the cell pointer that no longer exists

**Severity:** S1 (blocks VERDICTS-61 decision 1: `Rc.clone`, `get_mut`,
`downgrade`/`upgrade`, `downcast(&h.*, V)` on `Rc(Dyn)`/`Arc(Dyn)` must behave
as in the final design, with the `rc`/`arc`/`dyn` test rows unchanged)

**Date:** 2026-11-14

## Verbatim error

```text
tmp/p/p6b.c:2554:74: error: operand of type '__yo_t_18026575203883451861' (aka '__yo_t_10496396222587666537') where arithmetic or pointer type is required
tmp/p/p6b.c:3294:30: error: operand of type '__yo_t_18026575203883451861' (aka '__yo_t_10496396222587666537') where arithmetic or pointer type is required
tmp/p/p6b.c:3298:195: error: indirection requires pointer operand ('__yo_t_10496396222587666537' invalid)
```

## Reproducer (`tmp/p/p6b.yo`, minimized)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
main :: (fn() -> unit)({
  (h : Rc(Dyn(Speak))) = dyn(Rc.new(Cat(n : i32(4))));
  h2 := Rc.clone(h);
  assert(ref_count(h) == usize(2), "two handles");
  match(Rc.get_mut(&mut h2), .Some(_) => assert(false, "shared"), .None => ());
});
export(main);
```

## Root cause (found 2026-11-14 19:40)

Under the flip's interim cell the `Rc(Dyn(T))` HANDLE's C value is the fat
pair `{ data, vtable }` BY VALUE (`get_type_string`'s dyn-cell arm maps the
cell's name to the payload's fat type; a newtype is zero-cost), with the
counted block hanging off `.data`. Three emitters still assumed the
pre-flip shape — the handle's C value IS the cell pointer:

1. `generate_ref_count_call` (`src/codegen/exprs/rc_fns.yo`) cast the handle
   straight: `((__yo_rc_prefix_t*)(h))->ref_count` — a struct cast (errors at
   2554 for `ref_count(h)` and 3294 for `ref_count(self)` inside `get_mut`).
2. `Rc._payload_mut` (`std/prelude.yo`, `unsafe(addr_of(self._cell.*))`) —
   the `cell.*` deref went through the `is_reference_struct_type` arm
   (`x->field`), emitting `&((*self)->_u42_)`: an arrow off the fat struct
   and a payload field the remapped type no longer has (error at 3298).
3. `h.*` on a dyn-cell handle (`property_access.yo`'s handle arm) emitted
   `(*h)` — a deref of the by-value pair.

## Fix (commit a02586cd0)

- `ref_count` reads the count through `(handle).data` when the (reference-
  stripped) argument is a dyn cell or a handle over one; the atomic (Arc)
  variant reads the same way.
- `cell.*` on a dyn cell and `h.*` on a dyn-cell handle are IDENTITY: the
  pair's storage IS the place, so `&h.*` and `_payload_mut` name the pair
  (new `is_dyn_cell_type` arm before `is_reference_struct_type`; the handle
  arm returns the parenthesized operand).

## Test

`tmp/p/p6b.yo` (now also `_speak_via(&h.*)`, `downgrade`/`upgrade`); the
Rc/Arc rows of `tests/dyn_pointer_kinds.test.yo`, `tests/rc.test.yo`,
`tests/arc.test.yo`, `tests/rc_cell.test.yo`.
