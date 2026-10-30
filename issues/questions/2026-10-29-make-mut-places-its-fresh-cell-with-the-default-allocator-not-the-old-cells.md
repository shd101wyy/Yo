# Should `make_mut` place its fresh cell in the old cell's allocator?

**Kind:** design question — an open decision, not a defect.

**Status:** decided 2026-10-30 (Fable consultation #7, Q2; see
"Verdict"). Filed 2026-10-29 on `fix/arc-unique-lock-gen-b` (Fable
consultation #2, verdict A3, listed it as a non-blocking follow-up). The doc
stays in `questions/` until the verdict's Generation B merges.

## The question

`Rc.make_mut` and `Arc.make_mut` move `self` to a fresh cell in two cases:
another strong handle shares the cell (the payload is cloned), or only
`Weak`/`ArcWeak` handles share it (the payload moves, since Generation B
of
`issues/fixed/2026-10-28-arc-make-mut-and-try-unwrap-race-an-arcweak-upgrade-on-another-thread.md`).
Both spell the fresh cell `Rc.new(payload)` / `Arc.new(payload)` with no `alloc`
argument, so it is placed by the default allocator. A cell placed with
`Rc.new(v, alloc : .Some(a))` records `a` in its owner prefix
(`__yo_alloc_prefix_t`, read by `__yo_rc_free`), and that record is not
consulted. After `make_mut`, a handle whose cell lived in an arena or a
counting allocator lives in the global heap.

`tests/rc.test.yo` and `tests/arc.test.yo` ("moves the payload, not a
clone, to a fresh cell") observe this: the counting allocator sees only the
old cell.

Rust keeps the allocator: `Rc<T, A>::make_mut` and `Arc<T, A>::make_mut`
allocate the new cell with `this.alloc.clone()`.

## What holds today

- The clone path has done this since `make_mut` landed (decision 46). The
  move path inherits it.
- Nothing is unsound. The old cell is still freed into the allocator that
  placed it, and the fresh cell into the default one.
- A program that places cells in a bounded allocator (`--allocator fixed`
  aside, which is global) silently starts using the global heap after a
  `make_mut`. A program that frees an arena wholesale while a `make_mut`'d
  handle is alive keeps a valid handle, because the handle no longer points
  into the arena.

## Options

1. **Keep the default allocator.** Document it on both doc comments.
2. **Reuse the old cell's allocator, as Rust does.** `make_mut` reads the
   owner prefix of the cell it leaves and passes it as `alloc`. This needs a
   runtime primitive that answers the recorded allocator (`.None` for an
   untagged cell), e.g. `__yo_rc_cell_allocator(cell) -> Option(Allocator)`.
   `src/` instantiates `Rc.make_mut`, so this is seed-gated: Generation A
   adds the primitive, and Generation B calls it from the prelude.

## Recommendation

Option 2. Allocator placement is by argument in Yo (maintainer decision
2026-10-24), and a door that grants `&mut` should not silently change where
the value lives. Rust's behavior is the precedent. The cost is one runtime
primitive and one argument per `make_mut` branch. Land it as a
Generation A/B pair after this window, with a counting-allocator row per
handle kind: the fresh cell is in the same allocator, and the count goes
back to zero once both cells are gone.

## Verdict

Decided 2026-10-30 by Fable consultation #7, Q2: **option 2**. `make_mut`
reuses the old cell's allocator on both paths (shared-strong clone,
weak-only move) of both handle kinds, as Rust's `this.alloc.clone()` does
and as Yo's own rule for `clone()` ("lands where its source lives",
`Box.clone` through `Box.allocator`) already says. `make_mut` takes no
allocator parameter of its own. It lands as a seed-gated pair:

- **Generation A** (v0.2.74, compiler-only, branch
  `fix/rc-owner-hooks-gen-a`): two `extern("Yo")` scalar hooks beside
  `__yo_scope_of_object` in `src/codegen/types/generation.yo`,
  `__yo_rc_owner_ctx(cell : *void) -> ?*void` and
  `__yo_rc_owner_vtable(cell : *void) -> ?*void` (a NULL vtable is the
  global allocator). They read the owner prefix as `__yo_scope_of_object`
  does, with the tag bit read by a relaxed atomic load, since `Arc`'s clone
  path runs while other threads update the count.
- **Generation B** (v0.2.75, on the v0.2.74 seed): public `Rc.allocator(h)`
  and `Arc.allocator(h)`, mirroring `Box.allocator`; each `make_mut` reads
  `owner` at entry, before any forget or release of the old cell, and passes
  `alloc : owner` at all four fresh-cell sites. Four counting-allocator rows
  (per kind and per path) plus one row per kind for a global handle, and the
  two "moves the payload, not a clone, to a fresh cell" rows flip their
  expectation.

Until then the fix for the uniqueness-lock race merges as built: for one
release the fresh cell stays on the default allocator.
