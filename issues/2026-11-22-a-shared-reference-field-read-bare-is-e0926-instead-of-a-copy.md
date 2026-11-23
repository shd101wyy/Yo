# A `&T` reference field bound bare (`a := s.r`) is E0926 instead of a copy

**Severity:** S3 — `a := s.r` with `r : &T` is rejected although `&T` is `Copy`; the annotated `(a : &T) = s.r` is accepted, so the bare and annotated forms disagree.

Found while implementing VERDICTS-76 Q1 (the Fable review's edge-case row 14, left to the VERDICTS-75 §8
PR).

```yo ignore
S :: struct(r : &i32, n : i32);
main :: (fn() -> unit)({
  x := i32(1);
  s := S(r : &x, n : i32(0));
  a := s.r; // E0926
  _v := a.*;
});
export(main);
```

```
error[E0926]: `s.r` is a reference (`&i32`): reading the value it refers to is spelled `s.r.*`
  --> r14.yo:5:10
  |
5 |   a := s.r;
  |          ^
help: write `s.r.*`; `s.r.field`, `s.r.method()` and `s.r(i)` read through it, and `f(s.r)` passes it to a reference parameter
```

## Root cause

A reference field read (decision 43 step 2 N1e-2) reads as the place it refers to at every position that
is not a reference slot; a bare `:=` initializer is not one (the R-TAIL chain only admits reference
bindings, lends and projection calls as leaves), so the read is E0926.

## Required behaviour

`a := s.r` copies the `&T` (both spellings), with `a`'s origin the field's; a `&mut` field stays a
partial move (E0901, decision 19).
