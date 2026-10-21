# Zig's allocator catalog in Yo: `std/heap`, and the real arena

**Status: BACKLOG — drafted 2026-10-21 at the maintainer's request** ("I
was expecting we have real arena … I expect Yo to have all the kinds of
allocators that Zig supports, such as page_allocator, FixedBufferAllocator,
ArenaAllocator, SmpAllocator, c_allocator"). Nothing here is started. It
builds on three landed or queued pieces and changes none of them:
`plans/reference/EXPLICIT_ALLOCATORS.md` (the `Allocator` value, the owner
prefix, the scope), the allocator interface version 2 queued after V2b
(`plans/VALUES_BY_DEFAULT.md` §6 "After V2b: the allocator interface,
version 2"), and `plans/backlog/REFERENCES_AND_ORIGINS.md` (the `Origin`
kind), which is what makes the real arena typeable. It supersedes the
"not possible without lifetimes" half of
[`ARENA_ALLOCATOR_FEASIBILITY.md`](ARENA_ALLOCATOR_FEASIBILITY.md) §0 (3)
and §4.3 (Option C′), whose analysis stays the record of why the DYNAMIC
forms cannot drop reference counting.

## 0. Verdict

1. **Every allocator in Zig's `std.heap` is buildable in Yo**, as a std
   library over the version-2 `Allocator` interface, with no compiler
   change: `PageAllocator`, `FixedBufferAllocator`, `ArenaAllocator`,
   `CAllocator`, `DebugAllocator`, `FailingAllocator`, `LoggingAllocator`,
   `ThreadSafeAllocator`, `StackFallbackAllocator`, `MemoryPool(T)` (§3).
   The version-2 interface (alignment on `alloc`/`realloc`, size and
   alignment on `free`) is the one prerequisite: today's `alloc(ctx, size)`
   cannot serve a page-aligned or a header-free block, which is exactly why
   the maintainer queued version 2 on 2026-10-13.
2. **`SmpAllocator` is the one that is a project, not a library addition.**
   Zig's is a lock-free, per-thread general-purpose allocator for
   release builds. Yo already ships two general-purpose allocators (mimalloc
   and the TLSF `fixed` region) and routes cross-thread frees by owner, so
   the honest first step is to expose the TLSF heap as a `TlsfAllocator`
   over any backing allocator; a thread-local-slab `SmpAllocator` is then a
   measured follow-up against mimalloc, with a go/no-go (§3.9).
3. **"Real arena" means two different things, and Yo gets both — on two
   different dates.**
   - *Zig's `ArenaAllocator` as an `Allocator` value*: chunks from a backing
     allocator, `reset`, free-all at `deinit`. In the reference-counted
     model this is `std/arena` with a backing allocator and growable chunks
     (D8 in the landed record), and `deinit`/`reset` keep the landed rule:
     a **panic** while a block is still live, because an RC handle may still
     point into the region (§2). That is the checked arena, sound today,
     and it is NOT what the maintainer means by "real".
   - *A real arena* — bump allocation, no per-object count, no per-object
     free, free-all at scope end, a dangling handle a compile error — is
     Rust's `bumpalo` and needs the handle's lifetime to be a static
     property. `ARENA_ALLOCATOR_FEASIBILITY.md` rejected that in 2026-09
     because "lifetimes on types are refused by design". Decision 43's
     amendment reversed the premise: a reference is `&(T, p)` with `p` a
     declared place set. An arena is a place, and `arena.alloc(v)` returns
     `&mut(T, arena)`: a borrow the checker already knows how to freeze the
     arena under (O3: `reset`/`deinit` take `&mut self`, an access to
     `arena`, E0911 while any `&(T, arena)` lives), that cannot be stored
     where `arena` is out of scope (O4), and that is not `Escapable` (O10),
     so it never reaches an `Rc`, a global or another thread. No count, no
     header, no runtime check — the cycle collector never sees the arena
     because nothing in it is a cell. That is §4, phased at
     REFERENCES_AND_ORIGINS N2 (first-class storage), and it is the
     answer to the "is it possible, given the runtime" question: yes,
     because the arena's values are not runtime-managed at all.
4. **The cycle collector is not in the way.** It governs reference-counted
   cells. Every allocator in §3 serves cells by placement (the landed
   model: a cell placed by any allocator carries the owner prefix and is
   freed through it when its count reaches zero, by the collector or by a
   drop); the real arena of §4 serves no cells. The one interaction is
   `Drop`: a real arena runs no destructors at reset unless it walks a
   typed list (§4.3), the same choice `bumpalo` makes.

## 1. What exists, and what each Zig allocator maps to

| Zig | Yo today | Gap |
| --- | --- | --- |
| `std.mem.Allocator` (vtable + ctx) | `Allocator { ctx, vtable }`, `AllocatorVTable(alloc, realloc, free)` in `std/allocator.yo`; a scope (`with_allocator`) instead of an allocator parameter on every call | version 2: alignment, sized `free` (queued) |
| `page_allocator` | none; `--allocator` picks the process heap | §3.1 |
| `FixedBufferAllocator` | `std/arena` is a bump region with a checked end, over a heap-allocated region of fixed size | over a caller-provided buffer; `reset`; §3.2 |
| `ArenaAllocator` (chunks over a backing allocator) | `std/arena` (one region, no backing allocator: D8 "out of scope") | backing allocator, growable chunks, `reset` modes; §3.3 |
| `c_allocator` / `raw_c_allocator` | `GlobalAllocator` IS libc under `--allocator system`, but not under `mimalloc` or `fixed` | an allocator that is libc whatever `--allocator` says; §3.4 |
| `smp_allocator` (0.14) | `--allocator mimalloc` (process-wide); the TLSF `fixed` region | a Yo-written general-purpose allocator as an `Allocator` value; §3.9 |
| `GeneralPurposeAllocator` / `DebugAllocator`, `std.testing.allocator` | `--allocator fixed --debug-heap` (leak oracle at exit); `--sanitize leak` (Linux only) | `ZIG_ADOPTION_CANDIDATES.md` Z11: `--allocator debug` and `yo test --allocator debug`; §3.5 |
| `FailingAllocator` | none | §3.6 |
| `LoggingAllocator`, `ScopedLoggingAllocator` | none | §3.7 |
| `ThreadSafeAllocator` | every arena locks itself (D3) | a wrapper for allocators that do not; §3.8 |
| `StackFallbackAllocator` | none | §3.2 |
| `MemoryPool(T)` | none | needs sized `free`; §3.10 |
| `wasm_allocator` | the C heap through emscripten | `PageAllocator` on `memory.grow`; §3.1 |
| a real arena (`bumpalo`) | none, rejected in 2026-09 | §4, at origins N2 |

## 2. Why `std/arena` is not Zig's arena, and must not be

Zig's `ArenaAllocator.deinit` frees every chunk, and a pointer still held
into one is a use-after-free the language does not detect. Yo's `Arena`
serves reference-counted cells and container buffers whose owners are
ordinary values anywhere in the program: an `Rc` handle copied out of the
scope, a `String` moved into a global, a task's state machine. The landed
design therefore makes `deinit` **panic while any block is live**
(`plans/reference/EXPLICIT_ALLOCATORS.md`), and
`ARENA_ALLOCATOR_FEASIBILITY.md` §3.3 records why a silent free-all is
unsound in this model: a buffer that grew inside the scope belongs to an
owner outside it. Every allocator in §3 keeps that rule. What changes the
rule is not a different allocator but a different kind of handle — one
whose type says it cannot leave the scope. That is §4.

Two consequences the plan keeps explicit:

- **Placement, not lifetime** stays the model for every `Allocator` value
  (§3). An `Allocator` never frees a block ahead of its last reference.
- **Reset is a checked operation.** `ArenaAllocator.reset` and
  `FixedBufferAllocator.reset` panic while a block is live, as `deinit`
  does today, with the same message shape and the same `--debug-heap`
  listing. `abandon()` stays the process-lifetime escape.

## 3. The catalog, on the version-2 interface

All of it is std, under one directory, `std/heap/` (Zig's name; `std/arena`
moves there as `std/heap/arena.yo` with a re-export at the old path until
the next seed carries the move, per the seed rule in AGENTS.md). Each
allocator is an `Allocator` value made by a `.allocator()` method on a
state value, as `Arena` does today; each is usable with `with_allocator`,
`new_in`/`with_capacity_in`, and `Allocator.alloc`/`free` under
`pragma(Pragma.AllowUnsafe)`. The owner prefix (16 bytes, or `max(16,
align)` under version 2) stays on every block an explicit allocator hands
out; that is the cost of frees routing by owner, accepted in the landed
design.

### 3.1 `PageAllocator`

`mmap`/`munmap` (POSIX), `VirtualAlloc`/`VirtualFree` (Windows),
`memory.grow` (wasm; no free, as Zig's `wasm_allocator`). Every block is
page-aligned and page-sized up; `realloc` is `mremap` where it exists and
copy elsewhere. It is the backing allocator the others default to. It
needs version 2 for the alignment it promises; before version 2 it can
exist with the 16-byte contract, which is what blocks §3.10's pools.
Thread-safe by construction (the kernel's). One module-level value,
`PAGE_ALLOCATOR`, like Zig's `page_allocator`.

### 3.2 `FixedBufferAllocator` and `StackFallbackAllocator(N)`

A bump allocator over a caller-provided region: `FixedBufferAllocator.new(buf : &mut Array(u8, N))`
or over a raw slice under `AllowUnsafe`. `free` reclaims only the most
recent block (Zig's rule, and `std/arena`'s today); `reset()` is the
checked reset of §2. `thread_safe_allocator()` is Zig's atomic-bump
variant. Today's `std/arena` is this allocator over a region it
`malloc`s itself, plus the generation-stamped state table that makes a
stale handle panic instead of touching freed memory; that table is kept
(it is what makes the handle rules checkable without lifetimes) and the
region becomes an argument.

`StackFallbackAllocator(N)`: an inline `Array(u8, N)` served first, a
fallback allocator after; Zig's `stackFallback(N, fallback)`. In Yo the
buffer lives in the owner's value (a struct field), so the allocator state
is move-only and the `Allocator` value it hands out is valid until the
state's last use — a place rule the current scope design already has for
`Arena` handles (a stale `Allocator` reaches a released state and panics).

### 3.3 `ArenaAllocator`

Zig's: a linked list of chunks from a backing allocator, growing
geometrically; `reset(.free_all | .retain_capacity | .retain_with_limit)`;
`deinit` frees every chunk. Yo's: the same chunk list over any
`Allocator` (this lands D8's "explicit backing-allocator parameter"), the
same three reset modes, and the §2 rule on `reset` and `deinit`. The
bookkeeping that today's `Arena` keeps per block (the live count, the
most-recent-block offset for in-place `realloc`) carries over per chunk.
Cross-thread: an `Arc` placed in an arena may be dropped on another
thread, so the arena stays self-locking (D3), as today.

### 3.4 `CAllocator`

libc `malloc`/`free`/`aligned_alloc`, whatever `--allocator` the program
was built with. Its uses: a buffer handed to a C library that will `free`
it (or that was `malloc`ed by C and must be freed by C), and escaping the
fixed region for one allocation under `--allocator fixed`. Under
`--allocator fixed` the global family is NOT libc (the region has one
family, `std/allocator.yo`'s table), so `CAllocator` is the only way to
reach libc there, and the owner prefix is what keeps a `CAllocator` block
from ever entering the region's `free`. A `RawCAllocator` (Zig's
`raw_c_allocator`, no alignment handling) is not needed: version 2 carries
the alignment.

### 3.5 `DebugAllocator`, `--allocator debug` and `yo test --allocator debug`

`ZIG_ADOPTION_CANDIDATES.md` Z11, adopted there with a "medium, high
value" verdict; it is listed here because it is the allocator most users
of the catalog reach for first. Two faces of one thing: a `DebugAllocator`
value (a tracking wrapper over any backing allocator: per-block site and
size, freed blocks poisoned and quarantined, double-free and size-mismatch
aborts, a leak table at exit) and `--allocator debug`, the same tracker as
the process allocator, with `yo test --allocator debug` failing a test
that ends with live blocks — `std.testing.allocator`. The allocation site
comes from Z4's `source_location`; until Z4 lands the table carries the
type name and size. It works on every platform, including the ones where
AddressSanitizer is hollow, which is why the leak gates in the tree are
waiting for it.

### 3.6 `FailingAllocator`

A wrapper that returns `null` after N allocations (`fail_index`), with
`resize` and `remap` failures as separate counters, for testing
out-of-memory paths — the `AllocError` the interface already defines. It
is also the harness that makes the "an allocation through a released
arena panics" tests deterministic.

### 3.7 `LoggingAllocator`

A wrapper that writes one line per `alloc`/`realloc`/`free` to a `Writer`
(`std/io`), with the success/failure branch at a configurable level. The
`--debug-heap` exit report is the batch form; this is the streaming one.

### 3.8 `ThreadSafeAllocator`

A mutex around any allocator whose `free` is not thread-safe. The landed
rule, "a block can be freed on another thread, so an allocator shared
across threads must make its `free` thread-safe", is what makes this
wrapper necessary for a `FixedBufferAllocator` shared by value across a
`Thread.spawn`; the arena allocators lock themselves and do not need it.

### 3.9 `TlsfAllocator`, then `SmpAllocator` (measured)

The TLSF heap behind `--allocator fixed` is a complete general-purpose
allocator written in the emitted C (`src/codegen/c/allocator_fixed.yo`),
O(1), bounded fragmentation, with aligned allocation and the maximality
invariant stress-tested. Step one exposes it as `TlsfAllocator.new(region)`
over any backing allocator's block (a page from §3.1, a static array): a
general-purpose allocator as an `Allocator` value, which is the building
block Zig's `SmpAllocator` and `GeneralPurposeAllocator` are made of. It
is single-threaded unless wrapped (§3.8), exactly like Zig's.

`SmpAllocator` proper is Zig's 0.14 design: per-thread size-class slabs,
a global free list for cross-thread frees, no locks on the fast path. Yo's
frees already route by owner prefix, so a remote free can push onto the
owning thread's list without the vtable knowing. The honest position: Yo
has mimalloc, which is this design done by a team that benchmarks it for a
living, and `--allocator mimalloc` is one flag. A Yo-written `SmpAllocator`
is justified only if it wins on a measured workload where mimalloc cannot
be used (a freestanding target, where `fixed` is today's answer) or if it
beats mimalloc on the compiler's own allocation profile (CP0's counters).
It is phase A5 with a go/no-go, not a commitment.

### 3.10 `MemoryPool(T)`

A size-class pool for one type: a free list threaded through free slots,
no per-block header, `create() -> ?*T` / `destroy(*T)` under
`AllowUnsafe`, and `Box(T)` placement through the scope for safe code. It
is the one allocator that strictly needs version 2's sized `free` (a pool
has no header to read the size from), which is why it is the last
library item.

## 4. The real arena: an origin, not an allocator

### 4.1 What it is

```yo ignore
{ Arena } :: import("std/heap/bump");
parse :: (fn(src : &String) -> Ast)({
  mut(arena) := Arena.new(PAGE_ALLOCATOR);            // chunks from any backing allocator
  tokens := tokenize(src, &arena);                    // -> View(Token, arena): a slice of arena memory (§4.4)
  tree := build(tokens, &arena);                      // the root is &(Node(arena), arena); children too
  tree.to_owned()                                     // copies out what outlives the arena
});                                                   // arena dropped: one free per chunk, no walk
```

- `Arena.alloc(self : &Self, v : T) -> &mut(T, self)` — the declared
  origin is the arena's place. A node type that holds children spells it:
  `Node :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(kind : Kind, kids : ArrayList(&(Node(p), p))))`.
  Nothing allocated in the arena has a count or a header; `alloc` is a
  bump and a copy.
- **Lifetime is the checker's.** `reset`/`deinit` take `&mut self`, an
  access to the arena's place, so they are E0911 while any `&(T, arena)`
  is live (O3 step 2); dropping the arena with a handle live is the same
  error; a `&(T, arena)` cannot be returned past the frame that owns
  `arena` (the return rule), stored where `arena` is out of scope (O4), or
  placed in an `Rc`, a global or a spawned task (O10, `Escapable`). The
  `to_owned` copy at the end is spelled, as everything else in Yo is.
- **`alloc` through a `&Self` receiver.** Allocation must not freeze the
  whole arena exclusively (every node would conflict with every other), so
  the bump pointer is interior state: a `Cell`-like field the arena writes
  through `&self` — the same `RefCell`-free interior write `Mutex.lock`
  does on its atomic. It is the one place the design leans on
  `AllowUnsafe` inside std, as every allocator does.
- **No cycle collector involvement.** Arena values may point at each other
  freely (`kids` above); nothing is counted, so a cycle among arena values
  costs nothing and leaks nothing: the chunks go at `deinit`. That is the
  property Rust's `bumpalo` has and Yo's `Rc` graphs do not.

### 4.2 What it needs from the language

Only what `REFERENCES_AND_ORIGINS.md` already plans: N1's `&(T, p)` and
the checking rules, N2's first-class storage (an `ArrayList(&(Node, p))`
inside an arena-allocated struct). No new kind, no new rule. The
`ARENA_ALLOCATOR_FEASIBILITY.md` Option C′ machinery (a `ctl`-like
frame-boundness walk, a viral type marker) is not built: origins are that
walk, generalized.

### 4.3 `Drop` and the typed walk

`bumpalo` runs no destructors; Zig's arena runs none. Position: the same,
by a bound — `alloc` requires `T <: TrivialDrop`, a structurally derived
prelude marker (no `Drop` impl, no `Rc`/`Arc`/`Box`/buffer-owning field),
so an arena value can hold integers, `&(T, arena)` references and
`Copy` data, and never a `String` or an `Rc`. A second entry point,
`alloc_dropping`, records a `(type id, offset)` pair per block in a side
list and runs the drops in a linear walk at `reset`/`deinit` — Option C′'s
4–8-byte prefix, opt-in per allocation, so the common case stays
header-free. Both entry points are decided here; `alloc_dropping` may land
in a later PR than `alloc`.

### 4.4 Allocating containers in the arena

Two shapes, both legal, deliberately different:

- `ArrayList(T).new_in(arena.allocator())` — §3's model: the buffer is a
  counted-owner block in the arena's chunks, routed back by its prefix,
  checked at `deinit`. Placement.
- `arena.alloc_list(n) -> View(T, arena)` — a fixed-capacity slice of
  arena memory with the arena's origin, no owner, no prefix. Lifetime by
  type. `View(T, p)` is RUST_ADOPTION_CANDIDATES L1's borrowed view, which
  N2 lands in std.

The first exists from phase A3; the second from A4.

## 5. Phases

| Phase | Lands | Needs | Gate |
| --- | --- | --- | --- |
| A0 | the allocator interface, version 2 (alignment; sized `free`) — already queued in `VALUES_BY_DEFAULT.md` §6 after V2b; this plan adds nothing to it | V2b | that item's tests |
| A1 | `std/heap/`: `PageAllocator`, `FixedBufferAllocator` (+ the thread-safe variant, `StackFallbackAllocator`), `CAllocator`, `FailingAllocator`, `LoggingAllocator`, `ThreadSafeAllocator`; `std/arena` moves and becomes `FixedBufferAllocator` over a heap region | A0 for page alignment (the rest can land on version 1 with the 16-byte contract) | each allocator's unit tests; every existing arena and counting-allocator test; a cli-case under `--allocator fixed` using `CAllocator` |
| A2 | `DebugAllocator`, `--allocator debug`, `yo test --allocator debug` (Z11) | Z4 for sites, optional | the leak gates in the tree switch to it; a double-free and a size-mismatch abort test |
| A3 | `ArenaAllocator` over a backing allocator with the three reset modes; `TlsfAllocator` over a region | A1 | reset-while-live panics; `Arc` dropped on another thread into an arena chunk; TLSF's stress harness over a page block |
| A4 | the real arena (§4): `std/heap/bump.yo`, `alloc` with `TrivialDrop`, `alloc_list`, `alloc_dropping` | REFERENCES_AND_ORIGINS N2 | a dangling arena handle is E0911 at `reset`, at drop and at return; a cycle among arena values frees with the chunks; a tokenizer benchmark against `std/arena` and the global heap, numbers recorded here |
| A5 | `SmpAllocator`, go/no-go | A3, CP0's counters | ≥ mimalloc on the compiler's allocation profile, or a freestanding target that needs it; otherwise archived with its numbers |
| A6 | `MemoryPool(T)` | A0 | header-free create/destroy; pool exhaustion returns `AllocError` |

Each phase is one PR, Generation A where the compiler is touched (A2's
flag; the `std/arena` move's re-export), library-only otherwise. Docs:
`docs/en-US/EXPLICIT_ALLOCATORS.md` and `MEMORY_SAFETY.md` gain a catalog
section, in both languages, per phase.

## 6. Open questions, with positions

- **`std/heap/` or flat `std/`?** Position: `std/heap/`, Zig's name, with
  `std/arena` re-exported for one seed.
- **Should `with_allocator` scopes accept the real arena?** No: the scope
  places counted cells, the real arena holds uncounted values; mixing them
  through one `Allocator` value would reintroduce the §2 hazard. The real
  arena has no `.allocator()` method.
- **Is `TrivialDrop` a new marker or `Copy`?** `Copy` is too narrow (a
  `&mut(T, arena)` holder is not `Copy`, an arena node with a `&mut` child
  must be allocatable). Position: a new structural marker, derived like
  `Send`; name open.
- **Should `alloc` take the value or build in place?** Rust's `bumpalo`
  takes the value (a copy into the bump pointer). A placement form
  (`alloc_with(f)`) is a later addition if the copy shows up in A4's
  benchmark.
- **Alignment of arena values.** Version 2's `align` applies; before it,
  `align_of(T)` rounded to 16, as every block today.
- **Does the real arena need `Send`?** No: `&(T, arena)` is never `Send`
  (O4), and the arena state is move-only and not shared. A per-thread
  arena is one arena per thread.
