# Explicit Allocators — the landed decisions

> **Status: IMPLEMENTED (P0–P5), 2026-09-30, as a stack of draft PRs on
> #1015; authoritative once the stack merges.** The one open item is P3c
> (default mutable-container constructors follow the scope), parked behind
> the seed and tracked in the active plan
> [`plans/EXPLICIT_ALLOCATORS.md`](../EXPLICIT_ALLOCATORS.md), which holds
> the phase-by-phase record, the measurements and the corrections. This page
> is the short authoritative list of what was decided.

## The model

- **Placement, not lifetime.** An allocator decides where a block lives;
  reference counting (and the cycle collector) decides when it dies. No
  object is ever freed by its allocator ahead of its last reference.
- **Frees route by owner, never by call site.** A block from an explicit
  allocator carries a 16-byte prefix `{ctx, vtable}` in front of the pointer
  handed out (`std/allocator.yo` `_AllocPrefix`, C `__yo_alloc_prefix_t`).
  Every release reads it, on any thread.
- **The fallback is the global allocator.** Code that never names an
  allocator emits exactly what it emitted before; the only new cost on that
  path is the masked tag test in the free path.

## Where the owner is recorded

| object | mark | reader rule |
| --- | --- | --- |
| RC object (all three headers) | top bit of `ref_count` (`__YO_RC_TAG`) | mask count tests with `__YO_RC_COUNT`; `__yo_rc_free` routes on the tag |
| `ArrayList` (and `StringBuilder`, which wraps one), `Deque` buffer | top bit of the capacity word | read through `_cap()` |
| `HashMap` / `HashSet` table | top bit of `_tombstones` | read through `tombstones()` |
| `imm` vec / string buffer | top bit of `_capw` | read through `_capn()` |
| `imm` map branch / collision node | bit 0x80 of `_children_lw`, top bit of `_pairs_lw` | `_clen()` / `_plen()` |

No container grew a field: the owner bit lives in a word each already had.

## The surface

- `Allocator` — `{ctx : ?*void, vtable : *(AllocatorVTable)}`, two words,
  `Send`, never reference counted. The vtable is `alloc`, `realloc`, `free`,
  context first; frozen. Global vtables are module-level `:=` values
  (D9).
- `with_allocator(a, f)` — a std function, not a keyword (D2). It makes `a`
  current on this thread while `f` runs; an RAII guard (a plain `ref`
  struct, not generic in `T`) restores the previous scope on every exit. The six user-visible RC constructor sites (`ref`
  struct and enum, `box`/`arc`, `dyn`, `Iso`, async state machines) consult
  it; the runtime's own blocks never do. `current_allocator()` reads it.
- A task keeps the scope it was created in: its resume wrapper reinstates
  the scope from the state machine's own prefix. A spawned thread starts on
  the global allocator.
- Containers take an allocator explicitly: `new_in` / `with_capacity_in`.
  The `imm` collections follow the scope.
- `std/arena.yo` `Arena`: a bump region. `deinit` (and the handle's
  dispose) **panics** while a block is live; `abandon()` is the
  process-lifetime escape hatch. Arena states are pooled, never freed, so a
  stale `Allocator` copy panics instead of touching freed memory. Every
  operation takes the arena's spinlock (D3). The handle is not `Send`; share
  the `Allocator` value.
- `--allocator fixed --debug-heap` lists every arena never deinit and every
  abandoned arena in the exit report.

## Decisions not taken

- No `alloc_in` keyword or lazy-expression builtin (D2).
- No allocator-aware `Dispose` (D7): the buffer and the object each route
  through their own prefix.
- No nested arenas (D8) and no over-aligned buffers (D10) yet.
- `Mutex(Arena)` is not a pattern: the arena locks itself.

## Docs

`docs/en-US/MEMORY_SAFETY.md` §"Explicit Allocators and Arenas" and
`docs/en-US/DESIGN.md` §"Explicit Allocators", with their `zh-CN` twins.
