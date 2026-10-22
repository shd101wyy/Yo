# A whole-value destructuring binds move-only fields as borrows

**Severity:** S2 — `{ a, b } := x` on an owned local is one of decision 19's
three ways out of "no partial moves", but its bindings are borrows. Moving a
move-only or explicit-copy field out of them is E0901, so valid code is
rejected. A `match` struct pattern works around it.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). `String.into_bytes`
(`sink(self)`) has to move `_bytes : ArrayList(u8)` out of `self` once
`ArrayList` is a value, and `{ _bytes } := self` was rejected.

## Reproducer

`issues/repros/2026-10-22-a-whole-value-destructuring-binds-move-only-fields-as-borrows.yo`:

```yo
{ println } :: import("std/fmt");
B :: struct(n : i32);
impl(B, Drop(drop : (fn(self : &mut Self) -> unit)(println("drop B"))));
W :: struct(_b : B, k : i32);
main :: (fn() -> unit)({
  w := W(_b : B(n : i32(4)), k : i32(1));
  { _b, k } := w;
  b := _b;
  println(&b.n);
});
export(main);
```

Both the v0.2.68 seed and develop `e30c0d8ed` reject it:

```text
error[E0901]: use of moved value: cannot copy `_b`, whose type `B` is move-only, and it cannot be moved either: it is borrowed (a `&T` parameter or a `match`/`for` binding), and a borrow cannot give the value away. Take the parameter by value (`x : T`, without `&`) to own it.
```

`{ _b } := self` inside `fn(sink(self) : Self)` gives the same error. The
struct pattern below compiles and runs ("4", then "drop B") under both
binaries:

```yo ignore
b := match(w, W(_b : x, k : _) => x);
```

## Expected

`plans/VALUES_BY_DEFAULT.md` decision 19 lists "a whole-value destructuring
(`{ a, b } := x`)" as a way to move fields out of a value. When the source is
an owned local (or an owned `sink` parameter), the destructuring should
consume it and bind each field by value, as an owned `match` scrutinee does.
After that, a later use of `x` is E0901.

## Root cause (hypothesis)

The curly form is the match evaluator unwrapping a one-argument anonymous
struct (`plans/reference/MATCH_PATTERN_MATCHING.md`, the parser table). It
seems to bind like a `match` on a borrowed scrutinee, `match(&x, …)`, rather
than an owned one, so its bindings carry the borrowed flag that E0901's
"borrowed binding" branch reads.

## Fix direction

Give the destructuring statement the same scrutinee ownership rule as `match`:
a named owned local or a `sink` parameter is consumed and its bindings own.
The regression test is the repro above, plus the `sink(self)` newtype case.
