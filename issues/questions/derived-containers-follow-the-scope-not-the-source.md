# Should a container derived from an arena container stay in the arena? (OPEN-DESIGN)

**Kind:** design question: an open decision, not a defect. Filed 2026-10-13
from the std allocator hand-off audit (`fix/allocator-tag-handoffs`).

## What happens today

Decision 12 (`plans/VALUES_BY_DEFAULT.md` §3.11) settles one case: an explicit
`clone()` lands where its source lives. `ArrayList.clone`, `HashMap.clone`,
`String.to_bytes`, `StringBuilder.to_string`'s fresh buffer and, since
`issues/fixed/string-clone-ignores-the-source-buffers-allocator.md`,
`String.clone` all follow it. Every other std operation that builds a new
container out of an existing one uses the default constructors, so it follows
the CURRENT scope:

| Operation | Builds its result with | Where an arena source's result lands, outside a scope |
| --- | --- | --- |
| `ArrayList.drain`, `split_off`, `remove` (internally `drain`) | `Self.new()` | global heap |
| `ArrayList.slice`, `slice_copy`, `slice_copy_inclusive`, `chunks`/`windows` items | `Self.with_capacity` / `Self.new()` | global heap |
| `ArrayList.retain` (scratch list, freed before return) | `Self.with_capacity(n)` | global heap (transient) |
| `OrderedMap.clear` (replaces `_order` and `_index`) | `ArrayList.new()`, `HashMap.new()` | the map's index moves to the global heap |
| `BufWriter._flush_buf` (replaces its buffer) | `ArrayList(u8).with_capacity` | the writer's buffer moves to the current scope of the flush |
| `String` operators and `substring` | `ArrayList(u8).with_capacity` | global heap |

Measured with `ArrayList(i64).new_in(arena)` and no scope active:
`drain`, `split_off`, `slice` and `slice_copy` report `allocator().is_none()`,
`clone` reports the arena.

None of these is a misroute. Each new buffer's tag matches its block, so every
free goes to the allocator that made the block. The audit's probes ran every
row above under an arena (`deinit` panics on a live block) and macOS Guard
Malloc, and all were clean. The question is only placement.

## The two readings

1. **"Derived = clone."** An operation that copies part of a container into a
   new one is a clone of that part, so decision 12 applies. Rust does this:
   `Vec<T, A>::split_off` builds its result with `self.allocator().clone()`,
   and `drain` borrows the source's buffer instead of allocating.
2. **"Derived = new."** Only `clone()` carries the source's placement; every
   other result is a new value and follows the scope, as `new()` does. This is
   today's behavior. It is simpler, and a program that wants arena results runs
   the call inside `arena.scoped(...)`.

Reading 2 has one sharp edge: in-place operations that REPLACE an internal
buffer (`OrderedMap.clear`, `BufWriter`'s flush) silently move a container
out of the allocator it was created in, contradicting
`docs/en-US/EXPLICIT_ALLOCATORS.md`: "every growth, shrink and final release of
its buffer goes back to the allocator it was created with".

## Recommendation

Take reading 1 for operations that return a new container (`drain`,
`split_off`, `slice`, `slice_copy*`, `chunks`/`windows` items, the `String`
operators), so the result carries `self.allocator()`, as Rust's `Vec<T, A>`
does. Treat the in-place replacements (`OrderedMap.clear`, `BufWriter`'s flush)
as defects under either reading: they should reuse or clear their buffer
(`ArrayList.clear`, `HashMap.clear`) instead of building a new one, which also
keeps their capacity. Scratch storage that never escapes (`retain`'s `kept`)
can stay where it is. Each change is local to std and needs no compiler work.
