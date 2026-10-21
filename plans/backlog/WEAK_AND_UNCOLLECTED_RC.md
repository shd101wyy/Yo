# Rust's `Rc` and `Arc` in Yo: `Weak`, the uncollected build, and the `Arc` bound

**Status: BACKLOG — drafted 2026-10-21 at the maintainer's request** ("If I
want rust like Rc without cycle collector and rust like Arc without Acyclic
constraints, how would you suggest we do that? I also want to introduce
Weak"). It reopens decision 46's "No `Weak`: the cycle collector stays"
(`plans/VALUES_BY_DEFAULT.md` §4, amended the same day to point here) and
settles the `UnsafeRc`/`UnsafeArc` question the maintainer raised first:
**no second handle type** (agreed 2026-10-21). Nothing here is started.

## 0. Verdict

1. **One `Rc`, one `Arc`.** A second handle type would split every API that
   takes a handle, and the two properties asked for are not properties of a
   handle: "collected or not" is a property of the PROGRAM's runtime, and
   "may form a cycle" is a property of a TYPE. Each gets the knob at its own
   level (§1, §2); `Weak` is what makes both safe to use the way Rust's are
   (§3).
2. **Rust-like `Rc` without the collector is a build choice:**
   `cycle_collector : .Auto | .Off` in `std/build.yo`, `--cycle-collector
   off` on the CLI, beside `allocator`. Under `Off` no cell registers, no
   traverse function is emitted, every cell gets the small header, and a
   cycle leaks unless a `Weak` breaks it: Rust's model exactly. The default
   stays `Auto` (§5, open question 1).
3. **Rust-like `Arc` is `Arc` without the `Acyclic` bound.** The bound's
   only purpose was to make an uncollectable cycle unrepresentable; with
   `ArcWeak` the cycle is breakable instead, which is Rust's answer, and the
   bound today does not even hold for a self-recursive payload
   (`issues/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.md`).
   `Mutex`, `RwLock`, `Channel` and the thread APIs drop it with `Arc`.
4. **`Weak(T)` and `ArcWeak(T)` are Rust's `rc::Weak` and `sync::Weak`:**
   `downgrade`, `upgrade -> Option(Rc(T))`, a weak count in the cell, the
   payload dropped at the last strong handle and the allocation freed at
   the last handle of either kind. They are not an edge for the collector.
   The one interaction with the collector, an `upgrade` of a cell the
   collector is freeing, is answered by a dead flag, not by the count (§3.4).
5. **Per-type exemption stays what it is:** a declared `impl(T, Acyclic())`
   keeps `T`'s cells out of the collector. With `Weak` available the
   declaration stops needing `pragma(Pragma.AllowUnsafe)` (a wrong claim
   leaks, it never dangles; §4).

## 1. The uncollected build: `--cycle-collector off`

- **Surface.** `std/build.yo` gains `CycleCollector :: enum(Auto, Off)` and
  `(cycle_collector : CycleCollector) ?= CycleCollector.Auto` on the
  artifact options, beside `allocator`; `yo compile`/`yo test` gain
  `--cycle-collector auto|off`. The runtime knob `YO_GC_THRESHOLD=0`
  (`docs/en-US/CYCLE_COLLECTION.md`) stays as the run-time form of the same
  choice; it disables the trigger but keeps the tracking code and headers.
- **What `Off` changes in codegen.** `compute_needs_cycle_gc` is forced
  false: the lightweight RC runtime is selected, no constructor calls
  `__yo_gc_register`, no `traverse_fn` is emitted, every reference type
  gets the 16-byte small header (`RC_HEADER_SPLIT.md`), `Gc.collect()` is
  a no-op and `Gc.tracked_count()` is 0. `--debug-heap`'s leak oracle
  still reports a leaked cycle at exit, which is the one way to find one
  under `Off`.
- **What it does not change.** Counting, drops, `Drop` order, the owner
  prefix, allocators, `RefCell`'s marks, `Arc`. A program that compiles
  under `Auto` compiles under `Off`; only its leaks differ.
- **Why a build choice and not a type.** The collector's cost and benefit
  are program-wide (the compiler itself runs with the collector mostly
  idle; a request server with per-request graphs wants it on), and a
  per-handle choice would make the header layout depend on which
  constructor ran, which the free path cannot read back cheaply. Rust
  made the same choice at the language level, once, for everyone.

## 2. `Arc` without `Acyclic`

- Remove `Acyclic` from `Arc`, `arc`, `Arc`'s `Send`/`Sync`/`Deref` impls,
  `Mutex(T)`, `RwLock(T)`, their unlocker types, `Channel`/`Sender`/
  `Receiver`, `Thread.spawn`'s result bound and `std/sync`'s `Acyclic`
  impls that existed only to let these nest (`std/sync/rwlock.yo`'s "O7
  residual"). `Send`, `Sync` stay exactly as they are.
- An `Arc` cycle then leaks, as in Rust, and `ArcWeak` is the tool. The
  `--debug-heap` oracle reports it.
- The S2 issue above is retired by this step with a note: the `Acyclic`
  derivation's coinductive answer through an atomic cell is still wrong for
  `Acyclic`'s remaining user, the declared exemption (§4), and keeps its
  reproducer as a derivation test, not as a leak.
- Docs: `docs/en-US/ARC.md` and `DESIGN.md` §"Arc" in both languages lose
  the `Acyclic` sentence and gain the `ArcWeak` one.

## 3. `Weak(T)` and `ArcWeak(T)`

### 3.1 Surface

```yo ignore
Weak :: (fn(comptime(V) : Type) -> comptime(Type))(...);      // the non-atomic form, in the prelude beside Rc
ArcWeak :: (fn(comptime(V) : Type, where(V <: (Send, Sync))) -> comptime(Type))(...);
impl(generic(T : Type), Rc(T),
  downgrade : (fn(self : &Self) -> Weak(T))(...)              // Rust's Rc::downgrade(&rc)
);
impl(generic(T : Type), Weak(T),
  new : (fn() -> Self)(...),                                   // a dangling Weak: upgrade is .None
  upgrade : (fn(self : &Self) -> Option(Rc(T)))(...),
  strong_count : (fn(self : &Self) -> usize)(...),
  weak_count : (fn(self : &Self) -> usize)(...),
  ptr_eq : (fn(self : &Self, other : &Self) -> bool)(...)
);
derive(generic(T : Type), Weak(T), Clone);                     // explicit-copy, like Rc after V2c
```

`ArcWeak(T)` mirrors it with `Arc.downgrade` and `upgrade -> Option(Arc(T))`,
`Send` and `Sync` iff `T <: (Send, Sync)`. `Weak(T)` is neither. Neither
has a `Deref` impl and neither auto-dereferences: the payload may be gone,
so every read goes through `upgrade`, which is the whole point of the type.
A `Weak` is never `Copy` (decision 36's wrapper rule), never matched
through (decision 31: a pattern names the wrapper it looks through, and a
`Weak` cannot be looked through).

### 3.2 The counts

The cell's packed first word is `ref_count u32 | gc_flags u8 | gc_mark u8 |
borrow_count u16`. Decision 46's Generation B made a plain `Rc` carry **no
borrow marks** (`RefCell` holds its own), so the 16 bits of `borrow_count`
are free in the `Rc` header. Position: `weak_count : u16` in those bits,
saturating — a cell whose weak count reaches 65535 stops counting and is
never freed (a leak, never a dangle; Rust aborts on count overflow). No
header grows; the memory-reduction ratchet (`EVALUATOR_MEMORY_REDUCTION.md`)
is untouched. The `Arc` header's counts are atomic and gain the same field
with atomic access. Open question 3 records the 32-bit alternative.

### 3.3 Semantics (Rust's)

- `downgrade`: `weak += 1`, returns a handle to the same allocation.
- Last strong handle dropped: the payload's drop runs (`dispose_fn`), the
  cell is marked `__YO_RC_DEAD`; the allocation is freed iff `weak == 0`,
  otherwise it stays until the last `Weak` goes. So a `Weak` never keeps a
  resource alive, only the bytes.
- `Weak` dropped: `weak -= 1`; the allocation is freed iff `strong == 0`
  (dead) and `weak == 0`.
- `upgrade`: `.Some(handle)` with `strong += 1` iff the cell is not dead;
  `.None` otherwise. `Weak.new()` points at no allocation and always
  upgrades to `.None`.
- The owner prefix and `__yo_rc_free`'s routing are unchanged: the free,
  whenever it happens, goes to the allocator that placed the cell.

### 3.4 With the collector

- A `Weak` is **not an edge**: the auto-derived `traverse_fn` does not
  visit `Weak` fields, and a hand-written `Trace` must not either (the
  rule joins the slot-pointer rule in `CYCLE_COLLECTION.md`). A cycle
  closed through a `Weak` is therefore not a cycle to the collector, which
  is what makes `Weak` the way to break one under `Off` and a way to avoid
  tracking under `Auto`: a type whose only back edge is a `Weak` reads
  acyclic to `can_type_form_rc_cycle`, so its cells are never tracked.
- **CollectWhite with weak handles.** A white cell with `weak > 0` gets its
  drop run and is marked dead, and its allocation is kept until the last
  `Weak` goes; the collector's free pass skips it. `Gc.tracked_count()`
  stops counting it (it left the tracked list), `--debug-heap` lists it as
  a weak-held dead cell.
- **`upgrade` during a collection** reads the dead flag, never the count:
  trial deletion temporarily drives live cells' counts to zero, and a user
  `Drop` running in the dispose pass may call `upgrade` on a sibling. The
  order is MarkGray, Scan/ScanBlack, then the dispose pass, so every live
  cell has its count restored before any drop runs, and every white cell is
  marked dead before the dispose pass starts. An `upgrade` of a white
  sibling returns `.None` (Rust's behaviour for a cycle member mid-drop);
  an `upgrade` of a black one succeeds and is an ordinary strong handle.
  The resurrection re-check (`CYCLE_COLLECTION.md`, PEP 442) is unchanged:
  it looks at strong counts, which `upgrade` on a dead cell never raises.

### 3.5 With the rest of the model

- **Ownership.** `Weak` is an explicit-copy value (V2c's rule for handles),
  move-only otherwise, dropped like any value; `Weak(T)` is not `Send`,
  `ArcWeak(T)` is `Send`/`Sync` with `T`. `Escapable`: a `Weak` carries no
  origins (O10). The verifier keeps `Weak`-reaching values outside its
  subset, as it does `Rc`-reaching ones.
- **`RefCell` and origins.** `Weak(RefCell(Node))` is the Rust shape for a
  parent pointer; `upgrade` yields the `Rc`, whose deref is read-only
  (decision 46) and whose `with_mut` is the write door. A `&` borrow
  through an upgraded handle has the handle's place as its origin (O9),
  which freezes the upgraded `Rc`, not the `Weak`.
- **Patterns.** `(c := Rc(p))` binds a cell; there is no `Weak(p)` pattern.

## 4. The declared `Acyclic` exemption

Unchanged in mechanism (`impl(T, Acyclic())` keeps `T` out of
`can_type_form_rc_cycle`; `src/types/utils.yo` `g_declared_acyclic_ids`).
Two changes in policy:

- It no longer requires `pragma(Pragma.AllowUnsafe)`. A wrong declaration
  leaks a cycle; it cannot dangle (the counts still govern every free).
  "Unsafe" in Yo means memory-unsafe, and this is not. The `// SAFETY:`
  comment requirement goes with it. The diagnostic that enforced the pragma
  (`src/evaluator/values/impl.yo`) becomes a note in `yo doc`.
- Its derivation bug for value structs through an atomic cell (the S2
  issue) is fixed on its own, because the exemption's structural
  derivation must still be right for `Iso` until `Iso` is deleted
  (`MACRO_AND_ISO_REMOVAL.md`) and for the collector's own predicate.

## 5. Open questions, with positions

1. **The default.** `Auto` (the collector) or `Off` (Rust)? Position: `Auto`
   stays the default. Yo is written by models, and a leaked cycle is the
   mistake a model makes most quietly; the collector turns it into a cost,
   `Off` turns it into a leak. The compiler's own build may choose `Off`
   once its trees are declared acyclic (decision 21), measured by the
   memory ratchet.
2. **Spelling: `Weak(T)` and `ArcWeak(T)`, or `Weak(Rc(T))` and
   `Weak(Arc(T))`.** The second reads as one type constructor over the
   handle kind and keeps one name. Position: `Weak(T)` and `ArcWeak(T)`,
   mirroring `Rc`/`Arc` and Rust's two modules; the handle kind is in the
   name where a reader looks first.
3. **16-bit saturating weak count or 32-bit.** 32 bits means an 8-byte
   wider small header for every cell, which the memory campaign fought
   for. Position: 16 bits saturating, with `weak_count()` reporting
   `usize.MAX` when saturated and `--debug-heap` listing saturated cells;
   revisit on a measured need.
4. **Should `--cycle-collector off` reject programs that would need the
   collector?** No: there is no such program, a cycle is legal and leaks.
   An optional lint ("a type can form an `Rc` cycle with no `Weak` on any
   back edge") is a `yo check` warning under `Off`, position: later.

## 6. Phases

| Phase | Lands | Gate |
| --- | --- | --- |
| W1 | `--cycle-collector off` and `build.cycle_collector`: codegen forces the lightweight runtime; `Gc` no-ops; docs | the cycle-collector test suite runs under both modes with the leak expectations flipped (`tests/cycle_collector.test.yo` collected under `Auto`, leaked and reported by `--debug-heap` under `Off`); a cli-case for the flag; the fixpoint |
| W2 | `Arc` without `Acyclic` (std/sync, thread, prelude); `ARC.md` and `DESIGN.md` in both languages; the S2 issue retired, its reproducer kept as a derivation test | `tests/send_sync.test.yo`; an `Arc(Mutex(Node))` cycle compiles and `--debug-heap` reports it |
| W3 | `Weak(T)`: the weak count in the freed 16 bits, `downgrade`/`upgrade`/`new`/counts/`ptr_eq`, `Clone`, the dead flag, the two free paths, `traverse_fn` skipping `Weak` | upgrade after the last strong is `.None`; the allocation is freed at the last `Weak` (`--debug-heap` count); a parent pointer through `Weak(RefCell(Node))`; a cycle broken by a `Weak` is untracked under `Auto` and leak-free under `Off`; an `upgrade` from a `Drop` during CollectWhite returns `.None`; ASan on all of it |
| W4 | `ArcWeak(T)` with atomic counts; `Send`/`Sync` | the W3 rows across a `Thread.spawn`; TSan |
| W5 | the declared `Acyclic` exemption without the pragma; `yo fix` drops the `SAFETY:` comments in std | `tests/internal` rows for the derivation; the S2 reproducer as a derivation test |

Each phase is one PR; W3 is Generation A (the prelude gains the types; std
uses them on the next seed). `CYCLE_COLLECTION_DOC_DRAFT.md` carries the
user-facing text for W1, W3 and W4 as planned sections and is promoted with
them.
