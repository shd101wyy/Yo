# A `Stream` combinator used twice in one chain emits two C types for its result

**Status:** OPEN
**Found:** 2026-09-28, while fixing the Stream-combinator E0905 on `tss/p37-registry-v2`. It reproduces on develop (`1d161bee3`, compiler built from the tree) as well: it is not a regression of that branch.

## Symptom

```rust
{ Channel } :: import("std/async/channel");
{ Stream } :: import("std/async/stream");
{ println } :: import("std/fmt");
main :: (fn(io : Io) -> unit)({
  ch := Channel(i32).new(usize(8));
  _a := ch.try_send(i32(1));
  _b := ch.try_send(i32(2));
  ch.close();
  chain := ch.map(x => (x * i32(10))).map(x => (x + i32(1)));
  got := io.await(chain.collect(io), io);
  println(`${got.len()}`);
});
export(main);
```

`yo check` is green; `yo compile` fails in the C compiler:

```
error: incompatible pointer types returning '__yo_t_254400430900837179 *' from a function
       with result type '__yo_t_5133063245995022914 *' [-Werror,-Wincompatible-pointer-types]
```

The two structs have identical fields (`_inner`, `_f`); they differ only in their
`type_key`. The `map` specialization's C signature spells its result
`StreamMap(Self, B, F)` with unsubstituted SomeT type arguments
(`// : StreamMap(S : (Stream), B, F : (Fn(A) -> B))`), while the value it builds
is keyed by the concrete arguments (`StreamMap(StreamMap(...), i32, <capture>)`).

Every chain that uses one combinator twice fails the same way:
`filter(...).filter(...)`, `map(...).filter(...).map(...)`. Chains of distinct
combinators (`map(...).filter(...)`, `filter(...).map(...)`) and `take(...).take(...)`
(no closure) compile and run.

## What is known (measured)

- The two calls of `map` share binder ids: `map`'s `F` is SomeT id `2999` in both,
  and the inner call's copy (inside the outer call's `Self`) carries the inner
  closure's capture as its resolution.
- Reproduces with the develop compiler, before and after the p37 substitution
  changes (the name-keyed rewrite of a resolved SomeT is not the cause).

## Not yet known

Which site builds the specialization's declared result type, and why its type
arguments stay abstract while its fields are concrete.
