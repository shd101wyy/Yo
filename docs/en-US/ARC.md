# Arc(T) — Shared Ownership with Atomic Reference Counting

`Arc(T)` provides shared ownership of a single value via atomic reference counting.
It is **not** a compiler built-in anymore. In the current design, `Arc` is defined
in `std/prelude.yo` as a thin `atomic(ref(struct(...)))` wrapper, so `Arc` and
`arc(...)` are available everywhere through the prelude. `Arc(T)` itself requires
`T <: Send`, which keeps `Arc` from laundering non-thread-safe values into a
thread-shareable wrapper.

## Current definition

```rust
Arc :: (fn(comptime(V) : Type, where(V <: Send)) -> comptime(Type))
  atomic(ref(struct(
    (*) : V
  )))
;

arc :: (fn(generic(V : Type), own(value) : V, where(V <: Send)) -> Arc(V))
  Arc(V)(value)
;
```

## When to use `Arc`

- Use `Arc(T)` when you want to share **one existing value** across threads or closures.
- Use `atomic(ref(struct(...)))` when you are defining your **own shared type**.
- Use `Iso(T)` when ownership should be **transferred**, not shared.
- `Arc(T)` only accepts `Send` child types. A regular `ref(struct(...))` value is not enough.

Many standard-library types no longer need an extra `Arc(...)` wrapper. For
example, `std/sync` primitives and `std/imm` collections are already implemented
with `atomic(ref(struct(...)))` and are directly shareable.

If you need shared mutable state, define that state as an `atomic(ref(struct(...)))`
first, then share it directly or place it inside `Arc(...)` if you specifically
need a single wrapped value.

## Basic usage

### Creating an Arc

```rust
value := arc(i32(42));
same := Arc(i32)(i32(42));
```

### Dereferencing

Access the inner value with `.(*)`, which yields borrowed access:

```rust
value := arc(i32(42));
copied := value.(*);
assert((copied == i32(42)), "inner value is 42");
```

### Copying

Copying an `Arc` increments the reference count and keeps sharing the same value:

```rust
a := arc(i32(42));
b := a;
c := b;

assert((a.(*) == b.(*)), "same shared value");
assert((b.(*) == c.(*)), "same shared value");
```

### Cross-thread sharing

```rust
{ Thread } :: import "std/thread";

shared := arc(i32(42));

t := Thread.spawn((io) => {
  assert((shared.(*) == i32(42)), "thread sees shared value");
});

t.join();
assert((shared.(*) == i32(42)), "main still sees shared value");
```

## `Arc` vs `atomic(ref(struct(...)))` vs `Iso`

| Need                                            | Preferred tool             |
| ----------------------------------------------- | -------------------------- |
| Share one existing value                        | `Arc(T)`                   |
| Define a reusable shared reference-counted type | `atomic(ref(struct(...)))` |
| Transfer unique ownership across scopes/threads | `Iso(T)`                   |

## Semantics

- **Atomic RC**: `Arc` uses atomic increment/decrement operations.
- **Shared ownership**: copying an `Arc` preserves the underlying allocation.
- **Borrowed deref**: `.(*)` gives borrowed access to the wrapped value.
- **Drop behavior**: when the last reference is dropped, the inner value is dropped and the allocation is freed.
- **Closure capture**: capturing an `Arc` in a closure duplicates the shared reference.

## Related docs

- `docs/en-US/PARALLELISM.md` — thread and worker model
- `docs/en-US/ISOLATED.md` — unique ownership with `Iso(T)`
- `docs/en-US/IMMUTABLE_COLLECTIONS.md` — persistent collections built on `atomic(ref(struct(...)))`
