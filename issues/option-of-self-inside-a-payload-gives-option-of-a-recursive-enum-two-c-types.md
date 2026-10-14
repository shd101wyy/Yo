# An `Option(Self)` inside a recursive enum's payload gives `Option(E)` two C types

**Severity:** S2: a valid program that `check` accepts fails in the C compiler (incompatible initializer types).

**Status: OPEN.** Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c and v0.2.61. #1341's `type_key` fix covers `ArrayList(ArrayList(Self))`, but not this shape.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
J :: enum(JStr(s : String), JOpt(o : ArrayList(Option(Self))));
first :: (fn(xs : &ArrayList(J)) -> Option(J))(xs.get(usize(0)));
main :: (fn() -> unit)({
  xs := ArrayList(J).new();
  xs.push(J.JStr(s : String.from("v")));
  r := match(first(&xs), .Some(_) => i32(1), .None => i32(-1));
  println(`r=${r}`);
});
export(main);
```

`yo check` passes. clang fails with an initializer error between two different C types for `Option(J)`.

## Cause

While `J`'s key is built, the inner `Option(Self)` is keyed with `J` on the `g_tk_visited` path. The `EnumT` cycle guard in `src/types/type_key.yo` (about line 429, `return(eid.clone())`) therefore renders `J` id-only inside it. The same `Option(J)` reached from outside expands `J` fully. That gives two structural signatures, and `_lookup_or_register_enum_sig` registers both.

A `TypeValue`-like enum with an `ArrayList(Option(Self))` or `Rc(Option(Self))` field would split the same way, so this matters to V4.

## Fix direction

Key a node that contains the guarded enum the same way inside and outside the guard: resolve the self-shell to the final enum before keying, as #1341 did for type arguments. Add the program above as a test.
