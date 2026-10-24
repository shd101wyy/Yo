# Explicit Allocators

Yo manages memory with reference counting: an object dies when its last
reference goes away. An **explicit allocator** adds a second, independent
choice: **where** the object's bytes live. You can put a whole computation's
objects in one allocator, count every allocation a library makes, or give a
subsystem its own memory budget, without changing how the objects are used or
when they are freed.

- [The model](#the-model)
- [Quick start](#quick-start)
- [The allocation scope: `with_allocator`](#the-allocation-scope-with_allocator)
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
  block carries its owner in a 16-byte prefix in front of the returned
  pointer, so a block freed on another thread, or long after the code that
  created it returned, still goes back to the right place. There is no way to
  free a block into the wrong allocator.

What Yo does not check is the allocator's own lifetime: its context and
vtable must outlive every block it handed out (see
[Writing your own allocator](#writing-your-own-allocator)).

None of this needs new syntax. `Point(...)` is the same constructor call inside
and outside an allocation scope; only where its bytes come from changes.

## Quick start

An `Allocator` is a value. `Allocator.global()` is the global allocator as
such a value, and [Writing your own allocator](#writing-your-own-allocator)
shows a counting one; the code below places the same way with either. (A
function parameter of type `Allocator` needs `pragma(Pragma.AllowUnsafe);`
today, because the value carries raw pointers.)

```yo
{ println } :: import("std/fmt");
{ with_allocator } :: import("std/allocator");
{ ArrayList } :: import("std/collections/array_list");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  a := Allocator.global();
  {
    // Every RC object and container buffer created in the scope comes from `a`.
    p := with_allocator(a, () => Point(x : i32(3), y : i32(4)));
    xs := with_allocator(a, () => {
      ys := ArrayList(i32).new(); // follows the scope
      ys.push(p.x);
      ys
    });
    // Outside a scope, name the allocator explicitly.
    zs := ArrayList(i32).new_in(a);
    zs.push(p.y);
    println(`${xs.len() + zs.len()}`); // 2
  };
  // `p`, `xs` and `zs` are gone, so their blocks went back to `a`.
});
export(main);
```

## The allocation scope: `with_allocator`

`with_allocator(a, f)` (`std/allocator`) makes `a` the current allocator on
this thread while `f` runs, including in everything `f` calls, and returns
`f`'s result. The previous allocator is restored when `f` returns or unwinds, so scopes nest.

Inside a scope, these come from `a`:

- `ref` struct and `ref` enum constructors,
- `rc` and `arc`,
- `dyn` boxes,
- the state machines of `io.async` tasks created there,
- the buffers of the mutable containers created there (see
  [Containers](#containers)).

These stay on the global allocator:

- the runtime's own bookkeeping (event-loop structures, thread pools),
- objects created outside the scope, even if they are later used inside it.

`current_allocator()` returns the allocator a scope made current, or `.None`
when no scope is active (the global allocator).

## Placing one cell: the `alloc` parameter

`box`, `rc` and `arc` take an optional `alloc : Option(Allocator)`, so one cell can
be placed without a scope. `.Some(a)` places the cell in `a`; the default,
`.None`, follows the current scope, else the global allocator. The cell is
freed through the allocator that placed it, on whichever thread drops the last
handle. Yo does not wrap a value into an `Option`, so the caller writes
`.Some(...)`:

```yo
// `a` is any `Allocator` value.
b := box(i32(1), alloc : .Some(a));
r := rc(i32(2), alloc : .Some(a));
c := arc(i32(3), alloc : .Some(a));
```

An explicit `alloc` wins over the current scope for that one cell, and the
scope is unchanged afterwards. They differ in how they reach `a`: `box` calls
`a`'s `alloc` directly, under the caller's scope, while `rc` and `arc` make `a`
the current scope for the construction, as `with_allocator` does (until the
cell primitive takes the allocator itself). So inside `a`'s callbacks
`current_allocator()` is the caller's scope for `box` and `a` for `rc` and
`arc`, and an allocator used with `rc` or `arc` must follow the callback rule in
[Writing your own allocator](#writing-your-own-allocator).

## Containers

The mutable containers follow the scope. `ArrayList.new()`,
`ArrayList.with_capacity(n)`, `HashMap.new()`, `HashMap.with_capacity(n)` and
`Deque.new()` created inside `with_allocator(a, …)` keep their buffers in `a`,
and so do the types built on them (`HashSet`, `StringBuilder`, `String`).
Outside any scope they behave exactly as before.

To choose an allocator explicitly, with or without a scope, use the `_in`
constructors:

| Container       | Explicit constructors                                    |
| --------------- | -------------------------------------------------------- |
| `ArrayList(T)`  | `new_in(a)`, `with_capacity_in(a, n)`                    |
| `HashMap(K, V)` | `new_in(a)`, `with_capacity_in(a, n)`                    |
| `HashSet(T)`    | `new_in(a)`, `with_capacity_in(a, n)`                    |
| `Deque(T)`      | `new_in(a)`                                              |
| `StringBuilder` | `new_in(a)`, `with_capacity_in(a, n)`                    |

A container remembers its allocator. Every growth, shrink and final release of
its buffer goes back to the allocator it was created with, whichever scope is
current at the time. `xs.allocator()` returns that allocator, or `.None` for a
container on the global allocator. A `clone()` lands where its source lives:
the clone of a list, map or `String` in an explicit allocator is in the same
allocator, even when no scope is active. The clone of a global container follows the current
scope, as `new()` does.

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

**The scope is per thread.** A spawned thread starts on the global allocator,
even if it was spawned inside a scope. To use an allocator in a thread, pass
the `Allocator` value in and open a scope there:

```yo
{ println } :: import("std/fmt");
{ with_allocator } :: import("std/allocator");
{ Thread } :: import("std/thread");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  a := Allocator.global(); // any `Allocator`: it is `Send`
  t := Thread(i32).spawn(io => {
    p := with_allocator(a, () => Point(x : i32(1), y : i32(2)));
    p.x + p.y
  });
  println(`${t.join()}`);
});
export(main);
```

`Allocator` is two words and `Send`, so one allocator may serve several threads
as long as its own callbacks are thread-safe.

**A task keeps its scope.** An `io.async` task created inside `with_allocator`
resumes with the same scope after every suspension, whichever scope is current
when the event loop resumes it. Work the task does after `with_allocator` has
returned still lands in that allocator.

## Writing your own allocator

An allocator is a context pointer plus a table of three functions. Both types
are in the prelude, so they need no import; their methods (`Allocator.global()`,
`alloc`, `free`, …) come with `std/allocator`:

```yo
AllocatorVTable :: struct(
  alloc : (fn(ctx : ?*void, size : usize) -> ?*void),
  realloc : (fn(ctx : ?*void, ptr : ?*void, new_size : usize) -> ?*void),
  free : (fn(ctx : ?*void, ptr : ?*void) -> unit)
);
Allocator :: struct(ctx : ?*void, vtable : *AllocatorVTable);
```

The contract:

- `alloc(ctx, size)` returns a block of at least `size` bytes aligned to 16,
  or `.None`.
- `realloc(ctx, ptr, new_size)` resizes a block this vtable's `alloc`
  returned, keeping its first `min(old, new_size)` bytes. On `.None` the
  original block is untouched and still owned by the caller.
- `free(ctx, ptr)` releases such a block. There is no size argument.
- The callbacks must not allocate through the scope: no `ArrayList.new()`,
  `String`, `box(...)` without `alloc`, or `ref` constructor inside them. They
  can run with their own allocator as the current scope (under
  `with_allocator(a, …)`, and for `rc(v, alloc : .Some(a))` and
  `arc(v, alloc : .Some(a))`), so such an
  allocation calls back into `alloc` and recurses until the stack overflows.
  Get memory from `GlobalAllocator` or from a buffer you own, as the example
  below does.

Your functions never see the 16-byte owner prefix: `std/allocator` asks your
`alloc` for 16 bytes more than the caller wanted and manages the prefix
itself. Implementing an allocator handles raw pointers, so the file needs
`pragma(Pragma.AllowUnsafe);`. Using one, through `with_allocator` or `new_in`,
does not.

A counting allocator that forwards to the global allocator:

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ GlobalAllocator, with_allocator } :: import("std/allocator");

Point :: ref(struct(x : i32, y : i32));
_Counts :: struct(allocs : usize, frees : usize);

_count_alloc :: (fn(ctx : ?*void, size : usize) -> ?*void)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.allocs = (c.*.allocs + usize(1)));
  GlobalAllocator.malloc(size)
});
_count_realloc :: (fn(ctx : ?*void, ptr : ?*void, new_size : usize) -> ?*void)(
  GlobalAllocator.realloc(ptr, new_size)
);
_count_free :: (fn(ctx : ?*void, ptr : ?*void) -> unit)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.frees = (c.*.frees + usize(1)));
  GlobalAllocator.free(ptr);
});
_COUNT_VTABLE := AllocatorVTable(alloc : _count_alloc, realloc : _count_realloc, free : _count_free);

main :: (fn() -> unit)({
  counts := _Counts(allocs : usize(0), frees : usize(0));
  a := Allocator(ctx : .Some((*void)(addr_of(counts))), vtable : addr_of(_COUNT_VTABLE));
  {
    p := with_allocator(a, () => Point(x : i32(3), y : i32(4)));
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
| `a.alloc(size)`                 | `size` bytes owned by `a`, 16-aligned, or `.None`.                   |
| `Allocator.realloc(ptr, n)`     | Resize a block through the allocator that owns it.                   |
| `Allocator.free(ptr)`           | Release a block to the allocator that owns it. `.None` is a no-op.   |
| `Allocator.owner_of(ptr)`       | The allocator that owns a block.                                     |
| `a.same(b)`                     | Whether two values are the same allocator.                           |

`realloc`, `free` and `owner_of` take only the pointer: the owner prefix tells
them which allocator to use. Never pass them a pointer that did not come from
`Allocator.alloc`/`realloc`, and never release such a block with
`GlobalAllocator.free`.

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

A program that never opens a scope pays one relaxed atomic load and a branch
per allocation site that consults the scope: the compiler's own self-compile
measured within noise (`plans/archive/EXPLICIT_ALLOCATORS.md`). Containers
keep their size, because the allocator lives in the buffer's prefix rather
than in a new field.

## Limits

- **No arena in std.** See
  [When to use an explicit allocator](#when-to-use-an-explicit-allocator).
- **No over-aligned buffers.** Blocks are 16-aligned. Containers of types
  aligned more strictly than that are not supported, as before.
- **Runtime only.** `with_allocator` has no effect at compile time; a
  compile-time call is an extern call.

The design record, with measurements and the phase-by-phase history, is
`plans/archive/EXPLICIT_ALLOCATORS.md`. The landed decisions are summarized in
`plans/reference/EXPLICIT_ALLOCATORS.md`.
