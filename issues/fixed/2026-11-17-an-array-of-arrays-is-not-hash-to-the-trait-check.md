# An array of arrays is not `Hash` to the trait check, so `derive(Nested, Hash)` over one is rejected

**Severity:** S2 — a valid program was rejected: `derive(T, Hash)` on a struct with an `Array(Array(i32, 2), 2)` field
failed with `Type "Array(Array(i32, 2), 2)" does not implement trait "Hash"`, and `tests/derive.test.yo` failed to
compile on develop `b2155b8bf`.

**Status:** FIXED on `fix/develop-v0279-reds`.

## Reproducer

```yo
main :: (fn() -> unit)({
  comptime_assert(Type.impls(Array(Array(i32, 2), 2), Hash), "an array of arrays is Hash");
});
export(main);
```

`Type.impls` was false here on every compiler back to the v0.2.78 seed. `Type.impls(Array(i32, 2), Hash)` and
`Type.impls(Option(Array(i32, 2)), Hash)` were true, and `Type.impls(Array(Option(Array(i32, 2)), 2), Hash)` was false.

## Root cause

Step 8 of `type_implements_trait` (`src/evaluator/trait_checking.yo`) guards recursion with a key of the target's id
and the trait's id. An enum instance keys by its id and type arguments; every other type keys by
`_type_id_for_trait_check`, which is `Array` for every `Array(T, N)`. Checking `Array(Array(i32, 2), 2) <: Hash` matches
the prelude's `impl(generic(T, U), where(T <: Hash), Array(T, U), Hash)`, whose where-pass checks
`Array(i32, 2) <: Hash` under the same key `Array:Hash`. The guard read that as recursion and answered no.

Why a derive over a nested array still compiled before #1983 was not traced. Measured: the same binary compiles the
reproducer's derive against the std of `70a203d0c` and rejects it against the std of `b2155b8bf`, and commenting the two
`Array(T, N)` `Deref`/`DerefMut` impls #1983 added out of the prelude makes it compile again. The likeliest path is the
retry in `subtype_of.yo`, which forces an unforced impl of `Array` and checks again, and which the new impls leave
nothing to force; that is inferred, not probed. The guard collision is the defect in every case.

## Fix

The guard keys an array by its full type (`type_to_string`: element type and length), so the inner array is a
different obligation from the outer one.

## Verification

`tests/derive.test.yo` ("derive over an Array nested inside another aggregate") failed to compile on `b2155b8bf` and
passes with the fix. The row now also asserts `Type.impls(Array(Array(i32, 2), 2), Hash)` and
`Type.impls(Array(Option(Array(i32, 2)), 3), Hash)`.
