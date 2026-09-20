# Arena allocation in Yo — feasibility and soundness under non-atomic RC

**Status: RESEARCH COMPLETE, DESIGN PROPOSED, NOT STARTED (2026-09-20).**
Written alongside `../EVALUATOR_MEMORY_REDUCTION.md`, which measured why the
compiler is large. This document answers a different question: can Yo — whose
heap objects are `ref(struct(...))` / `ref(enum(...))` handles with
**non-atomic** reference counts, a trial-deletion cycle collector, and ONE
process-wide allocator — get a sound arena allocator, and would it help?

## 0. Verdict

1. **Feasible and sound, in a constrained form.** An arena that serves the
   REFERENCE-COUNTED OBJECT CELLS allocated inside a dynamic scope, keeps every
   object's RC semantics intact, refuses (with a deterministic panic, never
   UB) to end the scope while any cell is still referenced from outside it,
   and never serves raw buffers. §4 Option B specifies it; §3 is the
   soundness argument; §5 lists the eight escape hatches that must be closed
   and how each one is closed.
2. **Unsound, and rejected, in the obvious form.** A Zig-/Odin-style
   "everything allocated in this scope comes from the arena, free is a
   no-op, reset frees all" cannot be made safe in Yo: raw buffers carry no
   header, so an OUTER container that grows INSIDE the scope silently puts
   its bytes in the arena and dangles at reset, with nothing to detect it
   (§3.3). This is exactly the hazard that made `plans/reference/FIXED_REGION_ALLOCATOR.md`
   §0 reject a bump allocator for `--allocator fixed`.
3. **Statically-scoped (region-typed) references are out.** They need
   lifetimes on types, which the language design refuses
   (`docs/en-US/MEMORY_SAFETY.md`: "no borrow checker, no lifetimes"), and
   the verifier (`plans/backlog/FORMAL_VERIFICATION.md`) is where runtime
   properties go — a region discipline could be verified later, not typed now.
4. **It does not solve the compiler's memory problem.** The compiler's
   footprint is retention of live metadata, not churn; an arena makes
   retention *worse* (no per-object free). The compiler-side lever an
   "arena" idea actually points at is handle-indexed tables (§4 Option A),
   which is a library and needs no runtime change.
5. **Recommendation:** ship Option A (a generational, handle-indexed
   `Arena(T)` collection in std — sound today, zero compiler change), and run
   Option B as a gated prototype whose go/no-go is a measured CPU win on
   phase-structured programs (§6). Do not start Option B to reduce memory.

---

## 1. What Yo's runtime commits to (the constraints)

Read from `src/codegen/functions/gc_runtime.yo`, `codegen/types/generation.yo`,
`codegen/functions/constructors.yo`, `std/allocator.yo`, and the docs cited.

| fact                                                                                                                                           | consequence for an arena                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Every `ref(...)` object is `{ __yo_ref_header_t header; fields }`; `ref_count` is a plain `uint32_t`, `__yo_incr_rc`/`__yo_decr_rc` are non-atomic; `atomic(ref(...))`, `Arc`, `Iso` use `atomic_fetch_*` on the same field | objects are thread-owned unless atomic; an arena must be thread-local too                                            |
| `__yo_decr_rc` on the last reference runs `header->dispose_fn(ptr)` (drops fields/buffers) and then `__yo_free(ptr)`                            | "free" is one call in one place (plus the collector's sweep and the async runtime) — a no-op-free arm is a one-bit check      |
| Cycle-capable types are `__yo_gc_register`ed at construction, live on per-thread intrusive lists (`gc_next/gc_prev`, `roots_next/roots_prev`), get `traverse_fn` | arena cells must be unlinked before bulk free; only TRACKED types can be traversed                                  |
| Cycle-incapable types have a 16 B header and NO `traverse_fn` (`RC_HEADER_SPLIT.md`)                                                            | an escape check by trial deletion needs traversal of every arena cell → arena mode must emit `traverse_fn` for every type it can hold |
| One allocator: `GlobalAllocator` (`std/allocator.yo`) = the `__yo_malloc/calloc/realloc/free` macro family; **zero raw `malloc` in `src/codegen/`**; `ArrayList` buffers are raw `GlobalAllocator.malloc/realloc` (no header) | routing is centralized; but raw buffers are invisible to any per-object check                                    |
| `Send` is structural and non-atomic `ref` types are not `Send`; cross-thread transfer goes through `Iso(T)` (`can_isolate` = `rc(self) == 1` …), `Arc(T)` (`where(V <: (Send, Acyclic))`), `atomic(ref(...))`, `Channel` | the cross-thread escape hatches are a finite, named list (§5)                                                |
| Runtime borrow flag: `borrow_count` in the header, incremented for the lifetime of an interior borrow, asserted zero by mutations that could free the storage (`docs/en-US/MEMORY_SAFETY.md`) | Yo already accepts "deterministic panic instead of UB" as a safety mechanism — the precedent for a dynamic escape check |
| `ctl(...)` values are **frame-bound**: `type_is_control_bound` + the §4 escape-boundary rules (no module-level binding, no closure capture, no pointer, not in a fn result type) | a static "cannot outlive this frame" discipline exists and is transitive over containing types — reusable for a handle type |
| `Acyclic` marker trait (`std/prelude.yo:233`) — "cannot form reference cycles, needs no cycle tracking"                                          | a natural precondition for an arena that wants to skip traversal                                                              |
| `--allocator fixed` is a TLSF general-purpose allocator over a static region; a bump region was rejected because RC releases blocks in arbitrary order (`FIXED_REGION_ALLOCATOR.md` §0) | an arena is a *policy layered above* `__yo_malloc`, not a fourth `--allocator`                                       |

## 2. What "arena" can mean, and what each buys

| model                                                                 | prior art                                                                   | lifetime rule                                     | what it buys                                       | fits Yo?                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| **A. Handle-indexed typed arena** (`Vec<T>` + `u32` index, generational) | Rust `slotmap`/`generational-arena`, every compiler's AST/type tables      | values die with the arena; handles are just ints  | density (no header per value), O(1) bulk drop, stable ids | **yes, today, as a library** — a stale handle is a bounds/generation check, never UB |
| **B. Scoped allocation policy for RC objects** (dynamic extent)         | Odin/Jai `context.allocator`, Apple autorelease pools (the RC precedent)   | cells freed at scope end; RC still governs *when* a cell is dead | bump allocation, no per-cell `free`, locality | **yes with a dynamic escape check** (§3, §4B); buffers excluded    |
| C. Region-typed references (static)                                    | Cyclone, MLKit/Tofte–Talpin, Verona regions, Rust `bumpalo` lifetimes       | the type system proves no reference outlives the region | zero runtime cost                             | **no** — lifetimes on types are refused by design                  |
| D. Per-collection allocator parameter                                  | Zig                                                                         | each container knows where its buffer lives       | buffers in arenas too                              | **no** — one global allocator is a settled decision (`FIXED_REGION_ALLOCATOR.md` §0) |
| E. Allocation reuse instead of arenas                                  | Koka/Lean **Perceus** (reuse a dying cell for a same-size construction)    | none — pure RC                                    | removes malloc/free pairs at drop→construct sites  | **yes, as a codegen optimization** in the dup/drop optimizer family; orthogonal to this doc |

## 3. Soundness analysis for Option B

The invariant to keep is Yo's contract, "safe code cannot express undefined
behavior". With RC handles the ONLY new hazard an arena introduces is **a cell
outliving its arena**: some handle to an arena cell exists after the arena's
memory is reused. Everything below is about making that impossible or
detectable-before-harm.

### 3.1 RC keeps working inside an arena

Cells allocated from the arena keep a normal header, normal `incr`/`decr`,
normal `dispose_fn`. The ONLY change is in `__yo_decr_rc`'s last-reference arm:
`if (!(gc_flags & __YO_GC_ARENA)) __yo_free(ptr);` — the dispose still runs (it
releases non-arena children and raw buffers), the cell's bytes are simply not
returned to the heap. The same bit test goes into the collector's sweep free
and the async runtime's frees. Correctness of RC itself is untouched: an
arena cell that reaches zero is dead; it merely stays dead in place.

### 3.2 Escape = a cell alive at scope end with a referrer outside the arena

At scope end, every cell in the arena is either dead (RC 0 — already
disposed), or alive because it is referenced. Referrers are (i) other arena
cells, (ii) the heap/globals/stack outside. (i) is fine: the whole set dies
together. (ii) is an escape. Distinguishing them is exactly the cycle
collector's trial deletion restricted to the arena set: for each live cell,
traverse its fields and subtract one from each referenced ARENA cell's trial
count; a cell whose trial count is still > 0 has an external referrer.
Cost: one traversal of the arena's live cells — the same order as the
per-object frees the arena saved. Requirement: **every type that can be
allocated in an arena needs a `traverse_fn`**, including today's untracked
ones (`ArrayList` cells etc.); arena mode therefore emits traverse for all
ref types (code size, no runtime cost outside the check).

On an escape the runtime **panics** ("arena scope ended with N live cells
referenced from outside: <type> allocated at <site>"). That is a program bug
surfaced deterministically, in the same category as the borrow-flag panic;
it is never silent reuse. Debug builds can additionally record the allocation
site per cell (like `--debug-heap`).

### 3.3 Why raw buffers cannot be arena-served (the rejected form)

`ArrayList(T)`, `HashMap`, `String` bodies live in raw `__yo_malloc`/`realloc`
buffers with no header. Two failure shapes, both undetectable:

- A container created OUTSIDE the scope is pushed to INSIDE the scope; its
  `realloc` (or its first `malloc` if it was empty) would be served by the
  arena; at reset the outside container points into freed memory. Nothing
  in the buffer or the container records which allocator served it.
- A buffer allocated inside and handed to an outside container by move
  (`outer.extend(inner_list)` steals or copies? — implementation-dependent).

Detection would require every buffer to know its owner's location, i.e. a
per-container allocator (model D). So Option B routes **object cells only**;
buffers stay on the global allocator. Consequence: an arena-allocated
`ArrayList` has its 40 B cell in the arena and its buffer on the heap — the
bulk free saves the cell frees, not the buffer frees.

### 3.4 Cross-thread escape

Arena cells are ordinary non-atomic `ref` objects, so `Send` already refuses
to move them raw. The hatches that CAN move a non-atomic object's ownership to
another thread are the `Iso(T)` constructor (`can_isolate`), `Arc(T)`/`arc`,
`atomic(ref(...))` construction from an arena cell's fields, and channels of
`Send` payloads. Each constructor gets one check: `if (gc_flags & __YO_GC_ARENA)
panic("cannot isolate/share an arena-allocated value")`. A cell whose FIELD
is an atomic object is fine — the atomic object is on the heap; the arena
cell only holds a handle.

### 3.5 Cycle collector interplay

- Arena cells that are tracked are on the thread's `tracked_objects` and may
  be on `possible_roots`. Reset unlinks each (O(1), intrusive) before bulk
  free. A collection that runs mid-scope treats arena cells normally; when
  its sweep frees a garbage cycle inside the arena, the free is the §3.1
  no-op.
- The reset's own trial deletion must run with `__yo_gc_collecting` set (so
  `__yo_decr_rc` on tracked cells does not double-count), exactly as the
  collector does.

### 3.6 Interior borrows and `inout`

`inout` parameters are pointers into cells; the borrow flag guards the cell's
storage against reallocation, not its lifetime. A borrow cannot outlive the
callee frame, and the arena scope is a frame too, so an `inout` into an arena
cell across the scope end is already impossible syntactically (the scope is a
closure body; §4B).

### 3.7 Nested arenas, panics and `unwind`

Arenas form a per-thread stack; a nested scope allocates from the innermost.
An `unwind`/exception leaving the scope closure must still run the reset: the
scope primitive is implemented as an effect handler / `defer`-style epilogue
in the runtime, the same way `__yo_effect_escaped` cleanup runs today. If the
escape check fails during an unwind, the panic wins (it is the earlier bug).

## 4. Designs

### 4.1 Option A — `Arena(T)`: a generational handle-indexed collection (recommended first)

A std collection, no compiler change, sound by construction:

```rust
// std/collections/arena.yo (sketch)
Handle :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(index : u32, generation : u32)
);
Arena :: (fn(comptime(T) : Type) -> comptime(Type))(
  ref(
    struct(
      _slots : ArrayList(Option(T)),
      _generations : ArrayList(u32),
      _free : ArrayList(u32)
    )
  )
);
// impl(generic(T : Type), Arena(T), {
//   new     : () -> Self
//   alloc   : (self, own(value) : T) -> Handle(T)        // reuses a free slot, bumps its generation
//   get     : (self, h : Handle(T)) -> Option(*T)        // .None on a stale generation — never UB
//   remove  : (self, h : Handle(T)) -> Option(T)
//   clear   : (self) -> unit                              // drops every value, bumps every generation
//   len / iter …
// })
```

Properties: values have no RC header of their own (the arena's buffer holds
them inline); a `Handle` is 8 B, `Copy`, `Send`-neutral; a stale handle is a
generation mismatch → `.None`; dropping the arena drops every value once.
Uses inside the compiler: the `TypeValue` intern table (a `u32` type id is
the natural representation the hash-consing plan wants), `Symbol` tables
(`EVALUATOR_MEMORY_REDUCTION.md` Phase 5b), the frame name index. This is
the "arena" that helps the compiler — by replacing pointers with indices, not
by changing when memory is freed.

Steps: write `std/collections/arena.yo` + `arena.test.yo` (alloc/get/remove/
stale-handle/clear/iteration; a `Dispose`-counter leak test per the memory
note "leak gates need a Dispose counter"); document in `docs/en-US` and
`docs/zh-CN` (`COLLECTIONS` page); verify contracts for `get` (`requires`
none; `ensures` result is `.None` when generation differs) with `yo verify`.

### 4.2 Option B — scoped arena for RC object cells (prototype, gated)

**Surface (std):**

```rust
// std/mem/arena.yo (sketch)
Arena :: ref(struct(_id : usize));   // opaque; !Send by construction (non-atomic ref)
// Arena.scope(f) : run `f` with a fresh arena as the innermost allocation
// policy for REFERENCE-COUNTED OBJECT CELLS constructed during f; when f
// returns, every cell still referenced from outside the arena is a panic,
// otherwise the arena's memory is released in bulk. The result type R must
// not contain a reference type (`type_contains_rc_type(R) == false`) — the
// static half of the escape rule; the dynamic half (§3.2) covers globals,
// captures and caches.
// scope : (fn(generic(R : Type), f : Impl(Fn() -> R), where(R <: !Rc)) -> R)
```

The static result-type rule needs a NEGATIVE marker constraint. Both halves
exist: `Rc` is one of the fixed env markers (`trait_checking.yo:227-231`,
with `Send/Comptime/Acyclic/Runtime`), and negated where-clause entries are a
first-class shape (`WhereConstraintEntry.is_negated`,
`_add_where_clause_constraint(some_ty, trait_ty, is_negated)` in
`evaluator/types/function.yo`, feeding `SomeT.negative_trait_types`). The
collector (`function.yo:2042-2080`) recognizes a negated constraint as a
`!` prefix call on the TRAIT side, so the spelling is `where(R <: !Rc)`.
If the marker check turns out not to reach a nested `R` (a result type that
merely CONTAINS an `Rc` field), the rule becomes a dedicated evaluator check
on `Arena.scope`'s result type using `type_contains_rc_type`
(`types/utils.yo:511`), which is the predicate the marker should reduce to.

**Runtime (emitted C, `gc_runtime.yo` + a new `c/arena.yo`):**

- Thread-local `__yo_arena_top` (NULL = heap). Chunks of 64 KiB (bump);
  each cell prefixed by an 8 B size word so the reset can walk cells.
- Every `__yo_new___yo_tN` constructor calls `__yo_obj_alloc(sizeof)` instead
  of `__yo_malloc`; it bumps from the arena when one is active and sets
  `gc_flags |= __YO_GC_ARENA`. Cost when no arena is active: one TLS read
  per construction — on Darwin a `_tlv_get_addr` call, which the decr fast
  path was specifically restructured to avoid (`gc_runtime.yo:384-395`).
  Mitigation: a process-wide `static int __yo_arenas_ever_used` checked
  before the TLS read, so programs that never open a scope pay one predictable
  branch.
- `__yo_obj_free(ptr)` = `if (!(flags & ARENA)) __yo_free(ptr)`; used by
  `__yo_decr_rc`, `__yo_decr_rc_tracked`, the atomic decrements, the
  collector's sweep, the async runtime's future frees.
- Reset: unlink tracked cells from the GC lists; trial deletion over the
  arena set via `traverse_fn`; panic on any externally-referenced cell;
  otherwise release chunks. `traverse_fn` emitted for EVERY ref type when the
  program uses `Arena.scope` (the existing `needs_cycle_gc`-style pre-scan
  decides).
- The eight hatches in §5 each get their one-line check.

**Interaction with `--allocator`:** none — chunks come from `__yo_malloc`, so
`system`, `mimalloc` and `fixed` all work underneath.

### 4.3 Option E — Perceus-style reuse (noted, separate plan if pursued)

At a `___drop(x); y := T(...)` pair where `x` is the last reference and
`sizeof` matches, reuse `x`'s cell for `y`. Pure codegen, no lifetime, no
allocator change; removes a malloc/free pair per reused site. Gated like every
dup/drop optimizer change (emit-diff + over-cancellation canary). It is the
RC-native answer to "allocation churn" and does not need this document's
machinery.

## 5. The escape hatches Option B must close (checklist)

| #  | hatch                                                    | closure                                                                                     |
| -- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1  | returning an RC value from the scope closure             | static: result type must not contain `Rc` (`where(R <: !Rc)`, or `type_contains_rc_type`)   |
| 2  | storing an arena cell into an outer object / global      | dynamic: trial deletion at reset → panic                                                    |
| 3  | closure capture that outlives the scope                  | dynamic (the closure's capture struct is a heap cell referencing the arena cell)             |
| 4  | caches keyed process-wide (memo tables)                  | dynamic                                                                                     |
| 5  | `Iso(T)(v)` / `arc(v)` / `atomic(ref)` construction      | constructor check on `__YO_GC_ARENA` → panic                                                |
| 6  | `Channel.send` of a `Send` payload that is an arena cell | impossible: non-atomic cells are not `Send`; atomic cells are heap-allocated (§3.4)          |
| 7  | raw pointers / `unsafe.cast` / `&(cell.field)`           | `unsafe` — the pragma'd trusted base owns it, as for every raw pointer today                 |
| 8  | async: a future created in scope, awaited after          | the future's state machine is a heap cell referencing arena cells → dynamic (2); document that `Arena.scope` bodies should not spawn tasks that outlive them |

## 6. Go/no-go for Option B, and the plan if "go"

**Why the prototype must be measured before it is designed further.** The
only benefit Option B can deliver is throughput and locality for phase-
structured programs (a parser per request, a frame's scratch objects, a
compiler pass whose results are copied out as values). On the 2026-08-22
profile of `check` (`YO_SELF_ENV_SHARING.md` §3b) `malloc/free` were ~16% of
CPU and `memset/memmove/memcmp` ~7%; `__yo_decr_rc` another ~16% — but in the
compiler nearly every object escapes into a table (which is the whole memory
story next door), so the compiler is the WRONG benchmark. Build the runtime
half first and measure on two synthetic programs (a tokenizer over 100 MB
that allocates per token and copies out counts; a request loop that builds a
100-node object graph per iteration and returns a scalar).

- **P0 — runtime prototype (C only, behind `YO_ARENA_PROTO=1` in codegen):**
  `__yo_obj_alloc/free`, the TLS + `ever_used` gate, chunk bump, reset
  without the escape check. Measure the NO-arena overhead on the self-compile
  (the one branch + TLS read per construction; must be ≤1% wall) and the
  arena win on the two synthetic programs. **No-go if the win is <15% wall on
  the synthetic programs or the no-arena overhead exceeds 1%.**
- **P1 — traverse-for-all + the reset escape check** (§3.2), the eight hatch
  checks (§5), panics with type + site. Tests: every hatch has a test that
  PANICS (the memory rule: a safety check needs a red-first adversarial
  probe), plus nested scopes, cycles inside an arena (must free), an
  `unwind` out of a scope (must reset), the collector running mid-scope.
- **P2 — std surface** `std/mem/arena.yo` (`Arena.scope`), docs in both
  languages, the `where(!(R <: Rc))` static rule (or a dedicated evaluator
  check if the marker spelling is not accepted), `yo verify` contracts.
- **P3 — measurement + decision**: publish the two synthetic numbers and the
  self-compile overhead in this document; decide whether the feature ships
  or is archived with its numbers.

## 7. What NOT to do (from this research)

- Do not route `GlobalAllocator.malloc/realloc` through an arena (§3.3).
- Do not add lifetimes or region annotations to types to get static arenas.
- Do not use an arena to hold the compiler's evaluation state: it retains
  by design; the fix for that is `../EVALUATOR_MEMORY_REDUCTION.md`.
- Do not make `Arena.scope`'s escape check optional in release builds: the
  check is the soundness argument; without it the feature is Odin's footgun
  with RC on top.

## References

- `plans/reference/FIXED_REGION_ALLOCATOR.md` §0 (why bump allocation was
  rejected for the fixed region; the one-allocator decision).
- `plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md`, `REF_REFERENCE_SEMANTICS.md`,
  `docs/en-US/CYCLE_COLLECTION.md`, `docs/en-US/THREAD_SAFETY.md`,
  `docs/en-US/ISOLATED.md`, `docs/en-US/ARC.md`, `docs/en-US/MEMORY_SAFETY.md`.
- `plans/backlog/RC_HEADER_SPLIT.md` (header layout; tracked/untracked split;
  the census that shows 1.5 B gross constructions vs 120 M live).
- Prior art: Zig `std.mem.Allocator` / `FixedBufferAllocator`; Odin
  `context.temp_allocator`; Apple autorelease pools (scoped RC release);
  Cyclone / MLKit region inference; Verona regions; Rust `bumpalo`,
  `typed-arena`, `slotmap`; Koka/Lean Perceus ("Perceus: Garbage Free
  Reference Counting with Reuse", Reinking, Xie, de Moura, Leijen, PLDI 2021).
