# A reference `upcast` and an owned `upcast` to one `Dyn` in one program crash at run time

**Severity:** S1 — a valid program that upcasts a `dyn(&v)` and an owned `Dyn` to the same target reads a NULL
vtable pointer and dies with SIGSEGV; `yo check` and the C compiler accept it.

Found 2026-11-11 by the d49s1fg lane (decision 49 S1g) while probing the `DYN_DESIGN.md` examples on develop
`f784ff74f` (S1d, #1890, merged).

## Reproducer

`issues/repros/2026-11-11-a-reference-upcast-and-an-owned-upcast-to-one-dyn-in-one-program-crash.yo`:

```yo ignore
speak_via :: (fn(d : &Dyn(Speak)) -> i32)(d.speak());
main :: (fn() -> unit)({
  c := Cat(n : i32(1));
  a := speak_via(upcast(dyn(&c), Dyn(Speak))); // a reference upcast
  (b : Dyn(Speak, Run)) = dyn(Cat(n : i32(2)));
  (s : Dyn(Speak)) = upcast(b, Dyn(Speak)); // an owned upcast, same target
  y := s.speak();
});
```

`yo compile --allocator system --sanitize address` and running it:

```text
==783520==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000048
```

Each half alone runs correctly (prints `1`, and `2` with `Box(Dyn(Speak, Run))` and `upcast(b, Dyn(Speak))`).

The reference upcast is not needed: an owned upcast to `Dyn(Speak)` beside any `dyn(&v) : &Dyn(Speak)` of the
same payload type (`speak_via(dyn(&c))`) crashes the same way. So do the reversed order, a reference and an owned
upcast from one source `Dyn(Speak, Run)`, two targets of one source, and a chain
`Dyn(Speak, Run, Jump)` → `Dyn(Speak, Run)` → `Dyn(Speak)`.

## Root cause

The dyn impls are registered twice: by the collection pass, under id keys `<concrete>_<dyn>`, and at each
`dyn(...)` site during body generation, under C-name keys that carry the payload convention (`_P` for a
`dyn(&v)` instance, whose data word is the payload's address; `_A` for a legacy instance over an `Arc(V)` cell).
`register_dyn_upcast_targets` runs between the two, on the collection pass's map, and adds one (concrete, target)
entry per (concrete, source) entry that the program upcasts. Neither the collection keys nor the upcast-target
key carried the convention, so:

- the `_P` instance `Cat`/`Dyn(Speak)` of `dyn(&c)` and the legacy target instance `Cat`/`Dyn(Speak)` that the
  owned upcast needs share the key `Cat_Dyn(Speak)`. The target entry was not added because the key was taken,
  and `generate_dyn_vtables`, which looks for a target instance of the SOURCE's convention, found none: the legacy
  `Dyn(Speak, Run)` vtable over `Cat` declares `__yo_up_<Speak>` but its initializer omits it (NULL);
- a `dyn(&c) : &Dyn(Speak, Run)` and an owned `Dyn(Speak, Run)` of `Cat` collide the same way one level up: the
  collection pass keeps one of the two source instances, the other is re-registered only during body generation,
  after the upcast targets were computed, so its target instance is never registered.

## Fix

`dyn_impl_key_suffix(payload_convention, data_type)` (`src/codegen/utils/index.yo`) is the one convention suffix
(`_P`, `_A`, or empty). Every key of a dyn impl goes through it: the collection pass's two registrations
(`src/codegen/functions/collection.yo`), the upcast target key and `fixup_dyn_impl_keys`'s re-key
(`src/codegen/utils/fixup.yo`), and the two `dyn(...)` sites (`src/codegen/exprs/dyn.yo`). The instances of one
(concrete, Dyn) pair in two conventions are two entries from the collection pass on, each source instance gets its
target instances in its own convention, and `generate_dyn_vtables` (`src/codegen/functions/dyn.yo`) points
`__yo_up_<Tgt>` at the target instance with the same suffix.

The same keying also fixes a quieter case the emitted C shows: an owned `Dyn(Speak, Run, Send, Sync)` (its cell is
an `Arc(Cat)`) and an owned `Dyn(Speak, Run)` (an `Rc(Cat)` cell), both upcast to `Dyn(Speak)`, shared one target
vtable with the non-atomic `__yo_incr_rc` / `__yo_decr_rc`, so the upcast of the `Arc` cell counted it
non-atomically. Each now has its own target vtable (`_A` with the atomic pair). The program ran correctly
single-threaded before and after, so no run row catches it. The fixup's re-key no longer drops `_A` either, so an
`Arc` payload's collection-pass entry and its `dyn(...)` site's entry are one vtable, not two identical ones.

Test: `tests/dyn_pointer_kinds.test.yo`, the six rows after the comment citing this doc: the reproducer, the reverse
order, one source Dyn upcast by reference and owned, two targets of one source, a chain, and an owned upcast
beside a plain `dyn(&v)`. Each row upcasts its own payload type, so no other row's vtables hide its own. With a
binary built before the fix all six fail (the test process dies on the NULL slot), and the six standalone programs
crash under ASan; with the fix the file passes 28/28 and the programs print the expected values.
