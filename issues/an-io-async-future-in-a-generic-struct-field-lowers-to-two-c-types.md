# An `io.async` future in a generic struct's field lowers to two C types

**Severity:** S2 — a valid program fails in the C compiler, and `yo check` passes. It blocks any generic container or guard that holds its `T` when `T` is an `io.async` future.
**Found:** 2026-09-30, writing `with_allocator` (`plans/EXPLICIT_ALLOCATORS.md` P3). It reproduces on develop at `f7f1331fb`, where the nested-typedef defect hid it (`issues/fixed/an-io-async-future-stored-in-an-enum-payload-emits-a-nested-typedef.md`).

## Reproducers

A pointer field:

```rust
pragma(Pragma.AllowUnsafe);
_Holder :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(r : Option(*(T)))));
_wrap :: (fn(generic(T : Type), f : Impl(Fn() -> T)) -> T)({
  h := _Holder(T)(r : .None);
  f()
});
main :: (fn(io : Io) -> unit)({
  task := _wrap(() => io.async((io : Io) => i32(8)));
  println(io.await(task, io));
});
```

```
error: incompatible pointer types assigning to '__yo_t_… **' (the Future interface) from '…_sync_fut_t **'
```

A value field, stored and returned:

```rust
_Holder :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(r : Option(T))));
_hold :: (fn(generic(T : Type), x : T) -> _Holder(T))(_Holder(T)(r : .Some(x)));
main :: (fn(io : Io) -> unit)({
  h := _hold(io.async((io : Io) => i32(8)));
  match(h.r, .Some(task) => println(io.await(task, io)), .None => println("none"));
});
```

```
error: incompatible pointer types initializing '…_sync_fut_t *' with an expression of type '__yo_t_… *'
```

There is a third shape. A PHANTOM guard `_G(T) :: ref(struct(n : u8))`, used as a local
in `fn(generic(T), f : Impl(Fn() -> T)) -> T` specialized once at a `ref` struct
and once at a future, emits the future specialization's local as the
unsubstituted `_G(T)`. Its dispose then calls the `ref` struct specialization's
`Dispose`:

```
error: incompatible pointer types passing '…' (_G(T)) to parameter of type '…' (_G(_P))
```

## Cause (partial)

A `Future`-bounded type variable has two C spellings. With a resolution it
is the state machine of its `io.async` block. Without one it is the erased
"Generic Future interface" struct, the prefix every future starts with. The
struct's field declaration and its constructor, or its readers, pick different
copies of the same variable, one resolved and one not, and the C type key does
not include the resolution. So one struct type carries both spellings. The
phantom-guard shape is the same split at the struct level. With `T` bound to an
unresolved future, substitution cannot move `_G(T)` to a concrete instance, and
`canonicalize_instantiation_via_ctfe_memo` excludes type arguments that carry a
type variable.

## Recommendation

Give a future-bounded type variable ONE lowering inside aggregates. Either key
the aggregate on the resolution, so `_Holder(<state machine>)` is its own C type,
or always store the erased interface pointer and cast at the store. The second
matches how the runtime already reads futures, through the shared prefix. This
sits in the async state-machine lowering that the async-state-machines work is
rewriting (#1001–#1018), so it should land after that series.

`with_allocator` no longer depends on it. Its guard never needed to hold `T`,
and it is now a plain `ref` struct, `std/allocator.yo`.
