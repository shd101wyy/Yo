# Assigning to a comptime ENUM payload field is a silent no-op

**Status: OPEN. Not fixed — see "Why it is not obviously small".**

**Severity: silent wrong value at compile time.** `c1 :: Shape.Circle(5.0);`
followed by `c1.radius = 10.0;` is ACCEPTED and does nothing: `c1.radius` is
still `5.0`. The same assignment on a comptime STRUCT field, a comptime ARRAY
element and a comptime TUPLE element all work, and the same assignment on a
RUNTIME enum value works. It is specific to enum payload fields at compile
time.

**Found** 2026-09-05, by making `comptime_assert` fire inside a function body
(`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`).
`tests/comptime.test.yo`'s value-semantics test has asserted
`c1.radius == 10.0` since it was written; the assertion had never run.

## Reproducer

```rust
{ println } :: import("std/fmt");
Shape :: enum(Circle(radius : f32), Rectangle(width : f32, height : f32));
One   :: enum(Only(v : i32));
SPoint :: struct(x : i32, y : i32);

_c1 :: Shape.Circle(5.0);
_c2 :: _c1;
_i1 :: begin(_c1.radius = 10.0, ());
_R1 :: _c1.radius;
_R2 :: _c2.radius;

_r1 :: Shape.Rectangle(1.0, 2.0);
_i2 :: begin(_r1.width = 7.0, ());
_RW :: _r1.width;

_o1 :: One.Only(3);
_i3 :: begin(_o1.v = 9, ());
_OV :: _o1.v;

_p1 :: SPoint(3, 4);            // struct control
_i4 :: begin(_p1.x = 5, ());
_PX :: _p1.x;

main :: (fn(io : Io) -> unit)({
  println(`comptime enum   c1.radius   = ${_R1}   want 10`);
  println(`comptime enum   c2.radius   = ${_R2}   want 5 (copy)`);
  println(`comptime enum   r1.width    = ${_RW}   want 7`);
  println(`comptime enum   o1.v        = ${_OV}   want 9`);
  println(`comptime struct p1.x        = ${_PX}   want 5`);
  // Runtime control — this one is correct.
  c := Shape.Circle(5.0);
  c.radius = 10.0;
  println(`runtime  enum   c.radius    = ${c.radius}   want 10`);
});
export(main);
```

Measured on v0.2.24 (the released seed) AND on this tree — identical, so it is
not a regression:

```
comptime enum   c1.radius   = 5    want 10          WRONG (silent no-op)
comptime enum   c2.radius   = 5    want 5           ok
comptime enum   r1.width    = 1    want 7           WRONG
comptime enum   o1.v        = 3    want 9           WRONG
comptime struct p1.x        = 5    want 5           ok
runtime  enum   c.radius    = 10   want 10          ok
```

Every enum shape is affected — one-field and two-field variants, `f32` and
`i32` payloads, first and later variants.

## Where to look

`src/evaluator/exprs/assignment.yo`. The comptime place-update block has arms
for `is_struct_val`, `is_array_val` and `is_enum_val`, and the **enum arm is
present and reads correct**: it locates the variant index in the binding type's
`EnumT` variant-name list, then the field index in that variant's label list,
then rebuilds the `EnumVal` with `rebuild_list_with_index` and calls
`update_existing_variable`. So the defect is one of

* the arm is not REACHED (an earlier guard in the chain matches first, or the
  property-assignment path is not entered for an enum LHS at all);
* `pc_var.ty` is not the `.EnumT` the arm matches on (a shell, or the variant's
  own type rather than the enum's), so `ev_fi` stays `-1` and the arm silently
  returns;
* `ev_variant` does not string-match any entry of `ev_vnames`.

All three fail the same way — silently — which is the other half of the bug:
the assignment should either take effect or be REJECTED, never be accepted and
discarded.

## Why it is not obviously small

Telling those three apart needs evaluator instrumentation and a compiler
rebuild per probe, and the fix could be in the enum arm, in the LHS place
resolution, or in what type the `::` binding records for an enum value — three
different files. That is its own investigation, not a drive-by in the change
that revealed it.

## What the tests do meanwhile

`tests/comptime.test.yo`'s enum value-semantics block now asserts the MEASURED
value with a comment naming this issue and the value it should have. It stays a
LIVE assertion: when the assignment works, it goes red, and that red is the
reminder to restore `10.0`.
