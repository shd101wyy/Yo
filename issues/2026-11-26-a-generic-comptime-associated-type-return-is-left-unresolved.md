# A generic function returning `comptime(T.Output)` yields the bare type `Output`

**Severity:** S2 — a valid generic comptime function cannot be used. Its result has the unresolved type `Output`, so any use is E0610 (or E1301 at a conversion), while the runtime spelling `-> T.Output` works.

**Found:** 2026-11-26, lane v81-v87-ad (VERDICTS-87 PR D). The fix for `issues/fixed/2026-11-26-negate-and-bitnot-output-are-ignored-by-the-unary-dispatchers.md` gave the prelude's comptime dispatchers `-> comptime(_Self.Output)`, and stage 1 then failed to build: `f64(-1.0e400)` in `std/math.yo` (`f64.NEG_INFINITY`) became `double.__yo_v_NEG_INFINITY` in the emitted C, which clang rejects ("expected expression").
**Measured:** stage 1 of `wip/v0281-v87a` (yo 0.2.79 + develop `77af20c87` + VERDICTS-87 PR A), with that branch's std.

## Symptom

```yo
{ println } :: import("std/fmt");
f :: (fn(generic(T : Type), comptime(x) : T, where(T <: (Comptime, ComptimeNeg))) -> comptime(T.Output))(x.neg());
g :: (fn(generic(T : Type), x : T, where(T <: Neg)) -> T.Output)(x.neg());
main :: (fn() -> unit)({
  d := f(2.5);
  println(`${d}`);
});
export(main);
```

```text
error[E0610]: No method "to_string" on Output: the type has no field or method with that name.
```

- `f(i32(2))`: the same error.
- `d := f(2.5); x := f64(d);`: E1301 "internal compiler error: Failed to transpile part of main's body".
- `g(i32(3))`, the runtime twin: prints `-3`.

## Root cause (partial)

At call time, the `T.Output` projection in a `comptime(...)` return type is not resolved against `T`'s impl, so the call's return type stays the bare SomeT `Output`. The binary-operator path in `src/evaluator/calls/function.yo` (~11989, "Resolve an associated-type return (`comptime(Self.Output)`) that came back as a bare SomeT") patches the same symptom for trait methods by reading the receiver's registered associated types. A free generic function gets no such patch. Where the runtime return path resolves the projection was not traced.

## Workaround in the tree

The prelude's `comptime_neg` and `comptime_bit_not` (the `(-)` and `(~)` dispatchers) keep `-> comptime(_Self)`. Every prelude `ComptimeNeg`/`ComptimeBitNot` impl has `Output = Self`.

## Fix

Resolve the projection for a `comptime(...)`-wrapped return as the runtime path does. Then give the two comptime dispatchers `-> comptime(_Self.Output)`, which is the comptime half of VERDICTS-87 PR D.

## Test to add with the fix

The program above in a language test, asserting `f(2.5) == -2.5` and `f(i32(2)) == i32(-2)`, plus a user comptime type whose `ComptimeNeg.Output` is not `Self`. It fails before the fix with the E0610 above.
