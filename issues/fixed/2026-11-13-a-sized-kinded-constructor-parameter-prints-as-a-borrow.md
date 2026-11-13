# A `?Sized`-kinded constructor parameter prints as a borrow

**Severity:** S3 (diagnostics and LSP text only; no program changes meaning)

**Filed:** 2026-11-13, found by the decision 49 S2 lane (`vbd/d49-s2`) in the
LSP completion golden once `Box`/`Rc`/`Arc` declared `comptime(V) : ?Sized`.

## Symptom

A type constructor whose parameter has the `?Sized` kind printed its type with
a borrow sigil, unlike the same constructor over `Type`:

```yo
F :: (fn(comptime(V) : ?Sized) -> comptime(Type))(newtype(p : Option(i32)));
G :: (fn(comptime(V) : Type) -> comptime(Type))(newtype(p : Option(i32)));
```

`(a : i32) = F;` reported `Given   : fn(V : &?Sized) -> Type`, while `G`
reported `fn(V : Type) -> Type`. The LSP completion detail of `Rc`, `Box`,
`Weak` and `Eq` showed the same `&?Sized`.

## Root cause

A comptime parameter whose type is a kind (`Type` or `?Sized`, `is_type_kind`)
takes no by-value flag, so its slot is a borrow. `format_param_with_mode`
(`src/types/string.yo`) prints a `Type`-valued parameter bare ("has no mode to
speak of") but matched only the text `Type` / `Type(…)`, so the `?Sized` kind
fell through to the borrow arm.

## Fix

`format_param_with_mode` treats a parameter printed `?Sized` as it treats a
`Type` one.

## Test

`tests/sized.test.yo`, "a ?Sized constructor parameter prints with no mode":
`comptime_expect_error` on the incompatible-types message expects
`fn(V : ?Sized) -> Type` (it reported `fn(V : &?Sized) -> Type` before the fix).
