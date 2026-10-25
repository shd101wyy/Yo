# A list of async function values does not compile

**Severity:** S2 — a program that stores a named async function
(`-> Impl(Future(T, E))`) in an `ArrayList((fn(..) -> Impl(Future(T, E))))`
passes `yo check` and fails in the C compiler. No wrong code reaches a binary.

**Found:** 2026-10-25, by the review of
`issues/fixed/2026-10-24-two-async-functions-through-one-function-typed-parameter-are-called-through-an-incompatible-pointer-type.md`
(probes `r16_list_one` and `r6_spawn`). Develop `ec701e967` fails the same way,
before and after that fix.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
_fp_twice :: (fn(x : i32, io : Io) -> Impl(Future(i32, Io)))(io.async((io2 : Io) => (x * i32(2))));
main :: (fn(io : Io) -> unit)({
  fs := ArrayList((fn(x : i32, io : Io) -> Impl(Future(i32, Io)))).new();
  fs.push(_fp_twice);
  r := match(fs.get(usize(0)), .Some(f) => io.await(f(i32(21), io), io), .None => i32(0));
  println(`${r.to_string()}`);
});
export(main);
```

```
$ yo compile repro.yo --cc clang -o a.out
error: call to '__yo_fs_5730035852166399889' declared with 'error' attribute: yo: the body of __yo_fs_5730035852166399889 failed to transpile — its definition-time evaluation failed and was swallowed …
```

`__yo_fs_5730035852166399889` is the `(alloc, cap)` constructor that
`ArrayList(..).new()` calls for this element type. That is develop
`ec701e967`. With the fixed issue's change, clang stops earlier, at the push:
`fs.push(_fp_twice)` now passes the erased-signature thunk, without a cast, to
`push`'s parameter, which is declared with `_fp_twice`'s concrete
`<block>_sync_fut_t* (*)(..)`:

```
error: incompatible function pointer types passing '__yo_t_F *(int32_t, Io)' to parameter of type '…_sync_fut_t *(*)(int32_t, Io)'
```

(An `error` attribute fires only in clang's code generation, which a front-end
error stops, so the first error no longer shows.)

With a second function pushed (`fs.push(_fp_twice); fs.push(_fp_three);`) the
build fails in `ArrayList`'s internals instead (and, with the fixed issue's
change, at both push sites as well):

```
error: incompatible function pointer types passing '…_sync_fut_t *(*)(int32_t, …)' (`_fp_twice`'s state machine)
       to parameter of type '…_sync_fut_t *(*)(int32_t, …)' (`_fp_three`'s)
```

## What is known

- The element type `fn(x : i32, io : Io) -> Impl(Future(i32, Io))` is written
  with an unresolved `Impl(Future(..))`, but the list is specialized with that
  `Impl` resolved to ONE function's state machine. Its C element type is that
  function's `<block>_sync_fut_t* (*)(..)`, so every other function stored in
  it has an incompatible C type, and a function value handed out as the
  erased-signature thunk (`fn_value_c_name`) does too. The same resolution
  is what makes a reassigned `fn(..) -> Impl(Future(..))` local's type name
  the function assigned last (the fixed issue above, "Fix" item 2).
- A list element type should keep the erased Future interface, as a
  non-generic `fn(..) -> Impl(Future(..))` parameter does. Then every element
  is a thunk and every call through one is erased, which is what the fixed
  issue's invariant needs.
- The single-push failure (a swallowed definition-time evaluation in the
  constructor) has not been traced. `YO_DEBUG_SWALLOW=1 yo check` on the
  reproducer prints only the usual trial swallows in `std/prelude.yo` and
  `std/collections/array_list.yo`.
