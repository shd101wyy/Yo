# A comptime_str METHOD RESULT does not convert to `str` in a typed binding — a `::`-bound value does

Found while writing the D4 PR 7 comptime-basis tests (2026-08-26). Not a D4
regression — the same shapes behave identically before and after the basis
flip; this is about the comptime→runtime conversion, not the index basis.

## Symptom

```rust
main :: (fn() -> unit)({
  s :: "abc";
  (rt : str) = s;              // ✅ OK — ::-bound comptime_str converts
  (a : str) = s.slice(1, 3);   // ❌ check error
});
```

```
check: error in: Error: Cannot unify incompatible types: "comptime_str" and "str"
```

The error carries **no useful location** either — it points at `1:1` with an
empty caret line, so in a large file the failing binding has to be found by
bisection.

## What works / what does not (measured, yo 0.2.17 seed + tree std)

| shape | result |
| --- | --- |
| `s :: "abc"; (rt : str) = s;` | ✅ converts |
| `(a : str) = s.slice(1, 3);` | ❌ Cannot unify |
| `sl :: s.slice(1, 3); (a : str) = sl;` | ✅ converts |
| `(n : usize) = usize(s.len());` | ✅ (explicit cast) |

So the comptime→runtime conversion (`expr_info.yo`'s "Runtime type after
comptime-to-runtime conversion (e.g. comptime_str → str)") fires for a
`::`-bound comptime VALUE used in a typed runtime binding, but not for the
comptime-evaluated RESULT of a method call in the same position — even though
the value is equally known at compile time (binding it through one extra `::`
name makes it work).

## Impact

Low — the `::`-rebind workaround is one line, and the tree has no other
consumers today. But the inconsistency is surprising, and the missing error
location makes it expensive to diagnose. `tests/comptime.test.yo`
("Comptime string basis is BYTES") and `tests/index.test.yo` (the D4 PR 7
tests) use the `::`-rebind idiom because of this.

## Repro

`tmp/fixme.yo`-sized standalone; check with
`YO_STD=$PWD/std yo check tmp/t1.yo`:

```rust
open(import("std/fmt"));
main :: (fn() -> unit)({
  s :: "abc";
  (ct_slice : str) = s.slice(1, 3);
  println(`${ct_slice.len()}`);
});
export(main);
```

## Fix direction (not attempted)

Wherever the typed-binding path applies the comptime_str→str conversion for
identifier operands, apply it to any operand whose `ExprInfo` carries a known
comptime_str VALUE. Separately, the "Cannot unify" error should carry the
binding's token instead of 1:1.
