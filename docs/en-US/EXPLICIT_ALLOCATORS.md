# Explicit Allocators

Yo manages memory with reference counting: an object dies when its last
reference goes away. An **explicit allocator** adds a second, independent
choice: **where** the object's bytes live. You can put a whole computation's
objects in one arena, count every allocation a library makes, or give a
subsystem its own memory budget, without changing how the objects are used or
when they are freed.

- [The model](#the-model)
- [Quick start](#quick-start)
- [The allocation scope: `with_allocator`](#the-allocation-scope-with_allocator)
- [Containers](#containers)
- [Arenas: `std/arena`](#arenas-stdarena)
- [When to use an arena](#when-to-use-an-arena)
- [Threads and async tasks](#threads-and-async-tasks)
- [Writing your own allocator](#writing-your-own-allocator)
- [The low-level `Allocator` API](#the-low-level-allocator-api)
- [Debugging: the leak report](#debugging-the-leak-report)
- [Cost](#cost)
- [Limits](#limits)

## The model

**The allocator decides placement, and reference counting decides lifetime.**
These are two separate concerns:

- An object placed in an arena is still released the moment its last
  reference dies, exactly like any other object. Nothing is freed "when the
  arena goes away" behind your back.
- The release always returns the block to the allocator that made it. Every
  block carries its owner in a 16-byte prefix in front of the returned
  pointer, so a block freed on another thread, or long after the code that
  created it returned, still goes back to the right place. There is no way to
  free a block into the wrong allocator.

This is what makes explicit allocators safe in Yo where they are a common
source of bugs elsewhere. In Zig, freeing an arena while something still points
into it is a use-after-free. In Yo, `Arena.deinit()` **panics** while any block
is still live, so the mistake is a loud, defined failure.

None of this needs new syntax. `Point(...)` is the same constructor call inside
and outside an allocation scope; only where its bytes come from changes.

## Quick start

```rust
{ println } :: import("std/fmt");
{ Arena } :: import("std/arena");
{ with_allocator } :: import("std/allocator");
{ ArrayList } :: import("std/collections/array_list");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  arena := Arena.new(usize(1) << usize(20)); // one 1 MiB region
  {
    // Every RC object and container buffer created in the scope lives in the arena.
    p := arena.scoped(() => Point(x : i32(3), y : i32(4)));
    xs := with_allocator(arena.allocator(), () => {
      ys := ArrayList(i32).new(); // follows the scope
      ys.push(i32(1));
      ys
    });
    // Outside a scope, name the allocator explicitly.
    zs := ArrayList(i32).new_in(arena.allocator());
    zs.push(i32(2));
    println(`live blocks: ${arena.live_blocks()}`);
  };
  // `p`, `xs` and `zs` are gone, so their blocks went back to the arena.
  println(`live blocks: ${arena.live_blocks()}`); // 0
  arena.deinit(); // fine: nothing is live
});
export(main);
```

## The allocation scope: `with_allocator`

`with_allocator(a, f)` (`std/allocator`) makes `a` the current allocator on
this thread while `f` runs, including in everything `f` calls, and returns
`f`'s result. `arena.scoped(f)` is the same call with the arena's allocator.
The previous allocator is restored when `f` returns or unwinds, so scopes nest.

Inside a scope, these come from `a`:

- `ref` struct and `ref` enum constructors,
- `box` and `arc`,
- `dyn` boxes,
- `Iso` values,
- the state machines of `io.async` tasks created there,
- the buffers of the `imm` collections,
- the buffers of the mutable containers created there (see
  [Containers](#containers)).

These stay on the global allocator:

- the runtime's own bookkeeping (event-loop structures, thread pools),
- objects created outside the scope, even if they are later used inside it.

`current_allocator()` returns the allocator a scope made current, or `.None`
when no scope is active (the global allocator).

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
container on the global allocator.

A `String` copy shares its source's buffer until one of them writes
(copy-on-write). The clone that first write makes goes to the allocator of the
shared buffer, like `ArrayList.clone`, not to the current scope: a copy of an
arena-built string written after the scope has ended still clones into the
arena.

The container's own size does not change: the allocator is recorded in the
owner prefix of its buffer, with one bit of an existing word marking it.

## Arenas: `std/arena`

`Arena` is a bump allocator over one contiguous region.

| Method                 | What it does                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `Arena.new(capacity)`  | An arena over a region of `capacity` bytes (rounded up to 16). Panics if the region cannot be allocated. |
| `arena.allocator()`    | The arena as an `Allocator` value, to pass to `with_allocator` or `new_in`.  |
| `arena.scoped(f)`      | `with_allocator(arena.allocator(), f)`.                                      |
| `arena.live_blocks()`  | Blocks allocated here and not yet freed.                                     |
| `arena.used_bytes()`   | Bytes of the region in use (the bump offset).                                |
| `arena.capacity()`     | The region's size in bytes.                                                  |
| `arena.is_released()`  | Whether `deinit` or `abandon` has run.                                       |
| `arena.deinit()`       | Release the region. **Panics** if any block is still live. Also runs when the last `Arena` handle dies. |
| `arena.abandon()`      | Stop tracking and never release the region. `deinit` becomes a no-op.        |

Behavior worth knowing:

- **Freeing reclaims space only at the top.** Freeing the most recent block
  moves the bump pointer back. Any other freed space is reclaimed when the
  whole arena is deinit. `realloc` grows the most recent block in place when
  the region has room.
- **`deinit` with live blocks panics:**
  `Arena.deinit: 1 block(s) still live (32 of 1024 bytes in use)`. Make sure
  every object placed in the arena is gone first, for example by keeping them
  in an inner block as in the quick start.
- **A stale `Allocator` copy cannot reach freed memory.** Allocating through
  an `Allocator` value after its arena was deinit panics. The arena's
  bookkeeping is never freed, so the stale copy finds a flagged state rather
  than freed memory.
- **Process-lifetime arenas call `abandon()`.** Use it for startup tables and
  interners that live until the program exits: the arena stops tracking, never
  releases its region, and `deinit` does nothing.
- **Thread-safe.** Every arena operation takes the arena's own lock, so blocks
  may be allocated and freed on any thread.

## When to use an arena

Under reference counting an arena changes **where** bytes come from, not how
much memory-management work runs: every reference-count update and every
release still happens. So an arena is not a general speedup. What it does buy:

- **A checked end for a bounded piece of work.** Parse one file, answer one
  request, run one test, build one graph in an arena, then `deinit` it. If
  anything from that work is still referenced (a cache, a global, a captured
  closure), `deinit` panics and tells you how many blocks escaped. It is an
  assertion that the work really cleaned up after itself.
- **Locality.** The work's objects sit next to each other in one region, which
  helps traversals of linked structures such as trees and graphs.
- **Budgets and accounting.** An arena has a fixed capacity, and
  `live_blocks()` / `used_bytes()` (plus the `--debug-heap` report) show what a
  subsystem is using. A counting allocator does the same for a library or a
  test.
- **Cheap allocation and release.** Allocation is a pointer bump, and a release
  is a counter decrement rather than a call into the general allocator.

When not to use one:

- **Long-running work that keeps allocating and freeing.** A bump arena only
  reclaims the most recent block; everything else freed in the middle stays
  used until `deinit`, so churn-heavy code grows without bound.
- **Data that lives for the whole program.** It can never be deinit, so it
  gains nothing over the global allocator (and `abandon()` is the only way to
  stop tracking it).
- **For raw speed alone.** The global allocator (mimalloc) is already fast on
  its fast path; measure before expecting a win.

## Threads and async tasks

**The scope is per thread.** A spawned thread starts on the global allocator,
even if it was spawned inside a scope. To use an arena in a thread, pass its
`Allocator` value in and open a scope there:

```rust
{ println } :: import("std/fmt");
{ Arena } :: import("std/arena");
{ with_allocator } :: import("std/allocator");
{ Thread } :: import("std/thread");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  arena := Arena.new(usize(1) << usize(16));
  a := arena.allocator(); // `Allocator` is `Send`; the `Arena` handle is not
  t := Thread(i32).spawn(io => {
    p := with_allocator(a, () => Point(x : i32(1), y : i32(2)));
    (p.x + p.y)
  });
  println(`${t.join()}`);
});
export(main);
```

`Allocator` is two words and `Send`. The `Arena` handle is reference counted
and not `Send`, so share an arena across threads through its `Allocator` value.

**A task keeps its scope.** An `io.async` task created inside `with_allocator`
resumes with the same scope after every suspension, whichever scope is current
when the event loop resumes it. Work the task does after `with_allocator` has
returned still lands in that allocator.

## Writing your own allocator

An allocator is a context pointer plus a table of three functions:

```rust
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

Your functions never see the 16-byte owner prefix: `std/allocator` asks your
`alloc` for 16 bytes more than the caller wanted and manages the prefix
itself. Implementing an allocator handles raw pointers, so the file needs
`pragma(Pragma.AllowUnsafe);`. Using one, through `with_allocator` or `new_in`,
does not.

A counting allocator that forwards to the global allocator:

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ Allocator, AllocatorVTable, GlobalAllocator, with_allocator } :: import("std/allocator");

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
  a := Allocator(ctx : .Some((*void)(&counts)), vtable : &_COUNT_VTABLE);
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

Compile with `--allocator fixed --debug-heap` and the exit report lists every
arena that was never deinit and every abandoned one, with its live blocks and
bytes in use:

```bash
yo compile main.yo --allocator fixed --debug-heap -o app && ./app
```

`yo test` takes the same flags. An arena that is still live at exit usually
means an object placed in it is still referenced from something long-lived,
such as a global or a cache.

## Cost

A program that never opens a scope pays one relaxed atomic load and a branch
per allocation site that consults the scope: the compiler's own self-compile
measured within noise (`plans/archive/EXPLICIT_ALLOCATORS.md`). Containers
keep their size, because the allocator lives in the buffer's prefix rather
than in a new field.

## Limits

- **Arenas are not nested.** An `Arena`'s region always comes from the global
  allocator; an arena backed by another arena is out of scope for now.
- **No over-aligned buffers.** Blocks are 16-aligned. Containers of types
  aligned more strictly than that are not supported, as before.
- **Runtime only.** `with_allocator` has no effect at compile time; a
  compile-time call is an extern call.

The design record, with measurements and the phase-by-phase history, is
`plans/archive/EXPLICIT_ALLOCATORS.md`. The landed decisions are summarized in
`plans/reference/EXPLICIT_ALLOCATORS.md`.
