# An `Option` of an io.async future is judged comptime-only since #1112

**Severity:** S2. A valid program is rejected, and on develop a 61-test batch of
`tests/async_await.test.yo` fails to compile, so none of its tests run.

**Status:** FIXED 2026-10-02 (`fix/enum-bind-only-phantom-positions`).
Introduced by #1112 (`758c81bc4`, "EnumT carries its type_arguments"). Found
by the same shape in an independent implementation of that change
(`fix/enum-type-arguments`, superseded by #1112).

## Reproduction

```rust
test("only the Option", {
  f := io.async((io : Io) => i32(9));
  o := Option(typeof(f)).Some(f);
  b := match(o, .Some(task) => io.await(task, io), .None => i32(-1));
  assert(b == i32(9), "the held future is awaited");
});
```

Measured on develop `235cf09ac` (tree build):

```
error: Expected "::" instead of ":=" for compile-time known value assignment:
o := (Option(typeof(f)).Some)(f)
Type:
Option(Impl(Future(i32, Io)))
```

`tests/async_await.test.yo` (test "an io.async future in a generic struct
field and in an Option") has the same line. Its whole batch, 61 tests, fails
to compile. CI on `758c81bc4` reports only the earlier `sm_ownership`
failure, because the suite stops at the first failing file.

## Cause

`_bind_forall_from_type_args` (`src/evaluator/values/impl.yo`) is the
fallback that binds a generic impl's parameter from the instantiation's type
arguments when field synthesis left it unbound. #1112 gave enums type
arguments, so the fallback started binding enum parameters at every position.
For `Option(Impl(Future(i32, Io)))` it bound `Option(T)`'s `T`, which a payload
mentions and field synthesis deliberately leaves open for an `Impl` type
variable. That changed the `Runtime`/`Comptime` derivation for the instance:
`type_implements_comptime && !type_implements_runtime_full` became true, so
`:=` was rejected.

## Fix

For an enum, the fallback binds only a PHANTOM position, per #1112's own
`enum_phantom_positions` (decided from the constructor's definition-time
trial). The pattern's enum id is consulted first, then the concrete one's. A
struct is unchanged. The phantom-enum cases #1112 fixed still pass.

## Regression test

`tests/async_await.test.yo`, "an io.async future in a generic struct field
and in an Option". Measured on develop: the batch fails to compile. With the
fix: 261 passed. `tests/comptime_type_arg_binding.test.yo`: 10 passed.
