# A reference field cannot be re-pointed, and the diagnostics say read or write through

**Severity:** S2 — a sound store of a reference into a holder's reference field (`h.r = &y` with `y` outliving `h`) is rejected, and both diagnostics describe a different operation: E0926 calls the store a read of the referent, E0908 calls a lend of the field a write through it.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probes:
`probes/holders/f01_field_write_elided.yo` … `f09`, `probes/generics/r02-rigid-holder-field.yo`,
`probes/holders/f07_write_through_mut_field.yo` and the re-probe's `e_*` A28 edges. Reproduced with a stage 1 of
develop `f06ff5889`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("abc"))));
H :: struct(r : &Rc(X), n : i32);
main :: (fn() -> unit)({
  z := mk();
  y := mk();
  mut(h) := H(r : &z, n : i32(0));
  h.r = &y;
  println(`OUT: ${h.r.*.*.s.len().to_string()}`);
  ()
});
export(main);
```

```text
error[E0926]: `h.r` is a reference (`&Rc(X)`): reading the value it refers to is spelled `h.r.*`
10 |   h.r = &y;
```

`p := &mut h.r;` (a `&mut` to the field, to re-point it through `p.* = &y`) is E0908: "Cannot write through `h.r`:
it is a `&` reference field, a read-only borrow of the place it refers to". A local borrow re-points
(`r = &place`, decision 25) and a whole-holder store re-points (`h = H(r : &y, n : h.n)`, accepted and checked:
E0911/E0923 when `y` dies first), so only the field form is missing.

## Root cause

The E0926 rule treats every bare reference-typed place on the left of `=` other than a local borrow binding as a
whole-value write of the referent, and the `&mut` lend of a `&T` field is checked as a write through the reference.
Neither path has a re-point arm for a field.

## Design question

Should a reference field be re-pointable in place (`h.r = &y`, `set(&mut h.r, &y)`), checked like a whole-holder
store (E0923 against the holder's declared origin, E0911 against `y`'s scope)?

## Recommendation

Admit it: the whole-holder store already runs the same checks, so the field form adds no unchecked path, and it
spells at the use site what the whole-holder rewrite hides (explicit over implicit). Until then, word the diagnostics for what the code does (a re-point of a
reference field is not admitted; write the whole holder).
