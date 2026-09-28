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

It happens with Iterator combinators too: `xs.into_iter().map(f).map(g).count()` fails the
same way, on develop as well.

## Root cause (measured with probes on the branch `tss/stream-repeat`)

The root is that **a substituted instance keeps its def-era struct id**. So
`StreamMap(StreamMap(Channel, …), …)` nests two different instances under one id
(`struct_async__stream_StreamMap_r1c6_n1`), and three identity mechanisms keyed by that id
read the nesting as a cycle or as a match:

1. **`type_key`'s cycle guard** (`types/type_key.yo`, `g_tk_visited`) cut the inner
   instance to its bare id. So the spec's declared result
   (`StreamMap(Self, B, F)`, whose `Self` is the inner instance) and the value it builds
   got different keys. A probe on `evaluate_function_return_type_again` showed the outer
   result's first argument rendered as `struct_…_n1` instead of the inner `gs_…` key.
   *Fix (on the branch):* a path entry is the id plus the type arguments' identities
   (`_tk_node_id`). This alone fixes every two-deep repeat.
2. **The specialization cache** (`_find_specialization_cache`) accepts
   `are_types_compatible_exact`, which judges two instances of one id equal without their
   arguments. It checked `type_key` only when the cached type carried SomeTs.
   *Fix:* require `type_key` equality for any instantiation with type arguments.
3. **The intern key** (`types/intern.yo`, `S:<id>` visited token) has the same id-only
   guard. The third `map`'s substituted result `StreamMap(SM2, B, F)` interned to the
   second's `StreamMap(SM1, B, F)`: both nested instances rendered as `S:n1`, with the same
   still-open `B`/`F`. A probe after the method-type `substitute` in
   `find_methods_from_generic_impls` showed the match bound `S := SM2` while the
   substituted result's argument was `SM1`.
   *Fix (on the branch, not yet built):* the token carries the type arguments' identities
   (`_ik_node_token`).

Also on the branch: impl matching takes each forall's receiver-pattern binding before the
where pass (`pre_where_bindings`, `values/impl.yo`), because the pass's env write-back let
a nested match of the same impl overwrite it.

## Status

Two-deep repeats and alternating chains are fixed and tested on the branch. Three-deep and
deeper repeats await a build of fix 3.
