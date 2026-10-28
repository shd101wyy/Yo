# Explicit Allocators

Yo manages memory with reference counting: an object dies when its last
reference goes away. An **explicit allocator** adds a second, independent
choice: **where** the object's bytes live. You can put a whole computation's
objects in one allocator, count every allocation a library makes, or give a
subsystem its own memory budget, without changing how the objects are used or
when they are freed.

- [The model](#the-model)
- [Quick start](#quick-start)
- [Placement: the `alloc` argument](#placement-the-alloc-argument)
- [Containers](#containers)
- [When to use an explicit allocator](#when-to-use-an-explicit-allocator)
- [Threads and async tasks](#threads-and-async-tasks)
- [Writing your own allocator](#writing-your-own-allocator)
- [The low-level `Allocator` API](#the-low-level-allocator-api)
- [Debugging: the leak report](#debugging-the-leak-report)
- [Cost](#cost)
- [Limits](#limits)

## The model

**The allocator decides placement, and reference counting decides lifetime.**
These are two separate concerns:

- An object placed by an explicit allocator is still released the moment its
  last reference dies, exactly like any other object. Nothing is freed "when
  the allocator goes away" behind your back.
- The release always returns the block to the allocator that made it. Every
  block carries its owner in a prefix in front of the returned pointer (16
  bytes, or the block's alignment when that is larger), so a block freed on another thread, or long after the code that
  created it returned, still goes back to the right place. There is no way to
  free a block into the wrong allocator.

What Yo does not check is the allocator's own lifetime: its context and
vtable must outlive every block it handed out (see
[Writing your own allocator](#writing-your-own-allocator)).

**Global by default, placement by argument.** A creation with no allocator
argument always goes to the global allocator. No caller can set an allocation scope:
what a call such as `ArrayList(i32).new()` or `rc(v)` does never depends on
its caller. Every placement in another allocator is visible at the creation
site, as one argument.

## Quick start

An `Allocator` is a value. `Allocator.global()` is the global allocator as
such a value, and [Writing your own allocator](#writing-your-own-allocator)
shows a counting one; the code below places the same way with either.

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

Point :: struct(x : i32, y : i32);

main :: (fn() -> unit)({
  a := Allocator.global();
  {
    // One cell, placed in `a` by its `alloc` argument.
    p := rc(Point(x : i32(3), y : i32(4)), alloc : .Some(a));
    // A list whose buffer, and every growth of it, lives in `a`.
    xs := ArrayList(i32).new(alloc : .Some(a));
    xs.push(p.x);
    // No argument: the global allocator.
    ys := ArrayList(i32).new();
    ys.push(p.y);
    println(`${xs.len() + ys.len()}`); // 2
  };
  // `p` and `xs` are gone, so their blocks went back to `a`.
});
export(main);
```

## Placement: the `alloc` argument

`box`, `rc` and `arc`, and the type constructors they spell (`Box(T).new`,
`Rc(T).new`, `Arc(T).new`), take an optional `alloc : Option(Allocator)`. `.Some(a)`
places the cell in `a`; the default, `.None`, places it on the global
allocator. The cell is freed through the allocator that placed it, on
whichever thread drops the last handle. Yo does not wrap a value into an
`Option`, so the caller writes `.Some(...)`:

```yo
// `a` is any `Allocator` value.
b := box(i32(1), alloc : .Some(a));
r := rc(i32(2), alloc : .Some(a));
c := arc(i32(3), alloc : .Some(a));
```

A function that lets its caller place what it creates declares the same
defaulted parameter and passes it on. `Allocator`, `Option(Allocator)` and a
struct holding one are opaque handles, so they are legal parameter types in a
safe file (one without `pragma(Pragma.AllowUnsafe)`); using the handle's raw
words, as `a.alloc(n, align)` does, still needs the pragma:

```yo
{ ArrayList } :: import("std/collections/array_list");

Node :: struct(name : i32, kids : ArrayList(i32));
make_node :: (fn(name : i32, (alloc : Option(Allocator)) ?= .None) -> Rc(Node))(
  rc(Node(name : name, kids : ArrayList(i32).new(alloc : alloc)), alloc : alloc)
);
```

Everything a program creates without such an argument is global:

- `ref` struct and `ref` enum constructors (to place one, make it a value
  struct and wrap it: `rc(v, alloc : .Some(a))`),
- the cell `dyn` makes for a value (`dyn(rc(v, alloc : .Some(a)))` places the
  `Dyn`'s data object: the `Rc` cell is used as it is, with no second cell),
- interpolated strings (build a placed one with
  `StringBuilder.new(alloc : .Some(a))`),
- closure environments,
- the state machines of `io.async` tasks,
- the runtime's own bookkeeping (event-loop structures, thread pools).

`box` calls `a`'s `alloc` directly. `rc` and `arc` make `a` the thread's
allocation scope for the one construction (until the cell primitive takes the
allocator itself), so an allocator used with `rc` or `arc` must follow the
callback rule in [Writing your own allocator](#writing-your-own-allocator).

## Containers

The mutable containers' constructors take the same defaulted
`alloc : Option(Allocator)` as `box`, `rc` and `arc`. Without it a container is
global, and so are the types built on them (`String`, an interpolation):

| Container       | Constructors taking `alloc`              | Placed copy    |
| --------------- | ---------------------------------------- | -------------- |
| `ArrayList(T)`  | `new(alloc : …)`, `with_capacity(n, alloc : …)` | `clone_in(a)` |
| `HashMap(K, V)` | `new(alloc : …)`, `with_capacity(n, alloc : …)` | `clone_in(a)` |
| `HashSet(T)`    | `new(alloc : …)`, `with_capacity(n, alloc : …)` |               |
| `Deque(T)`      | `new(alloc : …)`                           |                |
| `StringBuilder` | `new(alloc : …)`, `with_capacity(n, alloc : …)` | `clone_in(a)` |
| `String`        |                                          | `clone_in(a)`  |

```yo
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  a := Allocator.global(); // any `Allocator` value
  xs := ArrayList(i32).with_capacity(usize(8), alloc : .Some(a));
  xs.push(i32(1));
  ys := xs.clone_in(Allocator.global()); // a copy placed explicitly
  ys.push(i32(2));
});
export(main);
```

A container remembers its allocator. Every growth, shrink and final release of
its buffer goes back to the allocator it was created with. `xs.allocator()`
returns that allocator, or `.None` for a container on the global allocator. A
`clone()` lands where its source lives: the clone of a list, map or `String` in
an explicit allocator is in the same allocator, and the clone of a global
container is global. `clone_in(a)` puts the copy's buffer in `a` instead,
wherever the source lives; the copied elements go wherever their own `clone`
puts them.

A placed container allocates once at construction (an `ArrayList`, `Deque` or
`StringBuilder` takes a block holding only the owner prefix, a `HashMap` its
16 buckets), because its buffer is how it remembers the allocator. A global
`new()` allocates nothing until the first insertion.

**Before v0.2.73** the placed constructors were separate functions. They are
deleted; rewrite each call:

| Before                                | Now                                            |
| ------------------------------------- | ---------------------------------------------- |
| `ArrayList(T).new_in(a)`              | `ArrayList(T).new(alloc : .Some(a))`           |
| `ArrayList(T).with_capacity_in(a, n)` | `ArrayList(T).with_capacity(n, alloc : .Some(a))` |
| `HashMap(K, V).new_in(a)`             | `HashMap(K, V).new(alloc : .Some(a))`          |
| `HashSet(T).with_capacity_in(a, n)`   | `HashSet(T).with_capacity(n, alloc : .Some(a))` |
| `Deque(T).new_in(a)`                  | `Deque(T).new(alloc : .Some(a))`               |
| `StringBuilder.new_in(a)`             | `StringBuilder.new(alloc : .Some(a))`          |

The container's own size does not change: the allocator is recorded in the
owner prefix of its buffer, with one bit of an existing word marking it.

## When to use an explicit allocator

Under reference counting an allocator changes **where** bytes come from, not
how much memory-management work runs: every reference-count update and every
release still happens. What it does buy:

- **Accounting.** A counting allocator shows what a library, a subsystem or a
  test allocates and whether all of it came back.
- **Budgets.** An allocator may refuse a request by returning `.None`; the
  `try_` container operations report that as `AllocError.OutOfMemory`.
- **Locality.** An allocator that hands out blocks from one region keeps a
  piece of work's objects next to each other.

It is not a general speedup: the global allocator (mimalloc) is already fast
on its fast path, so measure before expecting a win.

std ships no arena today. `std/arena` was deleted on 2026-10-24; a
`FixedBufferAllocator` and an `ArenaAllocator` are planned
(`plans/backlog/ZIG_STYLE_ALLOCATORS.md`). Until then, write the allocator you
need as in [Writing your own allocator](#writing-your-own-allocator).

## Threads and async tasks

`Allocator` is two words and `Send`, so one allocator may serve several threads
as long as its own callbacks are thread-safe. Pass the `Allocator` value into
the thread and place there:

```yo
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");

Point :: struct(x : i32, y : i32);

main :: (fn() -> unit)({
  a := Allocator.global(); // any `Allocator`: it is `Send`
  t := Thread(i32).spawn(io => {
    p := rc(Point(x : i32(1), y : i32(2)), alloc : .Some(a));
    p.x + p.y
  });
  println(`${t.join()}`);
});
export(main);
```

**A task is always global.** The state machine of an `io.async` task lives on
the global allocator. What the task creates is placed by its own creation
sites, as anywhere else.

## Writing your own allocator

An allocator is a context pointer plus a table of three functions. Both types
are in the prelude, so they need no import; their methods (`Allocator.global()`,
`alloc`, `free`, …) come with `std/allocator`:

```yo
AllocatorVTable :: struct(
  alloc : (fn(ctx : ?*void, size : usize, align : usize) -> ?*void),
  realloc : (fn(ctx : ?*void, ptr : ?*void, old_size : usize, new_size : usize, align : usize) -> ?*void),
  free : (fn(ctx : ?*void, ptr : ?*void, size : usize, align : usize) -> unit)
);
Allocator :: struct(ctx : ?*void, vtable : *AllocatorVTable);
```

This is interface version 2, the calls of Zig's `std.mem.Allocator`. The
contract:

- `alloc(ctx, size, align)` returns a block of at least `size` bytes aligned
  to `align`, or `.None`. `align` is a power of two, at least 16.
- `realloc(ctx, ptr, old_size, new_size, align)` resizes a block this
  vtable's `alloc` returned for `old_size` bytes at `align`, keeping its first
  `min(old_size, new_size)` bytes. On `.None` the original block is untouched
  and still owned by the caller.
- `free(ctx, ptr, size, align)` releases such a block. `size` and `align` are
  the values the block was allocated (or last reallocated) with, so a
  size-class allocator, such as a pool, needs no header of its own.
- A block can be freed on another thread (an `Arc` dropped there), so an
  allocator shared across threads makes its `free` thread-safe.
- The callbacks must not create a reference-counted object without an
  `alloc` argument: no `ref` constructor, and no `rc`, `arc` or `dyn` without
  `alloc`. For `rc(v, alloc : .Some(a))` and `arc(v, alloc : .Some(a))` they run
  with their own allocator as the thread's allocation scope, so such an
  allocation calls back into `alloc` and recurses until the stack overflows.
  Containers, `String` and `box(...)` are global and safe to use. Get memory
  from `GlobalAllocator` or from a buffer you own, as the example below does.

Your functions never see the owner prefix: `std/allocator` asks your `alloc`
for the prefix (`max(16, align)` bytes) plus what the caller wanted, aligned
to `max(16, align)`, and manages the prefix itself. A reference-counted cell
placed by an `alloc` argument carries 16 more bytes in front of the owner,
recording the cell's size and alignment for its release, so its prefix is
`max(32, align)` bytes. Implementing an allocator handles raw pointers, so the
file needs `pragma(Pragma.AllowUnsafe);`. Using one, through an `alloc`
argument, does not.

A counting allocator that forwards to the global allocator:

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ GlobalAllocator } :: import("std/allocator");
{ memcpy } :: import("std/libc/string");

Point :: struct(x : i32, y : i32);
_Counts :: struct(allocs : usize, frees : usize);

// The global allocator's aligned family serves every alignment, and is told
// the alignment again on release.
_count_alloc :: (fn(ctx : ?*void, size : usize, align : usize) -> ?*void)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.allocs = (c.*.allocs + usize(1)));
  GlobalAllocator.aligned_alloc(align, size)
});
_count_realloc :: (fn(ctx : ?*void, ptr : ?*void, old_size : usize, new_size : usize, align : usize) -> ?*void)(
  match(
    GlobalAllocator.aligned_alloc(align, new_size),
    .Some(q) => {
      n := cond((old_size < new_size) => old_size, true => new_size);
      unsafe(memcpy(q, ptr.unwrap(), n));
      GlobalAllocator.aligned_free(ptr);
      .Some(q)
    },
    .None => .None
  )
);
_count_free :: (fn(ctx : ?*void, ptr : ?*void, size : usize, align : usize) -> unit)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.frees = (c.*.frees + usize(1)));
  GlobalAllocator.aligned_free(ptr);
});
_COUNT_VTABLE := AllocatorVTable(alloc : _count_alloc, realloc : _count_realloc, free : _count_free);

main :: (fn() -> unit)({
  counts := _Counts(allocs : usize(0), frees : usize(0));
  a := Allocator(ctx : .Some((*void)(addr_of(counts))), vtable : addr_of(_COUNT_VTABLE));
  {
    p := rc(Point(x : i32(3), y : i32(4)), alloc : .Some(a));
    println(`${p.x}`);
  };
  println(`allocs=${counts.allocs} frees=${counts.frees}`); // allocs=1 frees=1
});
export(main);
```

The vtable must outlive every block it handed out, which a module-level `:=`
binding does. The context must too: here `counts` lives until `main` returns,
after the inner block released `p`.

## The low-level `Allocator` API

These all need `pragma(Pragma.AllowUnsafe);`, because they hand out or take
raw pointers:

| Call                            | What it does                                                         |
| ------------------------------- | -------------------------------------------------------------------- |
| `Allocator.global()`            | The global allocator as an `Allocator` value.                        |
| `a.alloc(size, align)`          | `size` bytes owned by `a`, aligned to `align` (at least 16), or `.None`; `.None` too for an `align` that is not a power of two. |
| `Allocator.realloc(ptr, old_size, new_size, align)` | Resize a block through the allocator that owns it.                   |
| `Allocator.free(ptr, size, align)` | Release a block to the allocator that owns it. `.None` is a no-op.   |
| `Allocator.owner_of(ptr)`       | The allocator that owns a block.                                     |
| `a.same(b)`                     | Whether two values are the same allocator.                           |

`realloc` and `free` find the allocator through the owner prefix, so they take
no allocator; they take the size and alignment the block was allocated with,
which they pass on to it. Never pass them a pointer that did not come from
`Allocator.alloc`/`realloc`, or a size or alignment other than the block's,
and never release such a block with `GlobalAllocator.free`.

## Debugging: the leak report

Compile with `--allocator fixed --debug-heap` and the exit report counts the
heap blocks still live at exit (`live at exit: N blocks / M bytes`), including
the ones a user allocator obtained from the global allocator:

```bash
yo compile main.yo --allocator fixed --debug-heap -o app && ./app
```

`yo test` takes the same flags. A counting allocator in front of the global
one tells which subsystem a leaked block came from.

## Cost

A `ref` constructor, a `dyn` box and an `io.async` task still check the
thread's allocation scope that `rc` and `arc` set for one construction: one
relaxed atomic load and a branch, measured within noise on the compiler's own
self-compile (`plans/archive/EXPLICIT_ALLOCATORS.md`). That check is removed
once `rc` and `arc` place through the cell primitive
(`plans/backlog/ALLOCATOR_PLACEMENT.md`, B2). Containers keep their size,
because the allocator lives in the buffer's prefix rather than in a new field.

## Limits

- **No arena in std.** See
  [When to use an explicit allocator](#when-to-use-an-explicit-allocator).
- **Over-aligned types.** `Allocator.alloc` and the containers ask for the
  element type's alignment, so an allocator can serve any power of two. `box`
  still asks for 16, so a `Box` of a type aligned more strictly than that is
  not supported yet. No Yo type is aligned above 16 today; an `extern` C type
  can be.
- **No placed `ref` objects.** A `ref` constructor takes no `alloc`
  argument. Make the type a value struct and place it with
  `rc(v, alloc : .Some(a))`.

The design record, with measurements and the phase-by-phase history, is
`plans/archive/EXPLICIT_ALLOCATORS.md`. The landed decisions are summarized in
`plans/reference/EXPLICIT_ALLOCATORS.md`, and the placement rules ("global by
default, placement by argument") in `plans/backlog/ALLOCATOR_PLACEMENT.md`.
