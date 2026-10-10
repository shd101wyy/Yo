# A borrow marker on a type argument is silently peeled: `ArrayList(&i32)` is `ArrayList(i32)`

**Severity:** S2 — an invalid program (a borrow written as a type argument) was accepted and silently meant something else.

> Found 2026-10-10 while implementing decision 42 Generation A
> (`plans/VALUES_BY_DEFAULT.md`) on the V3b step 3 branch. **FIXED same day**
> on `feat/vbd-decision42-gen-a`.

## Symptom

```rust
{ ArrayList } :: import("std/collections/array_list");
T :: ArrayList(&i32);   // accepted: T is ArrayList(i32)
```

`yo check` passed. `Option(&mut i32)` was accepted as `Option(i32)` the same
way.

## Root cause

After step 3, `&x` in argument position is a call-site borrow marker
(decision 33). `apply_call_site_borrow_markers`
(`src/evaluator/calls/helper.yo`) peels a `&x` lent to a parameter that is
neither by value, `mut` nor a raw pointer, which is how it recognizes an
`imm` parameter. A `Type`-valued parameter (`comptime(T) : Type`) carries
none of those flags: decision 30's flip leaves a `Type` parameter modeless.
So `&i32` passed to `ArrayList`'s `T` was peeled as if lent to an `imm`
parameter, and `i32` was the argument.

## Fix

A marker lent to a parameter whose type is a type universe (`Type`,
`Type(1)`, …) is the decision 42 error: a borrow is a mode a slot spells, not
a type:

```
`&i32` is a borrow mode, not a type: it is written on a parameter (`x : &i32`), …
```

The same message covers `T :: &i32` and a field `f : &i32` (the `&`/`&mut`
evaluation arms in `src/evaluator/exprs/_expr.yo` trial-evaluate the operand,
and a type operand gets this message instead of "lends a borrow").

## Test

`tests/borrow_spelling.test.yo`: `bs_type_argument` (`ArrayList(&i32)`),
`bs_mut_type_argument` (`Option(&mut i32)`), `bs_type_alias`, `bs_field_type`.
