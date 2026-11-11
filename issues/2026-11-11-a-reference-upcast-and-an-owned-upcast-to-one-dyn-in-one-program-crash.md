# A reference `upcast` and an owned `upcast` to one `Dyn` in one program crash at run time

**Severity:** S1 — a valid program that upcasts a `dyn(&v)` and an owned `Dyn` to the same target reads a NULL
vtable pointer and dies with SIGSEGV; `yo check` and the C compiler accept it.

Found 2026-11-11 by the d49s1fg lane (decision 49 S1g) while probing the `DYN_DESIGN.md` examples on develop
`f784ff74f` (S1d, #1890, merged). Not fixed in the S1g PR.

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

## Root cause (read from the emitted C)

The per-source upcast table (`src/codegen/utils/index.yo`, "`upcast(d, Dyn(Tgt))` targets per SOURCE Dyn") does
not keep the two payload conventions apart. With both upcasts in the program:

- the legacy `Dyn(Speak, Run)` vtable over `Cat` declares the `__yo_up_<Speak>` slot but its initializer omits it,
  so the owned upcast loads `vtable->__yo_up_<Speak>` == NULL and the call through it reads address `0x48`;
- the slot that is filled sits on the `_P` (payload-convention) `Dyn(Speak)` vtable and points at itself, and the
  owned `upcast` would hand a legacy box's data word to that `_P` vtable even if it were reached.

The fix keys the upcast targets by (source Dyn, convention) and emits the legacy and `_P` target vtables
separately. Test: the reproducer as a run row in `tests/dyn_pointer_kinds.test.yo` under ASan.
