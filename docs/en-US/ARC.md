# Arc(T) — Shared Ownership with Atomic Reference Counting

`Arc(T)` provides shared ownership of a single value via atomic reference counting.
It is **not** a compiler built-in anymore. In the current design, `Arc` is defined
in `std/prelude.yo` as a thin `atomic(ref(struct(...)))` wrapper, so `Arc` and
`arc(...)` are available everywhere through the prelude. `Arc(T)` itself requires
`T <: (Send, Sync)`, which keeps `Arc` from laundering non-thread-safe values into a
thread-shareable wrapper. Each bound has its own reason:

- `Sync`: every handle reads the payload from its own thread.
- `Send`: the last handle may be dropped on any thread, and the payload's `Drop` runs there
  (as Rust's `Arc<T>: Send + Sync` needs `T: Send + Sync`).

The payload need not be `Acyclic`, as in Rust. A cycle of `Arc` handles leaks: see
[Cycles](#cycles).

`Arc(T)` is itself `Send` and `Sync` under the same bound. The prelude states both impls
explicitly: a closure payload (`Arc(Impl(Fn() -> unit))`) is `Sync` only by value, through its
captures, which the type-level derivation cannot see.

## Current definition

```yo
Arc :: (fn(comptime(V) : Type, where(V <: (Send, Sync))) -> comptime(Type))(
  atomic(
    ref(
      struct(
        (*) : V
      )
    )
  )
);

arc :: (fn(generic(V : Type), sink(value) : V, (alloc : Option(Allocator)) ?= .None, where(V <: (Send, Sync))) -> Arc(V))(
  ...
);
```

`alloc : .Some(a)` places the cell in the allocator `a`. The default, `.None`,
places it in the current `with_allocator` scope, else the global allocator
(see [Placing the cell](#placing-the-cell)).

## When to use `Arc`

- Use `Arc(T)` when you want to share **one existing value** across threads or closures.
- Use `atomic(ref(struct(...)))` when you are defining your **own shared type**.
- To **transfer** a value to another thread rather than share it, move it: a `Send` value moves
  into a spawned closure or through a `Channel`. An `Rc` graph is thread-local (Rust's rule);
  `Rc.try_unwrap` takes the value out of a uniquely held `Rc`. Until `String` and the
  collections become `Send` by move (`plans/VALUES_BY_DEFAULT.md` V2b), neither crosses a
  thread: share data that is `Send` and `Sync` through an `Arc`, rebuild the value on the
  receiving thread from `Send` parts, or serialize it. (The one-shot isolated handoff that
  used to cover this was removed in v0.2.68.)
- `Arc(T)` only accepts child types that are both `Send` and `Sync`. A regular
  `ref(struct(...))` value is neither. A type that is `Send` but not `Sync` (one that opts out
  with `impl(T, !(Sync()))`) goes in a `Mutex(T)` instead, which serializes access.
- `arc(f)` of a function value (a closure or a named function) is judged by the value: what it
  captures and what its code reaches must be `Send` and `Sync` (rules D4 and D9,
  `THREAD_SAFETY.md`).

Many standard-library types no longer need an extra `Arc(...)` wrapper. For
example, the `std/sync` primitives are already implemented with
`atomic(ref(struct(...)))` and are directly shareable.

If you need shared mutable state, define that state as an `atomic(ref(struct(...)))`
first, then share it directly or place it inside `Arc(...)` if you specifically
need a single wrapped value.

## Basic usage

### Creating an Arc

```yo
value := arc(i32(42));
same := Arc(i32)(i32(42));
```

### Placing the cell

`arc(value, alloc : .Some(a))` allocates the cell from the allocator `a`, for
example an arena. The last handle's drop frees the cell through `a`, on
whichever thread drops it. Without `alloc`, a `with_allocator` scope places the
cell, else the global allocator does ([EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)).
Unlike `box`, `arc` makes `a` the current scope while the cell is allocated, so
`a`'s own callbacks must not allocate through the scope (see "Writing your own
allocator" there):

```yo
{ Arena } :: import("std/arena");

arena := Arena.new(usize(1) << usize(16));
{
  a := arc(i32(42), alloc : .Some(arena.allocator()));
  assert(arena.live_blocks() == usize(1), "the cell is in the arena");
};
assert(arena.live_blocks() == usize(0), "the last handle freed it into the arena");
arena.deinit();
```

### Dereferencing

Access the inner value with `.*`, which yields borrowed access:

```yo
value := arc(i32(42));
copied := value.*;
assert(copied == i32(42), "inner value is 42");
```

### Copying

Copying an `Arc` increments the reference count and keeps sharing the same value:

```yo
a := arc(i32(42));
b := a;
c := b;

assert(a.* == b.*, "same shared value");
assert(b.* == c.*, "same shared value");
```

### Cross-thread sharing

```yo
{ Thread } :: import("std/thread");

shared := arc(i32(42));

t := Thread(unit).spawn(io => {
  assert(shared.* == i32(42), "thread sees shared value");
});

t.join();
assert(shared.* == i32(42), "main still sees shared value");
```

### Unwrapping and copy-on-write

An `Arc`'s payload is read-only through the handle: a write through it is
rejected in safe code, and shared mutation goes through an `Arc(Mutex(T))`,
an `Arc(RwLock(T))` or an atomic. `Arc(RefCell(T))` is rejected, because a
`RefCell` is never `Sync`. Two doors prove the handle is the only one, as
Rust's do (decision 46 of
[the values-by-default plan](../../plans/VALUES_BY_DEFAULT.md)):

- **`Arc.try_unwrap(h)`** consumes the handle and returns `.Ok(payload)` when
  no other handle exists on any thread (the cell is freed), else `.Err(h)`.
- **`Arc.make_mut(&mut h)`** (`T <: Clone`) is the payload, written: a shared
  payload is first cloned into a fresh cell that `h` alone holds.

```yo
a := arc(i32(1));
b := a;
Arc.make_mut(&mut b) = i32(2); // b gets a cell of its own
assert((a.* == i32(1)) && (b.* == i32(2)), "a is unchanged");
```

## `Arc` vs `atomic(ref(struct(...)))`

| Need                                            | Preferred tool             |
| ----------------------------------------------- | -------------------------- |
| Share one existing value                        | `Arc(T)`                   |
| Define a reusable shared reference-counted type | `atomic(ref(struct(...)))` |
| Hand a `Send` value to another thread           | a move (spawn, `Channel`)  |

## Semantics

- **Atomic RC**: `Arc` uses atomic increment/decrement operations.
- **Shared ownership**: copying an `Arc` preserves the underlying allocation.
- **Borrowed deref**: `.*` gives borrowed access to the wrapped value.
- **Drop behavior**: when the last reference is dropped, the inner value is dropped and the allocation is freed.
- **Closure capture**: capturing an `Arc` in a closure duplicates the shared reference.

## Cycles

Atomic reference counts are not cycle-collected. A payload that holds an `Arc` back to its own
cell, directly or through a `Mutex`, closes a cycle whose counts never reach zero, and the cells
stay allocated until the process exits, as they would in Rust:

```yo
{ Mutex } :: import("std/sync/mutex");

Node :: struct(id : i32, peer : Option(Arc(Mutex(Self))));

a := arc(Mutex(Node).new(Node(id : i32(1), peer : .None)));
b := a;
a.with_lock(v => {
  v.peer = .Some(b); // a -> mutex -> node -> a: this cell is never freed
});
```

Break the cycle by clearing a back edge (`v.peer = .None` under the lock) before the last handle
that reaches it is dropped. Compile with `--allocator fixed --debug-heap` to see a leaked cycle:
the exit report counts the blocks still live
([EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md#debugging-the-leak-report)).

## Related docs

- `docs/en-US/PARALLELISM.md` — thread and thread-pool model
