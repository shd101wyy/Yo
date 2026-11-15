# `Type.eq`, `Type.neq` and `Type.impls` reject an unsized type

**Severity:** S3 (a compile-time reflection helper refuses a valid type argument; a loud E0619, never wrong output)

## What happened

Under the decision 49 S2 flip, `Dyn(...)` is unsized. Comparing two trait-object types at compile time
failed:

```text
error[E0619]: `Dyn(Loud, Speak)` is not `Sized`: `(Type.eq)`'s type parameter `a` needs a size, ...
48 |   comptime_assert(Type.eq(Dyn(Speak, Loud), Dyn(Loud, Speak)), "one type");
```

`Type.impls([u8], Sized)` failed the same way instead of answering `false`.

## Root cause

The prelude declares the helpers' parameters `comptime(a) : Type`. A `Type` binder implies
`where(a <: Sized)`, but the bodies only hand the type to a builtin (`__yo_are_types_equal`,
`__yo_type_impls`) and never hold a value of it.

## Fix

The helpers' type parameters are declared `?Sized`, which the v0.2.77 seed accepts (`yo check ./std`
rc 0). Test: `tests/sized.test.yo` "Type.eq, Type.neq and Type.impls take an unsized type". Found
while moving `tests/cli-cases/fix-migrate-unsized` to the v0.2.78 spelling.
