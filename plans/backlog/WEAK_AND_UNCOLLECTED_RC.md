# Rust's `Rc` and `Arc` in Yo: `Weak`, the uncollected build, and the `Arc` bound

**Status: BACKLOG — drafted 2026-10-21 at the maintainer's request** ("If I
want rust like Rc without cycle collector and rust like Arc without Acyclic
constraints, how would you suggest we do that? I also want to introduce
Weak"). It reopens decision 46's "No `Weak`: the cycle collector stays"
(`plans/VALUES_BY_DEFAULT.md` §4, amended the same day to point here) and
settles the `UnsafeRc`/`UnsafeArc` question the maintainer raised first:
**no second handle type** (agreed 2026-10-21). W1 (`--cycle-collector
off`) was built 2026-10-22 (§1, "As built"). **W2 is implemented
(2026-10-22, `feat/arc-without-acyclic`):** `Arc` and the std/sync and
thread APIs carry no `Acyclic` bound, and the sync containers' declared
`Acyclic` impls are gone (the marker is derived). ARC.md and DESIGN.md lost
the `Acyclic` sentence and gained a Cycles section that breaks a cycle by
clearing its back edge; §2's "gain the ArcWeak one" moves to W4, since
`ArcWeak` does not exist before it. The other phases have not started.

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
5. **`Acyclic` stays, as a derived-only structural marker** (maintainer,
   2026-10-21: "in some cases we might want to define a type that
   disallows forming a reference cycle"). Once the walk ignores `Weak`
   edges, `T <: Acyclic` means "the strong edges reachable from `T`
   cannot form a cycle": the type's ownership graph is a tree or a DAG
   by construction, which Rust can state only by convention. It costs
   nothing at runtime and derives like `Send`. The DECLARED form
   (`impl(T, Acyclic())`, trusted) is deleted with the collector: its
   only consumer was the tracking exemption, and a bound satisfied by
   assertion guarantees nothing (§4).
6. **The end state is Rust's: no cycle collector** (maintainer,
   2026-10-21, agreeing with the staged recommendation). Arenas do not
   replace the collector — they cover phase-structured data, the
   collector covers long-lived mutable graphs with back edges — but
   `Weak` does, by making the author name the back edge, and that is the
   model the rest of the language has converged on. The deletion is
   staged (§7, W6): `Weak`/`ArcWeak` and a leak oracle that works under
   every allocator land first, `Off` becomes the default for one release
   to measure what is left, then the collector, `Trace`, the declared
   `Acyclic` form and the large header are deleted (the derived `Acyclic`
   marker stays, verdict 5). What the deletion buys beyond the
   runtime: deterministic `Drop` everywhere, and an `Rc` payload may
   carry a reference (`Rc(&(T, p))`, Rust's `Rc<&'a T>`), because O9's
   reason — drops at an unbounded later time — is gone.

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
- **As built (W1, 2026-10-22).** Where the text above left a choice, the
  simplest one consistent with it:
  - The flag sets `CodeGenContext.cycle_collector_off`, and
    `compute_needs_cycle_gc` returns early on it, so `Off` is exactly the
    program a type set with no cycle root already compiles to. That
    program's header is the lightweight runtime's 8-byte
    `__yo_ref_header_t` (`ref_count u32 | type_id u16 | borrow_count u16`),
    not the cycle-GC program's 16-byte small header: below the 16 bytes
    promised above. That header has no `gc_flags` byte and no `dispose_fn`
    (dispose dispatches on `type_id`), while §3.2–3.3 put the weak count
    and `__YO_RC_DEAD` in the packed word beside `gc_flags`. W3 must
    therefore lay the weak count and the dead flag out in the lightweight
    header as well, or switch `Off` to the small header at that point. The lightweight runtime already defines `Gc.collect()`
    as a no-op and `Gc.tracked_count()` as 0, so std/gc is unchanged apart
    from its doc.
  - The runtime declares `__yo_cycle_collector_off()`, beside
    `__yo_debug_heap_on()`. It returns the FLAG, not the runtime selected
    from it, so `tests/cycle_collector.test.yo` reads its mode through an
    `extern "Yo"` and flips its expectations: tracked counts become 0, and
    `Drop` counters stay put for every garbage cycle. A broken `Off` that
    still emitted the collector fails that file instead of passing it as
    `Auto`. There is no public `Gc` API for the mode: W6 deletes `std/gc`.
  - `yo compile` and `yo test` take `--cycle-collector auto|off`, and
    `yo test` forwards it to every batch compile. `build.cycle_collector`
    is on `Executable` only, beside `allocator`; the library artifacts take
    no allocator either. It reaches `__yo_build_executable` as a tenth
    positional argument. A seed's builtin reads nine and ignores the
    tenth, so no new builtin was needed and `std/build.yo` stays buildable
    by the seed (no Generation A). The build runner adds
    `--cycle-collector off` to the child argv only for `off`, so a default
    build's argv and artifact stamp are unchanged.
  - The leak witness under `Off` is `--allocator fixed --debug-heap`'s
    `live at exit: N blocks` line, pinned by the cli-case
    `cycle-collector-off-leaks-a-cycle-the-debug-heap-reports`. The
    language suite runs `tests/cycle_collector.test.yo` under `Auto`, and
    the cli-case `test-cycle-collector-suite-under-off` runs it under
    `Off`. `build-cycle-collector-off` pins the build path.
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
- The S2 issue above is retired as a LEAK by this step and stays open as
  a DERIVATION bug: a derived marker that answers a recursion through an
  atomic cell coinductively is wrong whether or not std requires it, and
  user bounds will (verdict 5). The fix is the inductive answer for a
  cycle through a cell, with `Box`/value recursion still acyclic; the
  reproducer becomes a derivation test (W5).
- This holds with or without the collector: an `Arc` cycle and an `Rc`
  cycle are the same leak once the collector is gone, broken the same way,
  and a bound on one handle but not the other would be incoherent.
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

## 4. `Acyclic`: derived only, `Weak` edges excluded

The trait stays in the prelude as a structural marker with one meaning:
no cycle of STRONG edges is reachable from a value of `T`. Three changes:

- **`Weak`/`ArcWeak` edges are not edges** for the derivation (W3): a
  node type with strong children and a weak parent is `Acyclic`; with a
  strong parent it is not. The same exclusion applies to the collector's
  `traverse_fn` while the collector exists (§3.4), so the two walks agree.
- **The declared form goes at W6:** `impl(T, Acyclic())`,
  `g_declared_acyclic_ids`, the pragma rule in `src/evaluator/values/impl.yo`
  and decision 21's `impl(TypeValue, Acyclic())`. Until then, with the
  collector still running, the declaration keeps its one consumer (the
  tracking exemption) and its pragma, which W5 drops as planned (a wrong
  claim leaks, it never dangles). A type that is recursive through `Rc`
  either breaks its back edge with `Weak` or does not claim the bound.
- **The derivation bug** (the S2 issue: a coinductive answer for a value
  struct that reaches itself through an atomic cell) is fixed on its own
  at W5, because the derived marker is what user bounds will read.

Where it is required: nowhere in std after W2 (`Arc` and the sync types
drop it, §2; Rust's `Arc` has no such bound, the bound is viral through
every generic wrapper around an `Arc`, and it rejects graphs that are torn
down explicitly). It is offered: any `where(T <: Acyclic)` a user or a
library writes — a server's session store, an embedded object pool, an
API that promises not to leak — and a possible `yo check` lint under
`--cycle-collector off` (§5, open question 4).

## 5. Open questions, with positions

1. **The default.** `Auto` (the collector) or `Off` (Rust)? Position
   (revised 2026-10-21 with the maintainer's agreement to delete the
   collector): `Auto` stays the default only until W3 and W4 land; then
   `Off` is the default for one release, and W6 deletes `Auto`. Yo is
   written by models, and a leaked cycle is the mistake a model makes
   most quietly, which is why the safety net is replaced before it is
   removed: `yo test --allocator debug` fails a leaking test, and the
   oracle names the cycle.
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

## 6. Deleting the collector, and `Acyclic` with it (W6)

**Preconditions, all three:**

1. `Weak(T)` and `ArcWeak(T)` have shipped in a seed (W3, W4), so every
   parent pointer and back edge in std, the compiler and the tests has its
   remedy.
2. A leak oracle that works under every allocator: `--allocator debug`
   and `yo test --allocator debug` (`ZIG_ADOPTION_CANDIDATES.md` Z11;
   today's `--debug-heap` needs `--allocator fixed`). It is what makes a
   leaked cycle a failing test rather than a silent cost.
   *Built 2026-10-23 (Z11 "As built" in that file):* the report prints
   `live at exit: B blocks / S bytes` like `--debug-heap`, lists live blocks
   by allocation number, and fails a run (status 23) or a test
   (`Memory leak detected`) whose `main` returned with a live block, which
   is the per-test count W6a records over the corpus.
3. One release with `Off` as the default (W1's knob flipped), with the
   count of tracked types left in std and `src/` and the oracle's leak
   report over the test corpus recorded in this file. If what remains is
   parent pointers, delete.

**What the deletion removes:**

- the emitted collector (`src/codegen/functions/gc_runtime.yo`'s tracking
  lists, possible roots, trial deletion, CollectWhite, resurrection),
  `__yo_gc_register`, the `traverse_fn` derivation and the `Trace`
  trait with its hand-written impls on the buffer-owning collections,
  `std/gc` (`collect`, `tracked_count`), `YO_GC_THRESHOLD` and
  `YO_GC_FULL_PCT`;
- the large header: every cell gets the 16-byte header
  (`RC_HEADER_SPLIT.md` becomes the only layout), `compute_needs_cycle_gc`
  and `can_type_form_rc_cycle` go;
- the DECLARED `Acyclic` form: `g_declared_acyclic_ids`, the pragma rule
  in `values/impl.yo`, decision 21's `impl(TypeValue, Acyclic())` and the
  48 declarations on the compiler's containers; the trait itself, its
  primitive impls and the structural derivation in `trait_checking.yo`
  STAY (§4), beside `Send`, `Sync`, `Copy`, `Escapable` and
  `TrivialDrop`; the isolated-transfer type's bound already went with
  that type (`MACRO_AND_ISO_REMOVAL.md` Part A, 2026-10-21);
- `--cycle-collector` itself, once `Off` is the only mode;
- the docs: `CYCLE_COLLECTION.md` (both languages) is replaced by the
  draft's end state (a page on `Weak`, leaks and the oracle), `ARC.md`
  loses its `Acyclic` paragraph, `MEMORY_SAFETY.md`'s collector sentences
  go.

**What it changes in the design:** `Drop` runs at one deterministic point,
the last handle's drop; O9's `Escapable` bound on `Rc`/`Arc` payloads
loses its reason, so `REFERENCES_AND_ORIGINS.md` O9/O10 and §3.1's
"`Rc<&'a T>` stays closed" row are amended to Rust's rule; the verifier's
exclusion of `Rc`-reaching values keeps its other reason (aliasing).

## 7. Phases

| Phase | Lands | Gate |
| --- | --- | --- |
| W1 | `--cycle-collector off` and `build.cycle_collector`: codegen forces the lightweight runtime; `Gc` no-ops; docs | the cycle-collector test suite runs under both modes with the leak expectations flipped (`tests/cycle_collector.test.yo` collected under `Auto`, leaked and reported by `--debug-heap` under `Off`); a cli-case for the flag; the fixpoint |
| W2 | `Arc` without `Acyclic` (std/sync, thread, prelude); `ARC.md` and `DESIGN.md` in both languages; the S2 issue retired, its reproducer kept as a derivation test | `tests/send_sync.test.yo`; an `Arc(Mutex(Node))` cycle compiles and `--debug-heap` reports it |
| W3 | `Weak(T)`: the weak count in the freed 16 bits, `downgrade`/`upgrade`/`new`/counts/`ptr_eq`, `Clone`, the dead flag, the two free paths, `traverse_fn` skipping `Weak` | upgrade after the last strong is `.None`; the allocation is freed at the last `Weak` (`--debug-heap` count); a parent pointer through `Weak(RefCell(Node))`; a cycle broken by a `Weak` is untracked under `Auto` and leak-free under `Off`; an `upgrade` from a `Drop` during CollectWhite returns `.None`; ASan on all of it |
| W4 | `ArcWeak(T)` with atomic counts; `Send`/`Sync`; ARC.md and DESIGN.md (both languages) gain the `ArcWeak` sentence deferred from W2 | the W3 rows across a `Thread.spawn`; TSan |
| W5 | the derived `Acyclic` walk ignores `Weak` edges and answers a cycle through a cell inductively (the S2 derivation fix); the declared exemption without the pragma; `yo fix` drops the `SAFETY:` comments in std | `tests/send_sync.test.yo` rows: a weak-parent tree is `Acyclic`, a strong-parent one is not, `Option(Box(Self))` and `ArrayList(Self)` stay `Acyclic`; the S2 reproducer's types not `Acyclic`; an object holding a cyclic cell behind an `Option` or a pointer not `Acyclic` (`issues/2026-10-22-an-object-holding-a-cyclic-cell-behind-an-option-or-a-pointer-derives-acyclic.md`, found at W2) |
| W6 | the default flips to `Off` for one release (the measurement of §6), then the collector, `Trace`, the declared `Acyclic` form, the large header and the knob are deleted (the derived `Acyclic` marker stays); docs in both languages; the origins plan's O9/O10 amended | §6's three preconditions recorded as met; the fixpoint and the memory ratchet (headers shrink); `yo test --allocator debug` green over the corpus with no collector |

Each phase is one PR; W3 is Generation A (the prelude gains the types; std
uses them on the next seed). The user-facing text is written with the
phases, not ahead of them: W1 adds a section to `docs/en-US/CYCLE_COLLECTION.md`
(both languages), W3/W4 add a `Weak` page beside `ARC.md`, and W6 deletes
`CYCLE_COLLECTION.md` and moves what survives (leaks, `Weak`, the oracle)
into `MEMORY_SAFETY.md`. A transitional draft of the collector page was
written and withdrawn on 2026-10-21: it would have documented only what
W6 removes.
