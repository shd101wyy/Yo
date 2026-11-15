# The legacy `__yo_dyn_clone` wrapper emits invalid C for a value payload

**Severity:** S2 (found by the d49 flip's own probes on `vbd/d49-flip`; every program with a `Dyn(..., Clone)` over a value payload failed the C compile)

**Date:** 2026-11-14

## Verbatim error

```text
/tmp/p3bin.c:1183:47: error: used type '__yo_t_3383016603061586106' (aka 'struct __yo_t_3383016603061586106_struct') where arithmetic or pointer type is required
```

## Reproducer (`tmp/fixme.yo`)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
derive(Cat, Clone);
main :: (fn() -> unit)({
  (c : Box(Dyn(Speak, Clone))) = dyn(Box.new(Cat(n : i32(4))));
  d := Box.clone(c);
});
export(main);
```

## Root cause

`_emit_dyn_clone_function` (`src/codegen/functions/dyn.yo`) wrote the wrapper
for a `Dyn` that lists `Clone` by casting `self_ptr` straight to the CONCRETE
type — `__yo_t_Cat concrete_value = (__yo_t_Cat)self_ptr;` — valid only for a
reference-struct payload. Under decision 49's payload convention a VALUE
payload lives AT the data word, so the cast is `struct`-from-`void*`, which is
not C at all.

## Fix

The non-boxed branch distinguishes the two payload kinds
(`is_reference_struct_type`): a reference payload keeps the old cast; a value
payload reads its receiver through `(__yo_t_Cat*)self_ptr` (per the clone's
`self` ABI) and lands the clone in fresh `__yo_malloc` storage, which the slot
hands back.

## Test

`tests/dyn.test.yo`: "Box(Dyn(T, Clone)).clone() is the box's clone" — the
program does not compile (C error) before the fix and runs after. The row
counts one clone through the vtable's `clone_into`.
