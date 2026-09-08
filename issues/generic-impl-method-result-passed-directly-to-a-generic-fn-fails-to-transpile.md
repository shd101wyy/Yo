# A generic-impl method's result passed DIRECTLY to a generic fn fails to transpile

**Status:** open
**Found:** 2026-09-08, writing the Core-numerics `checked_*` methods
(`plans/STD_API_STABILIZATION.md` §4)

## Symptom

```
yo: error: internal compiler error: Failed to transpile part of main's body —
the emitted C for "__yo_user_main" contains an untranspiled expression, so the
program would run without it
```

Caught only because it lands in `main`; the same expression in any other
function would emit a silent stub instead (now loud at runtime — see
`issues/fixed/ftt-stub-error-attribute-does-not-fire-at-O2.md`).

## Reproducer

```rust
{ println } :: import("std/fmt");
Integer :: trait();
impl(i32, Integer());
impl(
  generic(T : Type),
  where(T <: Integer),
  T,
  checked_add : (fn(self : T, rhs : T) -> Option(T))(
    cond(
      ((rhs > T(0)) && (self > (T.MAX - rhs))) => Option(T).None,
      true => Option(T).Some((self + rhs))
    )
  )
);
_is_none :: (fn(generic(T : Type), o : Option(T)) -> bool)(
  match(o, .Some(_) => false, .None => true)
);
main :: (fn() -> unit)({
  b := _is_none(i32.MAX.checked_add(i32(1)));   // ← FTT
  println(cond(b => `t`, true => `f`));
});
export(main);
```

## What isolates it

Only the **nesting** fails. Each half is fine on its own:

| shape | result |
| --- | --- |
| `_is_none(i32.MAX.checked_add(i32(1)))` — generic fn ← generic-impl method | **FTT** |
| `o := i32.MAX.checked_add(i32(1)); _is_none(o)` — same, via a local | OK, prints `t` |
| `_is_none_i32(i32.MAX.checked_add(i32(1)))` — CONCRETE fn ← generic-impl method | OK |
| `_is_none(Option(i32).Some(i32(5)))` — generic fn ← plain value | OK |
| `_is_none(_mk(i32(5)))` — generic fn ← NON-generic-impl fn | OK |
| `match(i32.MAX.checked_add(i32(1)), …)` — inline match, no generic fn | OK |

So the trigger is specifically: the argument expression is a method call
resolved through a `where(T <: Trait)` generic impl, AND the callee is itself
generic over that argument's type parameter. Either one alone works.

## Workaround

Bind the intermediate to a local, or use an inline `match`. Both are what the
Core-numerics tests do.

## Guess at the cause (NOT verified)

Smells like the argument's `Option(T)` never gets its `T` resolved to the
concrete specialization when the receiver's own `T` came from a generic impl —
the callee is then specialized against an unresolved SomeT and its body cannot
be emitted. The `[var-miss]`/`[swallow]` channels showed nothing beyond the
usual prelude noise, so this needs `YO_DEBUG_PARAMCHECK`-style tracing rather
than the swallow log. Compare
`issues/calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet.md`,
which is the same family.
