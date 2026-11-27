# `longdouble` still implements `Hash`, which `f32` and `f64` no longer do

**Severity:** S3 — an inconsistency in the prelude: a float hash map key is rejected for `f32`/`f64` (E0602) and accepted for `longdouble`.

**Found:** 2026-11-26, lane v81-v87-ad (VERDICTS-87 PR D), reading `longdouble`'s impls.
**Measured:** the released `yo 0.2.79` with its bundled std.

## Symptom

```yo
{ println } :: import("std/fmt");
{ hash_one } :: import("std/hash");
main :: (fn() -> unit)({
  a := hash_one(longdouble(1.25));
  b := hash_one(longdouble(1.75));
  println(`${a == b}`);
});
export(main);
```

```text
true
```

The same program on `f64` is a compile error (`tests/prelude.test.yo`, "float Hash is deleted — hashing a float is a compile error"). On `longdouble` it compiles, and the hash is `hasher.write_i64(i64(self.*))`: every value in `[1, 2)` hashes alike, and the key set of a `HashMap(longdouble, V)` is subject to the `NaN != NaN` problem that removed the `f32`/`f64` impls.

## Root cause

`std/prelude.yo`, the `longdouble` block: the `Hash` impl was not removed when the `f32` and `f64` ones were (the same pass also missed `longdouble`'s bitwise impls, `issues/fixed/2026-11-26-bitnot-on-a-longdouble-passes-check-and-emits-invalid-c.md`).

## Fix

Delete the `longdouble` `Hash` impl, and add a `longdouble` row to the "float Hash is deleted" test.
