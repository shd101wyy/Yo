# A deinit arena's handle aliases the next arena that reuses its state

**Severity:** S3 — a released `Arena` handle or `Allocator` copy silently acts on the next arena: it reports it, deinits it, or allocates into it instead of panicking as documented

**Status: FIXED 2026-10-09** (found by reading `std/arena.yo`).

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ Arena } :: import("std/arena");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  arena := Arena.new(usize(1024));
  a := arena.allocator();
  arena.deinit();
  next := Arena.new(usize(1024)); // takes the dead arena's pooled state
  println(`released: ${arena.is_released()}, next live: ${!next.is_released()}`);
  block := a.alloc(usize(32));    // documented to panic
  println(`unreachable: ${block.is_some()}, next live blocks: ${next.live_blocks()}`);
});
export(main);
```

Before the fix (v0.2.56, tree std):

```
released: false, next live: true
unreachable: true, next live blocks: 1
Arena.deinit: 1 block(s) still live (48 of 1024 bytes in use)
```

The dead handle reports live, the stale `Allocator` copy allocates into
`next`, and `next`'s own dispose then panics, blaming the wrong arena. Three
more symptoms, each a test in `tests/arena.test.yo`:

- `a.live_blocks()` / `a.used_bytes()` / `a.capacity()` report the new arena;
- `a.deinit()` / `a.abandon()` act on the new arena;
- when `a`'s last reference dies after the new arena was created, its
  `Dispose` deinits the new arena's state: the new arena's region is freed
  under it (or, with a live block, the panic blames `a`).

It was memory-safe (states are never freed) but broke the guarantee in
`std/arena.yo`'s state comment and `docs/en-US/MEMORY_SAFETY.md` ("an
allocation from a deinit arena through a stale `Allocator` copy panics").

## Root cause

`Arena.deinit` returned the arena's state block to a global pool, and
`Arena.new` reused a pooled state and reset its `dead` flag. The handle
(`ref(struct(_state : *_ArenaState))`) and the `Allocator` context (the state
pointer) named only the state, not which arena it was serving, so after reuse
nothing told the dead arena's values from the new arena's.

## Fix

Every state carries a generation, bumped by `deinit`; the `dead` flag is gone.

- The `Arena` handle records the generation it was made for
  (`_gen`). Every method compares it with the state's under the state's lock:
  a mismatch is a released arena (`is_released()` true, `live_blocks` /
  `used_bytes` / `capacity` 0, `deinit` / `abandon` / `Dispose` no-ops).
- An arena's `Allocator` context is no longer the state pointer but one word:
  the state's index in a state table (low half) and the generation (high
  half). The vtable functions decode it; allocating or reallocating through a
  context whose generation is not the state's current one panics with the
  existing messages, and so does a free (unreachable: `deinit` requires every
  block freed, so it can only be a double free).
- The generation has to live in the context: the frozen `Allocator` is two
  words and the vtable functions see only `ctx`. A pointer has no spare bits
  that a portable program can use, so the context became an index into a
  table of states that never move or die (chunks doubling in size, written
  once under the pool mutex before an index is handed out, read without a
  lock). A state whose generations run out (2^32 on 64-bit targets, 2^16 on
  32-bit ones) is retired instead of pooled, so a context value never names
  two incarnations. Memory stays bounded by the peak number of live arenas
  plus the retired states.
- `Arena.new` resets a reused state under its lock, since a stale handle may
  lock it concurrently to read the generation.

Docs: `docs/{en-US,zh-CN}/EXPLICIT_ALLOCATORS.md`, `docs/{en-US,zh-CN}/MEMORY_SAFETY.md`.

## Tests

- `tests/arena.test.yo`: a deinit arena stays released after the next arena
  reuses its state; a stale handle reports nothing of the next arena and its
  `deinit`/`abandon` leave it alone; dropping a stale handle does not deinit
  the next arena; a stale `Allocator` is not `same` as the next arena's; and a
  canary with 100 live arenas across three table chunks. The first four fail
  before the fix.
- `tests/cli-cases/arena-stale-allocator-after-reuse-panics`: allocating
  through a stale `Allocator` copy after the state was reused panics with
  `Arena: allocation from an arena after deinit` (before the fix: the
  allocation succeeded and the new arena's deinit panicked).
