# The interim `__yo_cell(Dyn)` emits a dead, ill-formed constructor and `___dispose`

**Severity:** S2 (found by the d49 flip's probes on `vbd/d49-flip`; every program combining an `Rc(Dyn(...))`/`Arc(Dyn(...))` handle with a `CloneInto` witness call — `Box(Dyn(..., Clone))` cloning included — failed the C compile)

**Date:** 2026-11-14

## Verbatim error

```text
p8kbin.c:3605:56: error: member reference type '__yo_t_6217617163536401138' is not a pointer; did you mean to use '.'?
p8kbin.c:3605:58: error: no member named '_u42_' in '__yo_t_6217617163536401138'
p8kbin.c:3847:45: error: passing 'void *' to parameter of incompatible type '__yo_t_6217617163536401138'
```

## Reproducer (`tmp/p/p8k.yo`)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
derive(Cat, Clone);
_v12 :: (fn(generic(T : ?Sized), self : &Rc(T), src : &T, dst : *T, where(T <: CloneInto)) -> unit)({
  (T <: CloneInto).clone_into(src, dst);
  ()
});
main :: (fn() -> unit)({
  (c : Box(Dyn(Speak, Clone))) = dyn(Box.new(Cat(n : i32(4))));
  (h : Rc(Dyn(Speak, Clone))) = dyn(Rc.new(Cat(n : i32(5))));
  (mut(dst) : *Dyn(Speak, Clone)) = Box(Dyn(Speak, Clone))._payload(&c);
  _v12(&h, &dst.*, dst);
});
export(main);
```

## Root cause

The interim `__yo_cell(Dyn)` (VERDICTS-61 decision 1) remaps the cell's C name
to the PAYLOAD's — the fat pointer (`codegen/utils/index.yo`'s `get_type_string`
dyn-cell arm) — because the `Rc`/`Arc` handle IS the fat pointer and the counted
block is the legacy dyn box behind `data`. But two generic emissions still ran
for the cell's own struct (`{header; _u42_ : fat}`):

- the generic cell constructor `__yo_new_<cell>` — dead: `dyn(Rc.new(v))`
  builds the legacy counted dyn box, and no call site reaches it; and
- the synthesized field-walking `___dispose` — dead (the release goes through
  `__yo_dyn_release`), and ill-formed: its body destructures the CELL's
  `_u42_` field (`self->_u42_`) while its remapped signature types `self` as
  the fat VALUE, so the member access is not valid C. The type-tag dispatch
  then also called it with the cell pointer.

## Fix

`src/codegen/functions/constructors.yo`: `_generate_one_constructor` returns
early for `is_dyn_cell_type`. `src/codegen/functions/collection.yo`:
`collect_dispose_methods` skips `is_dyn_cell_type` in its type walk.

## Test

`tests/dyn.test.yo`'s "Box(Dyn(T, Clone)).clone() is the box's clone" row
compiles and runs only with the fix (the C failed before it); the interim-cell
release itself is asserted by the existing `dyn(Rc.new(v))` rows in
`tests/dyn.test.yo` and `tests/rc_cell.test.yo`.
