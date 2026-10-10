# Lifetime-replacement patterns: the complete toolbox

**Status: BACKLOG — the pattern inventory behind the no-lifetimes position
(decision 43), written 2026-10-10 at the maintainer's request.**
Companion to [`RUST_REFERENCE_PATTERNS.md`](RUST_REFERENCE_PATTERNS.md):
that catalog is organized by **Rust idiom** ("what replaces
`struct Lexer<'a>`?"); this one is the inverse view — every mechanism Yo
has or has planned that covers a job a lifetime does, what each costs,
the selection rules for choosing among them, and the exact boundary no
pattern covers (decision 43's recorded growth-path triggers). Rule numbers
(`R1`–`R7`) are [`NON_ESCAPABLE_TYPES.md`](NON_ESCAPABLE_TYPES.md)'s;
decision numbers (`D18`, `D43`, …) are `VALUES_BY_DEFAULT.md` §4; bare
`§`-references are RUST_REFERENCE_PATTERNS sections.

---

## The position

The claim this document supports, stated so it survives a skeptical Rust
programmer:

> Everything a safe Rust program computes, a safe Yo program can
> compute, with the same memory safety and no garbage collector.
> Rust's lifetime-carrying structures become one of a finite, teachable
> set of patterns — hold the reference within a frame (Group I), or
> own / share / index / re-derive beyond it (Group II). What differs is
> not capability but where the checking happens and what the sharing
> costs: within a frame, identical shapes; beyond a frame, Yo stores a
> visible address (`Rc`/index/cursor) where Rust stored a borrow, and
> checks staleness at runtime instead of proving it at compile time.

Three qualifications make it honest, and each is a section here:

1. **Same tasks, not same idioms.** The residue where the Rust *shape*
   has no Yo counterpart is catalogued
   (RUST_REFERENCE_PATTERNS §14: scoped threads, stored borrowing
   iterators, multi-root contexts); every row has a working answer at
   task level. "Same idioms" would be false; "same tasks" is true, and
   it is what this toolbox demonstrates.
2. **The guarantee relocates, it does not vanish.** A lifetime bug is a
   compile error; a Group II staleness bug is a checked runtime failure
   — bounds panic, `RefCell` panic, generation mismatch — never UB
   (SAFE_MODE). Group III states the trade once.
3. **The compile-time boundary is one shape, and it is recorded.** The
   only thing Yo declines to even express — proving, at compile time,
   that a multi-root borrow kept beyond its frame is fresh — is
   decision 43's parked `generic(r : Region)` path with measurable
   triggers (§6, item 4).

And the comparison is not one-way: on the index pattern Yo's ceiling is
*higher* than Rust's — the verifier proves `index-in-bounds` and elides
the check (CP2b) where Rust has no story at all for id freshness. Same
tasks, same memory safety, visible cost on one pattern, checked rather
than proved staleness — and proofs Rust does not have where ids and
contracts are involved.

## 0. What a lifetime does — three jobs, one axis

A Rust lifetime serves three jobs at once:

| Job | Rust mechanism | Example |
| --- | --- | --- |
| **E — express** a value that IS a borrow, within one frame | `&'a T` in a scoped struct, `-> impl Iterator<Item = &'a T>` | `Lexer<'a>`, `Entry<'a, K, V>` |
| **S — store** a borrow beyond its frame | `'a` on a long-lived struct, a cell, another thread | `Vec<&'a T>` registries, `Parser<'src, 'arena>` |
| **V — verify** both: no dangling, `&mut` exclusive | the borrow checker over region names | every `E0502` |

Yo's split: **E and V are covered inside one frame by the reference type
itself** (`&T`/`&mut T`, second-class, checks intraprocedural — D43,
R1–R7); **S is never covered by borrows at all** (second-classness: a
cell never holds a reference) and is replaced by *address-like data plus
ownership of the owner*. The patterns below are the complete list of
replacements, in four groups; the frame is the axis — everything in
Group I dies at the frame's end, everything in Group II survives it.

## 1. Group I — within a frame (jobs E and V)

The reference machinery of decision 43 and NON_ESCAPABLE_TYPES. Each row
replaces a lifetime-parameterized Rust form with the same machine code
and no name:

| # | Pattern | Replaces | Spec |
| --- | --- | --- | --- |
| I1 | **Hold the reference** — `xs : &ArrayList(T)` in a struct; second-class, one frame | `struct S<'a> { r: &'a T }` scoped to a frame | R1, R2 |
| I2 | **Single-root return, inferred** — a reference-holding result whose every root is a parameter | `fn longest<'a>(a: &'a [u8], b: &'a [u8]) -> &'a [u8]` and lifetime unification | R3 |
| I3 | **`depends(...)` narrowing** — say which parameter the result borrows | choosing among `'a`/`'b` on multi-parameter returns | R3 |
| I4 | **Root-joining containers** — `ArrayList(&T)` whose roots grow with every `&` pushed | `Vec<&'a T>` built and used in one frame | R7 |
| I5 | **Projections** — `fn(self : &Self, i) -> &T` / `-> &mut T`, bindable | `Index::index`/`Deref`-returning methods | D24, D43 |
| I6 | **The borrowed `for`** — `for(&xs, …)` through `impl(&C, IntoIterator)` | `for x in &xs`, `impl IntoIterator for &'a C` | D39 |
| I7 | **Guard values as structs** — `LockGuard(T)` holding `&mut Mutex(T)`, `Dispose` unlocks | `MutexGuard<'a, T>` | §3.2 |
| I8 | **Closure-scoped borrows** — `with`/`with_lock`/`with_mut` bodies; the borrow is the closure's scope | stack-scoped lending closures | D41 |

Selection rule: if the borrow's life is one frame, never leave Group I —
this is Rust's own zero-cost case, and the spelling is the same minus the
name.

## 2. Group II — beyond the frame (job S): address-like data

A value that must survive the frame stores an *address*, never a
reference. The shapes, in Yo's order of preference (§1's table, extended):

| # | Pattern | The Rust form it replaces | Cost | Use when |
| --- | --- | --- | --- | --- |
| II1 | **Own it** — the field holds `T` (recursive children in `Box(T)`) | owned structs (no lifetime needed) | a move or `.clone()` at the boundary | this structure is the sole owner for its whole life |
| II2 | **Share it** — `Rc(T)`/`Arc(T)`; `Rc(RefCell(T))` when mutated through the handle (D41) | `Rc<T>`/`Arc<T>` (+ `RefCell`) | one allocation, count traffic; marks only inside the `RefCell` | aliasing is real and long-lived |
| II3 | **Index it** — `usize`/key into an owner living elsewhere; **generational ids** where slots are reused; interning where the id IS the identity (§4.3) | `&'a T` fields, arena borrows | a bounds/lookup per access; the owner must outlive the ids (structurally) | graphs, caches, interners — often *faster* than a pointer (§12) |
| II4 | **Cursor/re-derive** — a `Copy` offset or `Range(usize)`, the place re-derived through a named owner at each use | `&'a [T]` sub-slices kept as data | one bounds check per re-derivation | zero-copy views that must survive as plain data |
| II5 | **Borrowed-or-owned enum** — `StrArg :: enum(Borrowed(str), Owned(String))` | `Cow<'a, str>` | a tag | an API that accepts either |
| II6 | **Share it frozen** — `Rc` to nodes built immutable after construction (D21's trees) | `Rc<Node>` with no `RefCell` | one allocation, count traffic; never a mark | read-mostly trees; the write happens by rebuilding |
| II7 | **Runtime handle** — the owner is a runtime: file descriptors, sockets, `JoinHandle` | `'static`-ish resource ids | none in the type; close is the drop | the object already lives behind an OS/executor boundary |
| II8 | **Move the owner** — transfer the whole graph; `^v` (`Iso(T)`) across threads | ownership transfer, `move` into a task | a uniqueness check at the move | one consumer at a time is the truth |

**The composition maxim: indices for storage, borrows for access.** A
stored id is never dereferenced bare; every use goes through a lending
method on the owner, which bounds-checks and hands back a reference under
the single-root rule:

```yo
Forest :: struct(nodes : ArrayList(Node));            // the one owner, a rooted value
Node   :: struct(value : i32, children : ArrayList(usize), parent : Option(usize));

parent :: (fn(self : &Forest, id : usize) -> &Node)(self.nodes(id));   // I2 + II3
```

The arena is the root; the index is the address; the borrow is the
checked capability. This composition is what replaces
`struct Parser<'src, 'arena>` — two arenas, plain `usize` fields, no
region ever named — and it is *strictly more storable* than a Rust
reference: `Copy`, cell-compatible, `Send`, serializable, and it survives
the owner's buffer reallocation (§4.1), which a Rust reference does not.

## 3. Group III — verification substitutes (job V)

What checks the patterns above. Each replaces a slice of the borrow
checker's job, at a different point on the static/dynamic axis:

| # | Mechanism | Replaces | Failure mode |
| --- | --- | --- | --- |
| III1 | **Frame-scoped borrow checking** — freeze until last use, exclusivity (D18, D28; E0901/E0911) | NLL within one function | compile error, names the places |
| III2 | **The single-root rule** (R3) + caller-side freezing | lifetime unification on returns | compile error at the `return` |
| III3 | **Mutation summaries** (§3.10 outcomes (a)/(b)/(c)) | proving a shared write exclusive | compile error naming `RefCell`/`get_mut`, or a plain write |
| III4 | **`RefCell(T)` marks** (D41) | `RefCell` in Rust | panic at `with_mut`/`get_mut` entry |
| III5 | **Bounds checks + generation counters** — the index pattern's net | (Rust has no stored-id checker) | panic on stale/out-of-bounds; generation catches slot reuse |
| III6 | **The cycle collector** | `Weak<T>` bookkeeping | no failure mode; untracked cycles leak only where the write-site scan says none exist (§3.12) |
| III7 | **The verifier** — `distinct`, `index-in-bounds` proved once, the check elided (CP2b) | nothing in Rust: a proof Rust never gives ids | proof obligation, `assumed()` if skipped |
| III8 | **`pragma(AllowUnsafe)`** — raw pointers, `addr_of` | Rust's `unsafe` | the same risks, less tooling |

The trade the whole toolbox makes, stated once: **a lifetime bug is a
compile error; a Group II staleness bug is a checked runtime failure** —
bounds panic, generation mismatch, `RefCell` panic — never UB (SAFE_MODE),
and provably elided where III7 applies. Rust buys compile-time diagnosis
of staleness at the price of the region algebra; Yo spends that budget on
intraprocedural checking instead.

## 4. Group IV — structural rewrites (algorithm-level)

When no data shape fits, restructure the algorithm. These are the
patterns the porting guide should teach as moves, not concessions:

| # | Move | Replaces | Where |
| --- | --- | --- | --- |
| IV1 | **Split by root** — one struct per lifetime parameter | `Ctx<'a, 'b>` with fields lent from different callers | §14 row 1 |
| IV2 | **Two-phase: build with ids, then freeze** — construct the graph over indices, close it, never store a borrow | incremental borrows during construction (`&mut Vec` juggling) | rustc's own HIR pattern |
| IV3 | **Arena-per-phase** — a bump arena plus ids; *placement, not lifetime* (`std/arena.yo`) | `'arena` region threading | §4.6 |
| IV4 | **Collect-then-apply** — gather mutations, apply them after the borrow ends | re-entrant `&mut` under iteration | §7.2 |
| IV5 | **Own-the-sink / return-the-value** — `ToString` returns `String`; no `Formatter<'a>` to borrow | sink borrows threaded down a call tree | §3.5 |
| IV6 | **Store inputs, re-derive views** — `word_ranges()` returns `Copy` offsets; views are never stored | `Vec<&'a str>` kept as data | §2.2 |

## 5. The selection table

| You need to… | Reach for | Not this |
| --- | --- | --- |
| return a view, cursor, guard or entry from a function | I2 (+I3 to narrow) | naming a region |
| keep a list of borrows for this frame | I4 (root-joining) | `Rc` per element |
| keep borrows past the frame | II3/II4 (index/cursor), II1/II2 (own/share) | a stored reference (E0909 by construction) |
| a graph with parent pointers | II3 (arena+ids) or II2 (`Rc(RefCell)`) — §4.1's chooser | `Weak` (the collector is the `Weak`) |
| zero-copy parsing with a remainder | I2 returning `(View(u8), T)`, or IV6 offsets | storing the remainder |
| share mutable state, many writers | II2 `Rc(RefCell)` / `Arc(Mutex)` | interior mutability through `&T` |
| single writer, many readers | II1 own + II6 frozen sharing | a lock |
| cross threads with shared data | `Arc` + `Sync`, or II3 (ids are `Send`), or II8 `^v` | a reference (never `Send`) |
| mutate a container while walking it | IV4, or `indices()` (D39) | mutation under a cursor (E0911) |
| a long-lived cache of entries | II3 ids or II2 handles | `Vec<&'a T>` |
| a resource owned by the OS/executor | II7 the runtime handle | wrapping it in a borrow |

## 6. What no pattern covers — the boundary

Three invariants a Rust lifetime *types in* and no pattern above checks
at compile time, plus the one shape with no answer:

1. **The arena-outlives-the-ids invariant is structural, never typed.**
   `ArrayList(usize)` carries no dependency; "no id escapes its owner's
   scope" is a program property, held up by ownership of the owner and
   the runtime net (III5), not by a checker.
2. **Slot reuse without generational ids reads the wrong object
   silently.** With them (II3) it is a caught mismatch; without them it
   is a logic bug inside a safe program.
3. **Stored exclusivity.** Two ids to one slot are two writers; the
   `&mut` discipline exists only at access time (Group I), never in
   storage.
4. **The one uncovered shape**: a borrow kept beyond its frame with
   *multiple independent roots* whose staleness must be proved at
   *compile time*. Groups II–III cover every proper subset (storage
   without the proof, or the proof without the storage); only all three
   at once needs names. That is decision 43's parked `generic(r : Region)`
   growth path, armed with its recorded triggers — a porting-audit count
   of restructured multi-root algorithms, a real
   structured-concurrency pull, or the compiler's own V4/V5 rewrites
   fighting the single-root rule — answered smallest-construct-first,
   and only then.

## 7. Tooling gaps the patterns expose

- **A generational index arena in std** — slotmap-shaped `Arena(T)` with
  `Id(T)` handles, generation-protected the way `std/arena.yo` already
  protects its own allocator handles ("a stale copy can be caught").
  Closes boundary item 2 by construction and promotes II3 from a
  hand-rolled idiom to a first-class citizen. Candidate beside Z12–Z15 in
  [`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md); the
  verifier can then own `Id(T)`-in-bounds as a provable obligation
  (III7).
- Nothing else currently: the remaining gaps are boundary items 1, 3 and
  4, which are design positions, not missing tools.

## Maintenance

Parked in `backlog/` as the toolbox companion to the catalog. Detail
lives in one home per fact: RUST_REFERENCE_PATTERNS holds idiom-level
mapping and costs (§12, §14); NON_ESCAPABLE_TYPES holds the rules; this
document holds the inventory, the selection table and the boundary. When
a decision 43 phase lands (N1–N3) or a Group II candidate ships, update
the affected rows here and drop the corresponding "(planned)" markers in
the catalog; at V5 the selection table (§5) is the seed of the user-facing
"storing borrows in Yo" guide in `docs/en-US/` + `docs/zh-CN/`.
