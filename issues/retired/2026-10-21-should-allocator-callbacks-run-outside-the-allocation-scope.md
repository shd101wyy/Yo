# Should an allocator's callbacks run outside the allocation scope?

**Kind:** design question. **Retired 2026-10-24 as moot (maintainer adopted the allocator verdict,
`plans/backlog/ALLOCATOR_PLACEMENT.md`).** The question assumes a thread allocation scope, and that design deletes
it: a creation without `alloc :` goes to the global allocator, and placement is an argument at the site. B1
(v0.2.71) deletes `with_allocator`, so the only remaining scope setter is the swap `rc`/`arc` do around one cell
construction. V5 Generation A (v0.2.72) moves `rc`/`arc` onto `__yo_cell`/`__yo_atomic_cell`, which take the
allocator with no swap (#1572). B2 (v0.2.72, after V5 Generation A) then deletes the thread-local. From then on an
allocator's callbacks have no scope to run inside, and their allocations go to the global allocator. Until then,
option 1's documented contract stays in force for `rc(v, alloc : .Some(a))` and `arc(v, alloc : .Some(a))`. The
analysis below is the record the question was opened on.

Filed 2026-10-21 from the adversarial review of `feat/arc-alloc-parameter` (`arc` gaining the `alloc` parameter,
`plans/VALUES_BY_DEFAULT.md` §3.2).

## What happens today

A reference-counted cell placed by a scope is allocated by codegen's
`__yo_rc_alloc_scoped(s, size)` (`src/codegen/types/generation.yo`), which
calls `s.vtable->alloc(s.ctx, …)` while the thread's scope is still `s`. So
under `with_allocator(a, f)` an allocator's own `alloc`/`realloc`/`free` runs
with `a` as the current scope. If a callback makes a scope-following
allocation (`ArrayList.new()`, a `String`, `box(v)` without `alloc`, a `ref`
constructor), that allocation calls `a.alloc` again, and the program recurses
until the stack overflows.

`arc(v, alloc : .Some(a))` inherits this: until V5's `__yo_atomic_cell` takes
the allocator, its explicit path sets the thread scope to `a` around the
`Arc(V)(v)` constructor. `box(v, alloc : .Some(a))` does not: it calls
`a.vtable.alloc` directly under the caller's scope.

Since 2026-10-22 `rc(v, alloc : .Some(a))` takes the same swap around
`Rc(V)(v)` (`feat/rc-alloc-parameter`), so it inherits this too, until
`__yo_cell` takes the allocator.

Measured 2026-10-21 (seed v0.2.67, `--std-path` at the branch's std, `-O2`): an
allocator whose `alloc` pushes onto a fresh `ArrayList(usize)` and then calls
`GlobalAllocator.malloc`:

| Call | Result |
| --- | --- |
| `box(i32(1), alloc : .Some(a))` | `box ok: allocs=1`, rc 0 |
| `arc(i32(2), alloc : .Some(a))` | rc 139; under `--sanitize address`, ASAN reports `stack-overflow` |
| `with_allocator(a, () => arc(i32(2)))` | rc 139 |

The probes are kept in `~/Workspace/Yo-wt/vbd-logs/arc-alloc/review/`
(`reent.yo`, `reent_box.yo`, `reent_wa.yo`).

## Options

1. **Keep it a documented contract.** Allocator callbacks must not allocate
   through the scope; they get memory from `GlobalAllocator` or a buffer they
   own. Every allocator in the tree already obeys it (the global allocator,
   `std/arena.yo`'s `Arena`, the counting allocator in
   `tests/arena.test.yo`). Cost: none.
   Since 2026-10-21 `docs/en-US/EXPLICIT_ALLOCATORS.md` ("Writing your own
   allocator") and its zh-CN twin state the rule.
2. **Clear the thread scope around each callback.** `__yo_rc_alloc_scoped`,
   `Allocator.alloc`/`realloc`/`free` and every prefix-reading free path would
   save the scope, set the global one, call the vtable and restore it. A
   callback's own allocations then go to the global heap, never recursing.
   Cost: two thread-local writes per scoped allocation and free, on paths
   that `__yo_scopes_ever_entered` keeps cheap today, and a codegen change to
   the runtime prelude.
3. **Run callbacks under the caller's outer scope.** This would match `box`'s
   behavior exactly, but `__yo_rc_alloc_scoped` does not know the outer
   scope; it needs a scope stack, which is more state than the problem
   warrants.

## Recommendation

Option 1. The rule is simple, cheap and already obeyed by every allocator in
the tree, and the divergence between `box` and `arc` disappears on its own
when V5's `__yo_atomic_cell(V)(v, .Some(a))` hands the allocator to the cell
helper directly (§3.2 "The primitive takes the allocator"), the same way
`box` calls the vtable today. Revisit option 2 only if a real allocator needs
to allocate bookkeeping through the scope.
