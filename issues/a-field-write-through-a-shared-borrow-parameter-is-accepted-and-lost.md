# A field write through a `&T` parameter is accepted, and the write is lost

**Severity:** S2 — an invalid program is accepted: `p.n = v` on a `p : &T` parameter compiles, writes a callee-local copy, and the caller never sees it.

**Status:** open. Found 2026-10-12 while testing the unique `Box` (V1 step 2):
`b.n = v` on `b : &Box(P)` compiled, and the same holds for a plain `&P`.

## Reproducer

```yo
{ eprintln } :: import("std/fmt");
P :: struct(n : i32);
w :: (fn(p : &P) -> unit)({
  p.n = i32(1); // expected: E0908, a `&T` borrow is read-only
});
main :: (fn() -> unit)({
  x := P(n : i32(0));
  w(&x);
  eprintln(&x.n); // prints 0
});
export(main);
```

`yo check` accepts it. A whole-value write (`p.* = …` through a `&Box(P)`) and
a write that releases owned data are already E0908.

## Root cause

E0908 fires only where the old value holds data its owner still holds
(an RC or move-only part). A write of plain data through a `&T` parameter
reaches no check, and `&T` of a small value lowers to a by-value C
parameter, so the write lands in the callee's copy.

## Fix direction

`plans/VALUES_BY_DEFAULT.md` §3.1: "A write through a `&T` borrow is E0908."
Every place rooted at a `&T` parameter or `&` local borrow, through field,
element and `Box` payload steps, is read-only; the assignment and `&mut`
argument paths reject it. A `tests/` case: `p.n = v` and `b.n = v` (for
`b : &Box(P)`) are E0908.
