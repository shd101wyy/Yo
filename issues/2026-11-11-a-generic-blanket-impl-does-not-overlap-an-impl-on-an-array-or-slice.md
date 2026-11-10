# A blanket impl does not overlap a concrete impl on an array or slice type

**Severity:** S3: a duplicate-coverage impl is accepted silently (dispatch then picks one); no tree code hits it, but it leaves coherence rule 3's `?Sized` half untestable.

## Reproducer

```yo ignore
_CoAll :: trait(co_all : (fn(self : &Self) -> i32));
impl(generic(T : Type), T, _CoAll(co_all : (fn(self : &Self) -> i32)(i32(3))));
impl(Array(i32, 2), _CoAll(co_all : (fn(self : &Self) -> i32)(i32(4))));
main :: (fn() -> unit)(());
export(main);
```

`yo check` passes (v0.2.76 and the tree). The same pair with `impl(i32, ...)` reports E0612 "already implemented ... by the generic impl ... which covers it". With `T : ?Sized` and `impl([i32], ...)` the overlap is likewise not reported, though decision 49 says a `?Sized` blanket takes the unsized types.

## Root cause

Not investigated: `_check_concrete_impl_coherence` (`src/evaluator/values/impl.yo`) reports an overlap for primitive receivers but not for `Array(T, N)` / `Slice(T)` receivers.

## Test

None yet: it must fail before the fix. The row belongs in `tests/sized.test.yo` ("a blanket over a Type binder covers the sized types only") as `comptime_expect_error(impl([i32], _CoAll(...)), "already implemented")` with the `?Sized` blanket.
