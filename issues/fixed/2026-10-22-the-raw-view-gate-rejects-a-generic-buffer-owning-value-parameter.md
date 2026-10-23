# The raw-view gate rejects a generic buffer-owning value parameter

**Severity:** S2 — in a safe file, a generic function's parameter of a
buffer-owning value type at a type variable (`b : &Buf(T)`) is rejected as
"raw-pointer-carrying", while the same type at a concrete argument
(`Buf(i32)`) is accepted. Once V2b B8 makes `ArrayList` a value, every safe
generic signature over `ArrayList(T)` hits this, starting with `std/rand.yo`'s
`shuffle`.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). The v0.2.68 seed and
develop `e30c0d8ed` both reject it, with develop's std and with the flipped
std. Under the flip, CI's stage 1 is the seed checking the flipped std and
`src/`, so the seed rejects every safe file with such a signature.

## Reproducer

`issues/repros/2026-10-22-the-raw-view-gate-rejects-a-generic-buffer-owning-value-parameter/`:
`buf.yo` (`pragma(Pragma.AllowUnsafe)`) declares
`Buf(T) :: struct(_ptr : ?*T, _len : usize)` with a `Drop` impl.
`main.yo` (safe) declares:

```yo ignore
count :: (fn(generic(T : Type), b : &Buf(T)) -> usize)(b.len());
count_i32 :: (fn(b : &Buf(i32)) -> usize)(b.len());
```

```text
error: Raw-pointer-carrying types ('Buf(T)') are not available in safe code.
  --> main.yo:9:35
```

Without `count`, the program compiles and prints `0`. With the B8 flip, the
same error names `ArrayList(T)` at `std/rand.yo:178`
(`shuffle : (fn(generic(T : Type), self : &Self, xs : &mut ArrayList(T)) -> unit)`).

## Root cause (hypothesis)

`_type_repr_contains_raw_ptr` (`src/types/utils.yo`) exempts a value that
owns its buffer outright (`value_type_owns_buffer_outright`): a `?*E` field
and a `Drop` of its own. The `Drop` half asks
`_nominal_declares_move_only`, which consults the trait registry for the
instantiation. At a type variable (`Buf(T)` inside a generic signature), the
generic `impl(generic(T), Buf(T), Drop(...))` is not found, so the
exemption fails, and the walk falls through to the struct's fields, where
`_ptr : ?*T` is a raw pointer.

## Fix direction

Decide the exemption on the nominal type's declaration (the generic struct id
carries the `Drop` impl whatever `T` is), or defer the gate to the
instantiation, as the rest of a generic signature is judged. The regression
test is the two-file repro, which should print `0` twice, plus a
`std/rand.yo`-shaped `ArrayList(T)` signature once B8 lands.

## Why it matters for the release plan

CI's stage 1 compiles the tree's `src/` against the tree's `std/` with the
seed. If B8 lands before a seed carries this fix, every safe std or src file
with a generic `ArrayList(T)` or `String`-holding generic signature needs
`pragma(Pragma.AllowUnsafe)` as a workaround. The probe did that for
`std/rand.yo`. (`std/async/channel.yo` also needed the pragma, but for a
different reason: its `ArrayList(Waker)` really does carry `Waker._p : *u8`,
which the `ref` list used to hide.)
