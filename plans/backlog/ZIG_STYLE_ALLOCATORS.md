# Zig's allocator catalog in Yo: `std/heap`, and the real arena

> **Trued 2026-11-07 (plans audit after VBD):** Status: BACKLOG (2026-10-21), updated 2026-11-07. A0 (interface v2: alignment, sized free) landed, and A2's `--allocator debug` landed as #1580. std/heap is not started and begins with phase C0 (§7), the root `global_allocator` declaration, moved here from ALLOCATOR_PLACEMENT step C when that plan landed (`plans/reference/ALLOCATOR_PLACEMENT.md`). The collector is deleted (decision 48 W6b). Read `with_allocator`/`new_in` as `alloc : .Some(a)`.

**Status: BACKLOG — drafted 2026-10-21 at the maintainer's request** ("I
was expecting we have real arena … I expect Yo to have all the kinds of
allocators that Zig supports, such as page_allocator, FixedBufferAllocator,
ArenaAllocator, SmpAllocator, c_allocator"). Nothing here is started; the
first phase is C0 (§7), the root `global_allocator` declaration. It
builds on three landed or queued pieces and changes none of them:
`plans/reference/EXPLICIT_ALLOCATORS.md` (the `Allocator` value, the owner
prefix, the scope), the allocator interface version 2 queued after V2b
(`plans/VALUES_BY_DEFAULT.md` §6 "After V2b: the allocator interface,
version 2"), and `plans/backlog/REFERENCES_AND_ORIGINS.md` (the `Origin`
kind), which is what makes the real arena typeable. It supersedes the
"not possible without lifetimes" half of
[`ARENA_ALLOCATOR_FEASIBILITY.md`](../archive/ARENA_ALLOCATOR_FEASIBILITY.md) §0 (3)
and §4.3 (Option C′), whose analysis stays the record of why the DYNAMIC
forms cannot drop reference counting.

**Amended 2026-10-24 (maintainer adopted the allocator verdict,
[`ALLOCATOR_PLACEMENT.md`](../reference/ALLOCATOR_PLACEMENT.md)):**

- **No scope.** `with_allocator`, `current_allocator` and `Arena.scoped`
  are deleted in that plan's B1 (v0.2.71), and the thread-local in its B2
  (v0.2.72). A creation without `alloc :` goes to the global allocator.
- **Placement by argument.** Every allocator in §3 is used through the one
  defaulted `alloc : Option(Allocator)` argument that `rc`/`box`/`arc`
  have; the containers gain it in B2, which deletes
  `new_in`/`with_capacity_in`. Where a section below says "usable with
  `with_allocator`" or "through the scope", or spells `new_in(a)`, read
  `alloc : .Some(a)`.
- **The process heap is a root declaration** (phase C0, §7): `global_allocator :: heap.Mimalloc;`, `heap.System` when
  absent. `std/heap/{system,mimalloc,tlsf,debug}` are the catalog's first
  modules, each with a global face and a value face (§3.4's `CAllocator`
  is `system`'s value face, §3.9's `TlsfAllocator` is `tlsf`'s, §3.5's
  `DebugAllocator` is `debug`'s). `--allocator` on compile and build,
  `--heap-size`, `--debug-heap` and `build.AllocatorKind` are deleted
  there. `yo test --allocator debug` is the one surviving flag.
- **Rejected:** a `ctl` `Alloc` effect (§6), and the same-day "hybrid"
  draft that kept `with_allocator` as a scoped handler
  (`ALLOCATOR_PLACEMENT.md` §8, in `plans/reference/`).

**Amended 2026-10-24 (maintainer decision: `std/arena` deleted):** the
one-region `Arena` (a bump region with a generation-stamped state table,
`deinit`/`reset` panics while blocks are live, the `--debug-heap` arena
listing) is deleted, not moved. `FixedBufferAllocator` (A1) and
`ArenaAllocator` (A3) are new allocators written on this plan's terms, and
the real arena is A4. Until A1/A3 land, std ships no arena; that gap is
accepted. Every "`std/arena` moves", "re-exported" or "today's `Arena`"
below is history: there is nothing to move and no re-export (no
backward-compatibility scaffolding). Tests that used `Arena` as "some
explicit allocator" now use `Allocator.global()` or a counting allocator
defined in the test file.

**Amended 2026-10-25 (the two faces have two interfaces,
[`ALLOCATOR_PLACEMENT.md`](../reference/ALLOCATOR_PLACEMENT.md) §11):** the "global
face and value face" above are written against different interfaces.

- **The value face** is this plan's §3: a state value whose `.allocator()`
  packs `{ctx, vtable}`. It uses the `AllocatorVTable`, version 1 now and
  version 2 after A0, and its blocks carry the owner prefix.
- **The global face** is a `GlobalAlloc` impl on the declared value's type.
  `GlobalAlloc` is the libc family: `alloc` and `realloc` with an alignment,
  and an **unsized** `free` with the alignment, because global blocks are
  untagged and carry no extent. Its methods take the static as
  `state : *Self`. They are initialized lazily on first call, and they may
  create no block.

So `heap.Tlsf` (global) and §3.9's `TlsfAllocator` (value) are two
implementations of one algorithm. The global one is thread-safe (today's C
uses an `atomic_flag` spinlock), and the value one is single-threaded unless
it is wrapped (§3.8). A user writes either face the same way std does; the
examples are in `plans/reference/ALLOCATOR_PLACEMENT.md` §11.1 (the value
face) and §7.4 here (the global face). The decisions C1–C7 are in §7.3.

**Checked 2026-11-15 against the post-VBD language (at the maintainer's
request: "does it fit, and how long").** *Judgment* marks an estimate.

- **The library part fits unchanged.** A1, A3, A6 and A2's value face are
  std over the version-2 interface, which landed. The dynamic rule of §2
  (`reset` and `deinit` panic while a block is live) is still required: Yo
  keeps one `ArrayList(T)` type and routes frees by owner prefix, so a
  container placed in an arena carries no static tie to it.
- **Read these spellings as their post-VBD forms:** `View(T, p)` is a slice
  reference, `&([T], p)` or `&mut([T], p)` (decision 49); every "cycle
  collector" sentence is moot (decision 48); `Box(T)` "through the scope"
  (§3.10) is the `alloc :` argument.
- **A1 owns the one soundness decision left in the library part.** A
  `FixedBufferAllocator` over a borrowed buffer and a
  `StackFallbackAllocator` hand out an `Allocator` value, which is a
  type-erased `{ctx, vtable}` that a block's prefix stores; origins do not
  track it. So a state that dies with a block live must abort at run time,
  as the deleted `std/arena` did, and A1 must say how it knows.
- **A4 needs more than §4.2 says.** Tried on `yo 0.2.77` and a develop
  build: the arena pattern with `&(T, arena)` results checks today (several
  results live at once; `reset` beside a live result is E0911). The planned
  `alloc(self : &Self, v : T) -> &mut(T, self)` does not: the definition is
  accepted and every call is rejected
  (`issues/questions/2026-11-15-how-an-arena-lends-a-mut-reference-through-a-shared-receiver.md`).
  A4 therefore waits on three things, not one: N2c–N2f (a reference stored
  in a container or a cell is still E0909; `POST_VBD_PLAN.md` lane A,
  v0.2.80–v0.2.81), the interior-mutability question
  (`issues/questions/2026-11-11-how-the-checker-knows-a-type-is-interior-mutable.md`),
  and that new question. `reset`'s exclusivity is body-independent only
  from rule G (v0.2.79).
- **Two things are called an arena** (§0 item 3): `ArenaAllocator`, whose
  misuse is a panic, and the origin `Arena`, whose misuse is a compile
  error. *Judgment:* settle the two names so that the difference is in
  them, before A3 ships the first.
- ***Judgment*, the time,** with one agent on the lane and a release every
  two weeks:

  | Piece | Work | Notes |
  | --- | --- | --- |
  | C0 (§7: `global_allocator`), this plan's first phase | 1 to 2 weeks | seed-gated: Generation A and B in two releases |
  | A1 | 1.5 to 2.5 weeks | seven allocators, three OS back ends and wasm, the stale-state rule |
  | A2's value face, A6 | 3 to 5 days each | allocation sites wait for `source_location` |
  | A3 | 1 to 2 weeks | |
  | A4 | 3 to 5 weeks | after its three prerequisites above; includes the `TrivialDrop` marker, a compiler change |
  | A5 | 1 week | a measurement with a go/no-go; a no-go archives it |

  The library part is 6 to 8 weeks, or 3 to 4 with A1, A3 and A6 on
  separate agents (they are independent modules). The whole plan is 2.5 to
  3.5 months, and A4 sets the end date.

The sections below keep their 2026-10-21 text otherwise.

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
| `FixedBufferAllocator` | none (`std/arena`, a bump region with a checked end over a heap-allocated region, was deleted 2026-10-24) | the whole allocator, over a caller-provided buffer; `reset`; §3.2 |
| `ArenaAllocator` (chunks over a backing allocator) | none (`std/arena` deleted 2026-10-24) | the whole allocator: backing allocator, growable chunks, `reset` modes; §3.3 |
| `c_allocator` / `raw_c_allocator` | `GlobalAllocator` IS libc under `--allocator system`, but not under `mimalloc` or `fixed` | an allocator that is libc whatever `--allocator` says; §3.4 |
| `smp_allocator` (0.14) | `--allocator mimalloc` (process-wide); the TLSF `fixed` region | a Yo-written general-purpose allocator as an `Allocator` value; §3.9 |
| `GeneralPurposeAllocator` / `DebugAllocator`, `std.testing.allocator` | `--allocator fixed --debug-heap` (leak oracle at exit); `--sanitize leak` (Linux only) | `ZIG_ADOPTION_CANDIDATES.md` Z11: `--allocator debug` and `yo test --allocator debug`; §3.5 |
| `FailingAllocator` | none | §3.6 |
| `LoggingAllocator`, `ScopedLoggingAllocator` | none | §3.7 |
| `ThreadSafeAllocator` | none (the deleted `std/arena` locked itself, D3) | a wrapper for allocators that do not; §3.8 |
| `StackFallbackAllocator` | none | §3.2 |
| `MemoryPool(T)` | none | needs sized `free`; §3.10 |
| `wasm_allocator` | the C heap through emscripten | `PageAllocator` on `memory.grow`; §3.1 |
| a real arena (`bumpalo`) | none, rejected in 2026-09 | §4, at origins N2 |

## 2. Why the (deleted) `std/arena` was not Zig's arena, and §3's must not be

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

All of it is std, under one directory, `std/heap/` (Zig's name; the
2026-10-21 text moved `std/arena` there with a re-export, moot since it was
deleted 2026-10-24). Each allocator is an `Allocator` value made by a
`.allocator()` method on a state value, as the deleted `Arena` did; each is usable with `with_allocator`,
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
recent block (Zig's rule, and the deleted `std/arena`'s); `reset()` is the
checked reset of §2. `thread_safe_allocator()` is Zig's atomic-bump
variant. The deleted `std/arena` was this allocator over a region it
`malloc`ed itself, plus a generation-stamped state table that made a stale
handle panic instead of touching freed memory. A1 writes the allocator
new; whether it needs such a table (or an origin, §4) is decided there.

`StackFallbackAllocator(N)`: an inline `Array(u8, N)` served first, a
fallback allocator after; Zig's `stackFallback(N, fallback)`. In Yo the
buffer lives in the owner's value (a struct field), so the allocator state
is move-only and the `Allocator` value it hands out is valid until the
state's last use — the place rule the deleted `Arena` handles had (a stale
`Allocator` reached a released state and panicked).

### 3.3 `ArenaAllocator`

Zig's: a linked list of chunks from a backing allocator, growing
geometrically; `reset(.free_all | .retain_capacity | .retain_with_limit)`;
`deinit` frees every chunk. Yo's: the same chunk list over any
`Allocator` (this lands D8's "explicit backing-allocator parameter"), the
same three reset modes, and the §2 rule on `reset` and `deinit`. It keeps
per chunk the bookkeeping the deleted `Arena` kept per block (the live
count, the most-recent-block offset for in-place `realloc`).
Cross-thread: an `Arc` placed in an arena may be dropped on another
thread, so the arena is self-locking (D3), as the deleted one was.

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

*2026-10-24:* the global face landed as `--allocator debug` (#1580). At
C0 (§7), `yo compile`/`yo build` lose the flag (a
program that wants the tracker declares `global_allocator ::
heap.Debug(…)` over a backing heap), and `yo test --allocator debug`
stays as the one surviving `--allocator` spelling, wrapping whatever the
root declares.

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
living, and selecting it is one flag today (`--allocator mimalloc`) and,
from C0 (§7) on, one declaration
in the root module: `global_allocator :: heap.Mimalloc;`. A Yo-written `SmpAllocator`
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
| C0 | the root `global_allocator :: <value>` declaration and the `GlobalAlloc` trait; `std/heap/{system,mimalloc,tlsf,debug}.yo` as its first implementors; `--allocator` (compile and build), `--heap-size`, `--debug-heap` and `build.AllocatorKind` deleted (§7) | a seed that carries Generation A (Generation B declares `global_allocator` in `src/main.yo`) | §7.2 |
| A0 | the allocator interface, version 2 (alignment; sized `free`) — already queued in `VALUES_BY_DEFAULT.md` §6 after V2b; this plan adds nothing to it | V2b | that item's tests |
| A1 | `std/heap/`: `PageAllocator`, `FixedBufferAllocator` (+ the thread-safe variant, `StackFallbackAllocator`), `CAllocator`, `FailingAllocator`, `LoggingAllocator`, `ThreadSafeAllocator`; `FixedBufferAllocator` is new (`std/arena` was deleted 2026-10-24, nothing moves) | A0 for page alignment (the rest can land on version 1 with the 16-byte contract) | each allocator's unit tests; every existing counting-allocator test; a cli-case under `--allocator fixed` using `CAllocator` |
| A2 | `DebugAllocator`, `--allocator debug`, `yo test --allocator debug` (Z11) | Z4 for sites, optional | the leak gates in the tree switch to it; a double-free and a size-mismatch abort test |
| A3 | `ArenaAllocator` over a backing allocator with the three reset modes; `TlsfAllocator` over a region | A1 | reset-while-live panics; `Arc` dropped on another thread into an arena chunk; TLSF's stress harness over a page block |
| A4 | the real arena (§4): `std/heap/bump.yo`, `alloc` with `TrivialDrop`, `alloc_list`, `alloc_dropping` | REFERENCES_AND_ORIGINS N2 | a dangling arena handle is E0911 at `reset`, at drop and at return; a cycle among arena values frees with the chunks; a tokenizer benchmark against A3's `ArenaAllocator` and the global heap, numbers recorded here |
| A5 | `SmpAllocator`, go/no-go | A3, CP0's counters | ≥ mimalloc on the compiler's allocation profile, or a freestanding target that needs it; otherwise archived with its numbers |
| A6 | `MemoryPool(T)` | A0 | header-free create/destroy; pool exhaustion returns `AllocError` |

Each phase is one PR, Generation A where the compiler is touched (C0's
declaration, A2's flag), library-only otherwise. Docs:
`docs/en-US/EXPLICIT_ALLOCATORS.md` and `MEMORY_SAFETY.md` gain a catalog
section, in both languages, per phase.

## 6. Open questions, with positions

- **`std/heap/` or flat `std/`?** Position: `std/heap/`, Zig's name. (The
  2026-10-21 text re-exported `std/arena` for one seed; moot since its
  deletion on 2026-10-24.)
- **Should `with_allocator` scopes accept the real arena?** *(Moot since
  2026-10-24: the scope is deleted, `plans/reference/ALLOCATOR_PLACEMENT.md`; the
  position below still holds for the `alloc :` argument.)* No: the scope
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
- **Should allocation be a `ctl` algebraic effect (`Alloc`)?** No
  (maintainer, 2026-10-24). A control-bound value may not be a
  heap-allocation type parameter or a module-level binding
  (`plans/archive/EXPLICIT_EFFECTS.md` §4, "Handler value unwind-escape
  restrictions"), so a growable container could not keep the allocator its
  growth needs. Allocation also never discards its continuation, so `ctl`
  buys nothing. Nor is it a resuming handler: the same decision deletes
  `with_allocator`, because a scoped handler is dynamic scoping. Placement
  is the `alloc :` argument at the creation site, the program's heap a
  root declaration, and frees go by owner prefix. The design and the other
  rejected alternatives (Zig's allocator parameter, a declared or inferred
  effect, the hybrid, `Vec<T, A>`, an implicit context) are in
  [`ALLOCATOR_PLACEMENT.md`](../reference/ALLOCATOR_PLACEMENT.md) §8.

## 7. C0: the root `global_allocator` declaration

The first phase, before A1. C0 lands the root declaration that selects the process heap and the first four
`heap.*` modules; A1 adds the rest of the catalog. The placement face it sits beside (`alloc : .Some(a)`, the `Allocator` handle, the owner
prefix) landed and is the record in `plans/reference/ALLOCATOR_PLACEMENT.md`, which has the verdict, the four rules,
the rejected alternatives and §11.1, the placement allocator a user writes. Nothing in this section is started
(`global_allocator`, `std/heap` and `GlobalAlloc` do not exist in `src/` or `std/`).

### 7.1 The declaration: Generation A, std, Generation B

- **Generation A (compiler).**
  - Read `global_allocator` from the entry module. **The declaration's nature (2026-10-25):** the *choice* is
    comptime, the *instance* is a runtime static the compiler emits.
    - `global_allocator :: <expr>;` binds a comptime **value** whose **type** implements `GlobalAlloc` (§7.4).
      That type can be any type: one of std's `heap.*` or the user's own. A value, not a type, because the value
      carries the configuration and the initial state together (`heap.Tlsf(region : …)`). A parameterless
      allocator is a unit-struct constant (`System :: SystemAlloc();`).
    - The value must be **comptime-evaluable** and **constant-emittable**: no heap value anywhere in it, and a
      pointer only if it is null, a function, or `addr_of` of a `::` constant (all three are valid C static
      initializers; `ALLOCATOR_PLACEMENT.md` §11.1's `_VTABLE` constant emits as one). The compiler emits it once, as a C static
      initializer (`static <T> __yo_global_allocator = {…};`). It is not assigned in `__yo_main_module_init`:
      module-level initializers run inside that function, in an order no assignment can be guaranteed to
      precede (`src/codegen/functions/generation.yo:1630-1646`), and the runtime's own blocks and C static
      constructors allocate before it runs.
    - **Reaching the live static.** `addr_of(global_allocator)` names `__yo_global_allocator` itself, and std
      exports an accessor for other modules (a counter's `live(state : *Self)` reads through it). A by-value use
      of `global_allocator` is an error: it would copy the initial state. This differs from any other `::`
      constant, whose `addr_of` makes its own static and whose by-value read gives the initial value.
    - **Library builds.** In a library build the six entry points are `extern` declarations and the final
      program defines them, so a block made in the library and freed in the program goes through one
      allocator. A library that declares `global_allocator` is error 1. Today both sides resolve to libc, so the
      mismatch cannot show (the library's runtime helpers are already `static` duplicates,
      `src/codegen/c/collection.yo:259-266`).
    - State that needs runtime setup (a region's headers, an `mmap`, a lock word) is stored in its "not yet"
      form (zero, `.None`), and the allocator initializes it **lazily on its first call**, behind a flag it owns.
      There is no `init` hook (§7.4).
    - Why `::` and not `:=`: the binding is the comptime choice. Untagged blocks must all come from one allocator
      for the life of the process, allocation starts before `main`, and mimalloc is a link decision, so the choice
      can never change at run time. The mutable thing is the static's interior, which only the allocator's own
      methods touch.
  - Codegen: the six `__yo_*` entry points (`src/codegen/c/collection.yo:187-270`, today one `#define` arm per
    `--allocator`) become `static inline` wrappers that call `T`'s `GlobalAlloc` methods directly on
    `&__yo_global_allocator`, with no vtable (§7.4 "Wiring").
  - The ten codegen and build sites that compare an allocator name read its tag: `src/codegen/c/collection.yo:190`, `:197`, `:202`,
    `:267`; `src/codegen/functions/generation.yo:1154`, `:1587`, `:1815`; `src/codegen/functions/gc_runtime.yo:1296`;
    `src/codegen/types/generation.yo:1167`; `src/build_runner.yo:2013`. `src/main.yo`'s flag handling compares the
    name too: the compile path's validation (`:6996`, `:7003`, `:7016`), `:7136`, `:7169` and the link step
    (`:7817`, `:7837`, `:7844`); the test path's validation (`:9075`, `:9080`, `:9093`) and its debug-allocator
    reads (`:9336`, `:9675`, `:9892`, `:9993`). The compile path reads the declaration instead; the test path
    keeps only `debug`.
  - Errors:
    1. `global_allocator` declared outside the entry module, or in a library build (the message names the root).
    2. A value that is not comptime-evaluable, or not constant-emittable (it holds a heap value, or a pointer
       that is not null, a function or `addr_of` of a `::` constant); also a by-value use of `global_allocator`.
    3. A value whose type has no `GlobalAlloc` impl.
    4. `heap.Mimalloc` on wasm (`--allocator mimalloc` with a wasm target has been an error since 2026-10-24).
    5. A `heap.Tlsf` region over 4 GiB on a 32-bit target (moved from `:7136`).
    6. A `GlobalAlloc` method that allocates through the global allocator: a runtime abort under the debug wrapper
       now, a compile error once §7.6's `noalloc` exists (§7.3 C5).
  - Add a module-level link-source declaration, so that reaching `std/heap/mimalloc` links
    `vendor/mimalloc/src/static.c`. **Decided 2026-10-24 (maintainer), and already implemented for `--allocator
    mimalloc` ahead of this step:** a missing `vendor/` is a hard error that names the path
    (`_require_bundled_mimalloc` in `src/main.yo`), and the emitted C's mimalloc block is `#error` without
    `<mimalloc.h>` (`src/codegen/c/collection.yo`). The link-source declaration carries the same error over
    (`issues/retired/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md`, §7.3 "A missing `vendor/mimalloc`").
  - `__yo_build_executable` accepts both arities: slot 4 is the allocator and slot 8 the heap size
    (`src/evaluator/builtins/build.yo:1228-1229`; `std/build.yo:355`).
- **std.** `std/heap/{system,mimalloc,tlsf,debug}.yo` plus `index.yo`, the catalog's first face
  (A1). `heap.Tlsf(region : …, report_at_exit : …)` replaces `--allocator fixed`,
  `--heap-size` and `--debug-heap`. A std use of the link-source builtin waits for a seed that carries it (the
  E0401 rule in AGENTS.md). `GlobalAlloc` (§7.4) is declared in `std/heap/index.yo`, and the four modules are
  its first implementors. `heap.Tlsf` is `src/codegen/c/allocator_fixed.yo`'s C ported to Yo, the reference
  example of lazy initialization. `GlobalAllocator`'s static surface (`std/allocator.yo:94-176`) then calls the
  declared allocator, and `__yo_aligned_free` takes the alignment (§7.3 C3).
- **Generation B (on that seed).**
  - `src/main.yo` declares its allocator, and `build.yo` drops `host_allocator` (`build.yo:39-53`).
  - **OPEN (2026-10-27): the compiler's per-target allocator has no home after the deletion.** `host_allocator`
    picks mimalloc on Linux (`x86_64` and `aarch64`, gnu and musl) and system on macOS and Windows, the split the
    shipped bundles follow (`plans/reference/WINDOWS_ALLOCATOR_DECISION.md`). One `global_allocator ::
    heap.Mimalloc;` in `src/main.yo` would lose it. When C0 deletes `host_allocator`, the root declaration
    must express the per-target choice itself, in one of two ways. The first is a comptime conditional on the
    compilation target; it must not be the build host, which is what `host_allocator` reads today
    (`build.target_host`). The second is a std `heap.PlatformDefault` that resolves to `heap.Mimalloc` on Linux
    and the system heap elsewhere. Generation A's declaration rules (a comptime value, §7.4) must admit whichever
    is picked.
  - **With it:** `test.yml`'s `test-native` step "--allocator mimalloc on Windows (a user program)" was added on
    2026-10-27, when the Windows suite legs moved to the system allocator the bundles ship. Since then it is
    the only CI coverage of mimalloc on Windows. The sweep below converts it rather than deleting it: it becomes
    a test root declaring `global_allocator :: heap.Mimalloc;`, compiled and run on each Windows leg.
  - Deleted: `--allocator` on compile and build, `--heap-size`, `--debug-heap`, `build.AllocatorKind`
    (`std/build.yo:57-78`, default `:146`) and the ten-argument arity.
  - Kept: `yo test --allocator debug`, the one surviving spelling.
  - The sweep covers 13 `--allocator` uses in `test.yml` (counted before 2026-10-27; add the Windows mimalloc step above), 10 in `release.yml` and 2 in `fixpoint-arm64.yml`, 16
    cli-cases, 6 docs files per language, 2 instruction files and 3 skills. `markdown_yo`'s `build.yo` drops its
    two `AllocatorKind.System` lines (16 and 25) in a companion release.
- **Seed steps.** `release.yml:623` and `:1090` run the seed with `--allocator mimalloc`. They keep the flag until
  `SEED_VERSION` carries Generation B, then a follow-up drops it.

### 7.2 Tests

- **C0.** Each `heap.*` root runs a container, `rc`, `dyn` and `io.async` workload. The three declaration errors and
  mimalloc-on-wasm fail to compile. The cli-case without `vendor/` (`tests/cli-cases/compile-allocator-mimalloc-missing-vendor`,
  landed with the `--allocator` error) moves to the root declaration and still fails naming the path.
  `yo test --allocator debug` fails a leaking test (the existing Z11 case). Added 2026-10-25 for §7.4:
  - **A user-written global allocator.** The root declares §7.4's `LiveCount` example and reads the count
    through `addr_of(global_allocator)` (§7.1, "Reaching the live static"). Inside `main`, the count before and
    after a scoped workload is equal. A module-level initializer's allocation shows as a count ≥ 1 at `main`'s
    entry (module globals are never dropped, `src/codegen/c/allocator_debug.yo:18-19`). A spawned thread's
    workload leaves the count unchanged after `join`. A second root uses an allocator with lazily initialized
    state, and its first allocation comes from a module-level initializer.
  - **The declaration rules.** Each of §7.1's errors 1–3 is a compile error with its message: a declaration in a
    non-root module and one in a library build; a value holding a `String`, one holding a pointer that is not
    null, a function or `addr_of` of a `::` constant, and a by-value use of `global_allocator`; a type with no
    `GlobalAlloc` impl. A value holding a function pointer compiles.
  - **A library and a program.** A static library that returns a `String` to a program whose root declares
    `LiveCount` sees the count rise and fall by one: the library's entry points are the program's.
  - **The debug wrapper over a user allocator.** `yo test --allocator debug` over that root reports a leak, and its
    report counts blocks that came through `LiveCount`'s `alloc`. A `GlobalAlloc` whose `alloc` builds a `String`
    aborts with "the global allocator allocated through itself" (error 6).
  - **The hot path.** Under `--optimize 2`, the emitted C of a `heap.System` root calls `malloc` from
    `__yo_malloc` with no indirect call. `check src/main.yo` allocation counts and RSS stay within the
    ratchets.
  - **One family.** A `heap.System` block allocated with `align` 64 is released through the same `free`, which
    `align` routes (a Windows CI job).

### 7.3 Open questions and decisions

**Open questions.**

- **The portable-C arm's allocator.** `release.yml:643` emits the portable C with `--allocator system` for a Linux
   triple, while `src/main.yo`'s C0 declaration picks mimalloc on Linux. **Position:** a second root file
   declares `global_allocator :: heap.System;` and runs `src/main.yo`'s `main`. The release emits the portable C
   from that root, so no flag survives for it. Decide in C0's Generation B.
- **A missing `vendor/mimalloc` under C0. Resolved 2026-10-24 (maintainer): a hard error.** The position was
   the question's own recommendation, option 2: a hard error that names the path, and `#error` in the emitted C. The
   maintainer confirmed it and asked for it now, so it landed for today's `--allocator mimalloc` before C0
   (`issues/retired/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md`); C0 keeps it.

**DECIDED 2026-10-25 (maintainer adopted every recommendation).** C1–C5 come from the advisor's design (§7.4). C6
and C7 came up while the examples were checked against v0.2.70. Each item states the recommendation the maintainer
adopted on 2026-10-25.

- **C1. A value, not a type: DECIDED.** `global_allocator :: heap.X(...)` binds a comptime value whose type implements
  `GlobalAlloc`. **Recommendation:** adopt. A type alone cannot carry `Tlsf`'s region size or `Debug`'s report
  flag. A parameterless allocator is a unit-struct constant, so `global_allocator :: heap.Mimalloc;` reads the
  same as before.
- **C2. `GlobalAlloc` is a separate, unsized interface: DECIDED.** It is the three-function libc family of §7.4
  (`alloc` and `realloc` with an alignment, `free` with the alignment but no size), distinct from the placement
  vtable. **Recommendation:** adopt. A global block is untagged and has no extent, and `__yo_rc_free(void*)`
  (`src/codegen/types/generation.yo:1108`, `:1133`) knows neither its size nor its type. The alternative, a sized
  free for every global block, puts a per-type release path into every `__yo_rc_free` call.
- **C3. `__yo_aligned_free` gains an `align` argument: DECIDED.** **Recommendation:** adopt, as a small std change in
  C0's Generation A, so `GlobalAlloc` stays one family. It also removes the two-family hazard
  (`std/allocator.yo:77-93`) for every allocator except Windows' libc, where `heap.System` routes by `align`.
- **C4. A missing `vendor/mimalloc` is a hard error: DECIDED** (maintainer, 2026-10-24; landed for `--allocator mimalloc` ahead of this phase, `ALLOCATOR_PLACEMENT.md` §10.1). The link-source declaration keeps the same error.
- **C5. The re-entry check is runtime-only, under `--allocator debug`, until `noalloc`: DECIDED.**
  **Recommendation:** adopt, and do not delay C0 on §7.6. The debug wrapper keeps a thread-local re-entry flag
  and aborts with "the global allocator allocated through itself". Once `noalloc` lands, every `GlobalAlloc`
  impl is implicitly `noalloc`, and re-entry becomes a compile error.
- **C6. How the `GlobalAlloc` methods reach the static: DECIDED (found while writing).** The advisor's draft
  takes `self : &Self`, as Rust's `GlobalAlloc` does. In Yo today a `&T` parameter reaches C **by value**. The
  probe (2026-10-25, v0.2.70, `--emit-c`): a method `(fn(self : &Self) -> Allocator)` on a one-field struct
  compiles to `f(__yo_t_… __yo_v_self)`, and `addr_of(self)` inside it is `(void*)(&__yo_v_self)`, the address
  of the parameter's copy. So an atomic update through `self` would change a copy of the static, and an address
  taken from `self` dangles. **Recommendation:** each method takes `state : *Self`, a raw pointer to the static.
  This is true on every seed, independent of how decision 43 and V5 lower `&T`. It is also honest: every write
  is already a raw or atomic store under `AllowUnsafe`, and the placement face's `ctx` is the same kind of pointer.
  Do not use `&mut Self`: every thread calls through the one static concurrently, so it would claim an exclusive
  access that does not exist. **This is final, not provisional:** decision 34 lowers `x : &T` to `T x` for a
  small `Copy` `T` permanently, and to `const T*` otherwise, where a write through it is E0908
  (`plans/VALUES_BY_DEFAULT.md:251`, `:2264-2267`, `:2598`). Neither form is a writable address of the static,
  so `&Self` can never be the `GlobalAlloc` receiver. The maintainer confirms the spelling, not a revisit date. Whether the compiler should reject `addr_of` of a `&T` parameter at all was filed as a question and is decided (maintainer, 2026-10-25): it is error E0921, for the parameter and for any place inside it, so the `self : &Self` receiver above no longer compiles (`issues/retired/2026-10-25-should-addr-of-a-borrowed-parameter-be-rejected.md`). The implementation found that today every `&T` parameter of a non-projection function reaches C by value, whatever the size of `T` (`fn_param_is_ptr_borrow`, `src/types/utils.yo`); only a projection's (`-> &T`, decision 24) is a pointer, and that one keeps `addr_of`.
- **C7. Atomics in a `GlobalAlloc` state: DECIDED (found while writing).** The advisor's draft allows
  `std/sync/atomic`. Its types are `atomic(ref(struct((*) : …)))` (`std/sync/atomic.yo:1295`), heap cells, and
  **they stay cells after V5**: V5 Generation A rewrites every `Atomic*` type onto `__yo_atomic_cell(State)`
  (`plans/VALUES_BY_DEFAULT.md:731-734`, `:5456-5461`; `plans/handover/VBD_RELEASE_SCHEDULE.md:219`), which is
  one allocation with the count header (`:615-635`). So a state holding an `AtomicUsize` is never
  constant-emittable, and making one allocates. The supported state for a `GlobalAlloc` is
  `std/libc/stdatomic.yo`'s inline `atomic_size_t` (and its siblings) with the `__yo_atomic_*` externs; a probe
  (2026-10-25, v0.2.70) shows `LiveCount(live : atomic_size_t(usize(0)))` bound with `::` emitting
  `static … __yo_cptr_0 = { .__yo_v_live = 0 };`. §7.4's example uses it. **Recommendation:** add
  `__yo_atomic_fetch_add_size_t`/`__yo_atomic_fetch_sub_size_t` to `std/libc/stdatomic.yo` (today it has only
  load, store, exchange and compare-exchange, `:256-268`, hence the example's CAS loop) in C0's Generation A.
  The alternative, a std inline value-atomic type, is a larger decision that VBD has not taken; it is not needed
  for C0.

### 7.4 The global face: what a user writes

**The declaration** (§7.1): the root module binds a comptime value whose type implements `GlobalAlloc`.

```yo ignore
// The root module.
heap :: import("std/heap");
global_allocator :: heap.Tlsf(region : (usize(64) * usize(1 << 20)), report_at_exit : true);
```

**The trait: the libc family, three functions, an unsized `free`, one family.** The receiver is `state : *Self`,
§7.3 C6's recommendation. The advisor's draft had `self : &Self`, which does not reach the static in Yo today.

```yo ignore
GlobalAlloc :: trait(
  alloc : (fn(state : *Self, size : usize, align : usize) -> ?*void),
  realloc : (fn(state : *Self, ptr : ?*void, new_size : usize, align : usize) -> ?*void),
  free : (fn(state : *Self, ptr : ?*void, align : usize) -> unit)
);
```

- **Shared, never exclusive.** Every thread calls through the one static concurrently, so all mutation is atomic,
  or a raw store under the implementor's own lock, under `AllowUnsafe`. Rust's `GlobalAlloc` takes `&self` for the
  same reason. Yo spells it as a raw pointer because a Yo `&T` is not an address (§7.3 C6).
- **`align` everywhere.** One family serves both `__yo_malloc` (`align = 16`) and `__yo_aligned_alloc`. `free`
  takes `align` so that `heap.System` on Windows can route `align > 16` to `_aligned_free` without a second
  family (§7.3 C3).
- **`__yo_calloc`** is `alloc` plus `memset` in the compiler's wrapper. It is not a trait method: `heap.System`
  loses nothing measurable, and the rule stays small.
- **Unsized `free`.** A global block is untagged and has no extent, and `__yo_rc_free` (`src/codegen/types/
  generation.yo:1108`, `:1133`) knows neither its size nor its type. So a global allocator keeps its own size
  bookkeeping, as `malloc` does. A sized global free would put a per-type release path into every untagged free
  (§7.3 C2).

**State and initialization.** The state is the declared value's fields, constant-initialized. Anything that needs
runtime setup (the TLSF region's headers, an `mmap`, a lock word) is stored in its "not yet" form (zero,
`.None`), and the allocator initializes it **lazily on its first call**, under a once-protocol it owns: a lock,
or a state word claimed by compare-exchange (`uninit → initializing → ready`, with the losers waiting for
`ready`). A bare "initialized" flag is not enough, because two threads can both see it clear and both initialize.
There is no `init` hook. The compiler cannot run one before the runtime's own first blocks, before `__yo_main_module_init`'s
module-level globals, or before C static constructors. mimalloc and Rust make the same choice. `heap.Tlsf` already
works this way in C (`src/codegen/c/allocator_fixed.yo:281-301`: `__yo_fixed_ensure_init` runs on first touch,
inside the `atomic_flag` spinlock every call already holds), and its port to Yo is the reference example.

**What a `GlobalAlloc` method may use.** It may not create any block: no container, no `String`, no interpolation,
no `rc`, no `Mutex` (its cell is a block). That also excludes `std/sync/atomic`'s types, which are heap cells and
stay cells after V5 (§7.3 C7). The method may use `std/libc/stdatomic.yo`'s inline atomics, raw memory,
`heap.Page` as backing (A1), `heap.System` and `extern` C. It must never back itself with
`GlobalAllocator.*`, which after C0 *is* the declared allocator. C0 ships a runtime guard only in the
debug wrapper: a thread-local re-entry flag that aborts with "the global allocator allocated through itself". The
compile-time check is §7.6's `noalloc`, applied implicitly to `GlobalAlloc` impls once it lands. Without the debug
wrapper, re-entry is unbounded recursion, or a silent deadlock when the method holds its own lock.

**The contract the C wrappers rely on.**

- **Failure is `.None`.** `alloc` and `realloc` return `.None` (NULL) on failure and never panic; the wrapper
  calls `__yo_alloc_fail` (`src/codegen/c/collection.yo:270`), which reports and aborts.
- **Alignment.** The result is aligned to `max(align, 16)`.
- **`realloc` keeps `min(old, new)` bytes** and moves the block if it must; on failure it returns `.None` and
  leaves the old block untouched. The allocator learns `old` from its own bookkeeping (the unsized interface).
- **`free(.None)` does nothing.**
- **`__yo_calloc`** is the wrapper's: it checks `nmemb * size` for overflow (a failure, as above), then calls
  `alloc` and zeroes the block.
- **The static is never dropped.** A `Drop` on the type never runs for the global instance; a type that also
  serves as a placement allocator (`ALLOCATOR_PLACEMENT.md` §11.1) gets its `Drop` only on its placement values.

**Scope: what the declared allocator serves.** Only Yo's six `__yo_*` entry points: every untagged block, plus
`GlobalAllocator.*`. It does not see libc's own allocations, the runtime's C-side buffers (the Windows TLS shim's
raw `realloc`/`free`/`calloc`, `src/codegen/async/runtime_io_common.yo:2141`, `:2172`, `:2223`; the debug
tracker's tables, `src/codegen/c/allocator_debug.yo:247`, `:326`, `:588`), or any foreign C. A buffer that crosses
into or out of C is freed by the family that made it: `std/env.yo:400-415` hands `realpath` its own buffer for
exactly this reason.

**An example: a global heap that counts its live blocks over `heap.System`.** The method bodies are
the ones type-checked on 2026-10-25 (v0.2.70) as free functions over a module-level `:=` state. The `impl`,
`GlobalAlloc` and `heap` are C0's.

```yo ignore
// counting_heap.yo
pragma(Pragma.AllowUnsafe);
heap :: import("std/heap");
{ GlobalAlloc, SystemAlloc } :: import("std/heap");
{ atomic_size_t, memory_order_relaxed, __yo_atomic_load_size_t, __yo_atomic_compare_exchange_size_t } ::
  import("std/libc/stdatomic");

// Configuration and state in one constant-emittable value: no heap value, no non-null pointer.
LiveCount :: struct(live : atomic_size_t);

_bump :: (fn(cell : *atomic_size_t, up : bool) -> unit)({
  (mut(current) : usize) = unsafe(__yo_atomic_load_size_t(cell, memory_order_relaxed));
  (mut(swapped) : bool) = false;
  while(!swapped, {
    next := cond(up => current.wrapping_add(usize(1)), true => current.wrapping_sub(usize(1)));
    swapped = unsafe(
      __yo_atomic_compare_exchange_size_t(cell, addr_of(current), next, memory_order_relaxed, memory_order_relaxed)
    );
  });
});

impl(
  LiveCount,
  GlobalAlloc(
    alloc : (fn(state : *Self, size : usize, align : usize) -> ?*void)({
      block := SystemAlloc.alloc(addr_of(heap.System), size, align);
      cond(
        block.is_some() => _bump(addr_of(state.*.live), true),
        true => ()
      );
      block
    }),
    realloc : (fn(state : *Self, ptr : ?*void, new_size : usize, align : usize) -> ?*void)(
      SystemAlloc.realloc(addr_of(heap.System), ptr, new_size, align)
    ),
    free : (fn(state : *Self, ptr : ?*void, align : usize) -> unit)({
      cond(
        ptr.is_some() => _bump(addr_of(state.*.live), false),
        true => ()
      );
      SystemAlloc.free(addr_of(heap.System), ptr, align);
    })
  ),
  live : (fn(state : *Self) -> usize)(unsafe(__yo_atomic_load_size_t(addr_of(state.*.live), memory_order_relaxed)))
);
export(LiveCount);

// The root module.
{ LiveCount } :: import("./counting_heap.yo");
{ atomic_size_t } :: import("std/libc/stdatomic");
global_allocator :: LiveCount(live : atomic_size_t(usize(0)));
// `addr_of(global_allocator)` is the running static; `LiveCount.live(global_allocator)` would be an error.
live_blocks :: (fn() -> usize)(LiveCount.live(addr_of(global_allocator)));
```

**Wiring and the hot path.** The calls are direct, with no vtable. The compiler emits
`static <T> __yo_global_allocator = {…};` and, for each of the six names that `src/codegen/c/collection.yo:187-270`
defines today, a wrapper such as
`static inline void* __yo_malloc(size_t n) { return <mangled T.alloc>(&__yo_global_allocator, n, 16); }`. These
wrappers replace the per-`--allocator` `#define` arms. `heap.System`'s `alloc` is one extern call, so under `-O2`
the wrapper folds to `malloc`, and the self-hosted compiler pays nothing. `heap.Mimalloc` is the same struct with
methods that call `mi_*`. Its module's link-source declaration pulls `vendor/mimalloc/src/static.c` into the link
(`src/main.yo:7815`), and a missing `vendor/` is a hard error (§7.3 "A missing `vendor/mimalloc`").

**`yo test --allocator debug` does not replace the declaration.** `heap.Debug` is Z11's tracker. Under the flag,
the compiler emits the debug arm with its backing calls bound to the declared `GlobalAlloc` instead of libc. A leak
report is then still about the user's heap, and the re-entry guard runs on it.

**Errors.** These are §7.1's list, items 1–6.

### 7.5 Comparison

- **Rust.** `GlobalAlloc` on a `static`, with `&self` and a sized `dealloc`. Rust knows every layout statically.
  Yo's untagged RC blocks do not know theirs, hence the unsized `free`. A Rust `&self` is an address and a Yo `&T`
  is not, hence `*Self` (§7.3 C6).
- **Zig.** There is no global allocator at all: every call takes an allocator. That was rejected (`ALLOCATOR_PLACEMENT.md` §8 item 2)
  because interpolation, tasks and `dyn` have no slot for one.
- **Odin.** An implicit `context.allocator`, the dynamic scoping this plan deleted.
- **C.** Link-time `malloc` interposition replaces every caller's heap, libc's and foreign code's included. Yo's
  declaration replaces only Yo's `__yo_*` entry points (§7.4 "Scope"), as mimalloc's link line does today:
  `vendor/mimalloc/src/alloc-override.c` compiles only under `MI_MALLOC_OVERRIDE`, which the link step does not
  define (`src/main.yo:7815-7833`), and the emitted C renames `__yo_malloc` to `mi_malloc`
  (`src/codegen/c/collection.yo:207-212`).

### 7.6 Backlog note: `noalloc`

A checked `noalloc` function marker would mark the side that carries information: the 12 % of functions that never
allocate. It would serve real-time code and fixed-region users. A `noalloc` function may call only `noalloc`
functions and may create no block. A `dyn` or function-pointer call is not `noalloc` unless its type says so. It
is designed after decision 43 N1 (`plans/backlog/REFERENCES_AND_ORIGINS.md`), whose function-type machinery it
reuses. Nothing is scheduled.
