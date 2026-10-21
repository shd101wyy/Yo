# Cycle Collection

**Status: DRAFT (2026-10-21).** The replacement for
`docs/en-US/CYCLE_COLLECTION.md`, which describes the pre-VBD runtime
(`ref(struct(...))` objects, "complete thread isolation with no shared
memory", a Send table with only value types crossing threads). Promoted to
`docs/en-US/CYCLE_COLLECTION.md` and `docs/zh-CN/` at VALUES_BY_DEFAULT's
V5, when `ref(...)` is gone. The plans stay authoritative; where this draft
and a plan disagree, the plan wins and this draft is fixed. Sections marked
(planned: <phase>) describe design that has not landed. Written on the
pattern of [`OWNERSHIP_AND_BORROWING_DOC_DRAFT.md`](OWNERSHIP_AND_BORROWING_DOC_DRAFT.md),
whose section 10 is the ownership side of the same story.

Tag legend: `V2b`, `V2c`, `V5` are phases of
[`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md); `W1`–`W5` are phases of
[`backlog/WEAK_AND_UNCOLLECTED_RC.md`](backlog/WEAK_AND_UNCOLLECTED_RC.md).

---

## 1. The model in one screen

- **Only `Rc` and `Arc` cells are counted.** A struct, an enum, a tuple, a
  `Box` and every collection buffer belong to one owner and are dropped
  when it goes away. Nothing about them is counted or collected.
- **An `Rc` cell is freed when its last handle goes away** — the ordinary
  case, with no collector involved.
- **A cycle of `Rc` cells has no last handle.** The cycle collector finds
  such cycles and frees them. It is thread-local, runs on the thread that
  made the cells, and runs the payloads' `Drop` when it frees them.
- **Only cells that can be on a cycle are tracked.** The compiler decides
  per type: an `Rc(T)` is tracked when `T` can reach an `Rc` again. A
  declared `impl(T, Acyclic())` exempts a type.
- **`Arc` cells are never collected.** A cycle of `Arc` cells leaks; today
  it is made unrepresentable by `Arc`'s `Acyclic` bound (planned: W2, the
  bound goes and `ArcWeak` breaks the cycle instead, as in Rust).
- (planned: W3) **`Weak(T)` breaks a cycle without the collector.** A
  parent pointer, a cache entry or a back edge held as a `Weak` does not
  keep the cell alive and is not an edge to the collector.
- (planned: W1) **The collector can be turned off per program**
  (`--cycle-collector off`): every `Rc` is then Rust's `Rc`, and a cycle
  leaks unless a `Weak` breaks it.
- (planned: W6) **The collector is removed.** Once `Weak` and the leak
  oracle (`yo test --allocator debug`) have shipped, `off` becomes the
  default for one release and then the only mode: every cell has the
  small header, `Drop` runs at exactly one point, `Acyclic` and `Trace`
  no longer exist, and this page becomes a page about `Weak`, leaks and
  the oracle (section 12).

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio.yo");
{ RefCell } :: import("std/sync/refcell");
Gc :: import("std/gc");
Node :: struct(id : i32, peer : Option(Rc(RefCell(Self))));
form_cycle :: (fn() -> unit)({
  a := rc(RefCell(Node).new(Node(id : i32(1), peer : .None)));
  b := a;
  a.with_mut(v => {
    v.peer = .Some(b); // a -> a: a cycle no handle outside it can free
  });
});
main :: (fn() -> unit)({
  before := Gc.tracked_count();
  form_cycle();
  mid := Gc.tracked_count();
  Gc.collect();
  after := Gc.tracked_count();
  unsafe(printf("before=%lu mid=%lu after=%lu\n", before, mid, after));
});
export(main);
```

The program is expected to print `before=0 mid=1 after=0`: one tracked
cell while the cycle exists, none after the collection reclaims it. (Today
it prints `0 0 0` and leaks: the shape is not yet registered with the
collector,
`issues/2026-10-21-an-rc-refcell-cycle-is-never-tracked-by-the-collector.md`.)

## 2. What is counted, what is tracked

### Counted: `Rc` and `Arc` cells, nothing else

| Value | Freed by | Counted | Collected |
| --- | --- | --- | --- |
| a struct, enum, tuple, array, closure held by value | its owner's drop | no | no |
| `Box(T)` | its owner's drop | no | no |
| `String`, `ArrayList`, `HashMap`, every buffer-owning collection | its owner's drop (planned: V2b for the collections) | no | no |
| `Rc(T)` | the last handle's drop, or the collector | yes, non-atomic | when tracked |
| `Arc(T)` | the last handle's drop on whichever thread drops it | yes, atomic | never |

A cell's count is read with `ref_count(h)`, a debugging read.

### Tracked: an `Rc` whose payload can reach an `Rc`

The compiler decides per type at compile time whether an `Rc(T)` cell is
registered with the collector when it is made:

- `T` reaches an `Rc` — through fields, enum payloads, tuples, arrays, a
  `Box`, a `RefCell`, or the elements of a buffer-owning collection (the
  collection's `Trace` impl, section 7): tracked.
- `T` reaches no `Rc` (plain data, strings, collections of plain data,
  `Arc` handles): not tracked. Its cell has a 16-byte header and the
  collector never sees it.
- `impl(T, Acyclic())` is declared on `T`: not tracked, whatever its
  fields hold. The declaration is a claim the compiler trusts; a wrong
  claim leaks a cycle and never dangles anything. Today it requires
  `pragma(Pragma.AllowUnsafe)` and a `// SAFETY:` comment (planned: W5,
  the pragma goes, because a leak is not memory-unsafe).
- (planned, after decision 46) The predicate narrows to "reaches a
  `RefCell`, `Mutex` or `RwLock` whose payload reaches an `Rc`": a plain
  `Rc` payload is read-only through its handle, so a cycle can only be
  closed by a write through one of those. Cells of immutable graphs then
  stop being tracked.

A program with no tracked type at all gets the lightweight runtime: no
collector code, no per-cell list pointers, 16-byte headers everywhere.

## 3. How the collector runs

Reference counting frees everything that is not on a cycle, immediately.
The collector only has to find cycles, and it only looks where one can be:

1. **Possible roots.** When a tracked cell's count is decremented to a
   value above zero, that cell might be the root of a now-unreachable
   cycle; it is remembered in a per-thread buffer.
2. **Trigger.** When the buffer reaches an adaptive threshold, the
   collector runs on this thread only. Nothing stops other threads.
3. **Trial deletion** (Bacon–Rajan). From each possible root, the
   collector subtracts the references the cells hold to each other. A cell
   whose count stays above zero is held from outside the subgraph and is
   live; its subgraph's counts are restored. A cell whose count reaches
   zero is garbage.
4. **Free.** Each garbage cell's payload is dropped (its `Drop` runs, its
   fields are dropped), then the cells are freed, in separate passes so no
   drop touches a freed sibling.

The threshold adapts: a collection that reclaims nothing raises it, so a
program with a large live graph and few cycles stops paying for scans.
`Gc.collect()` forces a full scan of every tracked cell, which also finds
cycles the incremental trigger cannot see (a cycle formed by a move alone,
with no count decrement). Knobs:

| Knob | Effect |
| --- | --- |
| `Gc.collect()` | an immediate full collection on this thread |
| `Gc.tracked_count()` | the number of tracked cells on this thread |
| `YO_GC_THRESHOLD=N` | the trigger floor; `0` disables automatic collection for the process (`Gc.collect()` still works) |
| `YO_GC_FULL_PCT=N` | how far the live set may grow before a full scan (default 200, twice the live set) |
| `--allocator fixed --debug-heap` | an exit report of every block still live, which lists a leaked cycle |
| (planned: W1) `--cycle-collector off` | no tracking and no collector at compile time; see section 6 |

## 4. Drops run at collection time

A cell freed by the collector runs its payload's `Drop` at the moment of
the collection, not at the last use of any handle. Three consequences:

- **Order inside a cycle is unspecified.** Each member's `Drop` runs with
  the other members still allocated, so a `Drop` may read a sibling; it
  may not assume the sibling has or has not been dropped.
- **A `Drop` may resurrect a member.** If a `Drop` stores a handle to a
  member of the cycle into something live (a cache, a registry), the
  member and everything reachable from it are kept: the collector re-reads
  every garbage cell's count after the drop pass and leaks what came back,
  rather than freeing it under a live handle. It is reclaimed by a later
  collection once unreachable again.
- **A borrow keeps its cell alive through a collection.** A `&` borrow
  through an `Rc` handle (`&h.*.x`) freezes `h`, so `h` is not dropped
  while the borrow lives and its count stays an external reference: the
  collector classifies the cell live even if another handle to it was
  dropped in the meantime (`backlog/REFERENCES_AND_ORIGINS.md` O9). This
  is also why an `Rc` payload may not hold a reference (`Escapable`): the
  collector could run that payload's `Drop` long after the reference's
  place is gone.

## 5. `Arc`

An `Arc` cell is counted atomically and freed by whichever thread drops
the last handle. It is never tracked: a collector is thread-local, and an
`Arc` cycle can span threads.

- **Today:** `Arc(T)` requires `T <: (Send, Sync, Acyclic)`, so a cycle of
  `Arc` cells is unrepresentable. The bound is structural and does not
  hold for a payload that reaches itself through `Arc(Mutex(Self))`
  (`issues/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.md`).
- (planned: W2) The `Acyclic` bound is removed from `Arc`, `Mutex`,
  `RwLock`, `Channel` and the thread APIs. An `Arc` cycle then leaks, as
  in Rust, and `ArcWeak` (section 7) is the way to avoid one. The
  `--debug-heap` report shows a leaked `Arc` cycle at exit.

## 6. Turning the collector off (planned: W1; the default from W6)

`--cycle-collector off` (and `cycle_collector : .Off` in `build.yo`) makes
every `Rc` Rust's `Rc`: no cell is registered, no collector code is
emitted, every cell has the small header, `Gc.collect()` does nothing and
`Gc.tracked_count()` is 0. A cycle leaks unless a `Weak` breaks it; the
`--debug-heap` report is how to find one. The collector stays the default
until `Weak` and `yo test --allocator debug` have shipped: a leaked cycle
is the quietest mistake a program can make, and the safety net is
replaced before it is removed. `YO_GC_THRESHOLD=0` is the run-time form
of the same choice: it keeps the tracking and disables the trigger.

## 7. `Weak` and `ArcWeak` (planned: W3, W4)

A `Weak(T)` is a handle that does not keep its `Rc(T)` cell alive, and an
`ArcWeak(T)` the same for `Arc(T)`. They are Rust's `rc::Weak` and
`sync::Weak`.

```yo ignore
parent := rc(RefCell(Tree).new(Tree(kids : ArrayList(Rc(RefCell(Tree))).new(), parent : Weak(RefCell(Tree)).new())));
child := rc(RefCell(Tree).new(Tree(kids : ArrayList(Rc(RefCell(Tree))).new(), parent : Rc.downgrade(&parent))));
parent.with_mut(t => {
  t.kids.push(child.clone());  // parent -> child: strong
});                            // child -> parent: weak, so there is no cycle to collect
match(child.*.with(t => t.parent.upgrade()), .Some(p) => (), .None => ()); // .None once the parent is gone
```

- `Rc.downgrade(&h)` makes a `Weak`; `w.upgrade()` returns
  `.Some(Rc(T))` while the cell's payload is alive and `.None` after.
  `Weak(T).new()` is a dangling `Weak` that always upgrades to `.None`.
- The payload is dropped when the last `Rc` goes away, even if `Weak`s
  remain: a `Weak` keeps the allocation, never the resource. The
  allocation is freed when the last handle of either kind goes.
- A `Weak` is not an edge to the collector. A type whose only back edge is
  a `Weak` is not tracked at all, and a cycle broken by a `Weak` is no
  cycle, under the collector and under `--cycle-collector off` alike.
- A `Weak` has no `.field` or `.method()` access and no pattern: every
  read goes through `upgrade`. `Weak(T)` is an explicit-copy value
  (`w.clone()`), never `Copy`, never `Send`; `ArcWeak(T)` is `Send` and
  `Sync` when `T` is.
- During a collection, `upgrade` of a cell the collector is freeing
  returns `.None`, as Rust's does for a cycle member mid-drop.

## 8. Threads

- **Each thread has its own collector** for the `Rc` cells it made. An
  `Rc` is not `Send`, so a cell never changes threads and no collector
  coordinates with another. There are no stop-the-world pauses.
- **What crosses threads** is what `Send` admits (`OWNERSHIP_AND_BORROWING_DOC_DRAFT.md`
  section 12): plain data, uniquely owned values and buffers (their only
  owner moves), `Arc(T)` with `T <: (Send, Sync)`, `Mutex`, `RwLock`,
  channels and the atomics. Shared memory between threads exists; it is
  spelled `Arc`, and it is never collected (section 5).
- A `Thread.spawn` body starts with its own empty collector; the cells it
  makes are collected on that thread and must be freed before it exits or
  they leak.

## 9. `Trace` for buffer-owning values

The collector enumerates a cell's outgoing edges through a per-type
traversal the compiler derives: it descends inline through fields, enum
payloads, tuples, arrays and `Box` payloads and visits every `Rc` it
finds. A value that owns a heap buffer through a raw pointer (`ArrayList`,
`HashMap`, `Deque`, and everything built on them) is opaque to that walk,
so it implements `Trace` by hand and visits each element slot:

```yo ignore
impl(generic(T : Type), ArrayList(T), Trace(
  trace : (fn(self : Self, tracer : GcTracer) -> unit)({
    // tracer.visit(slot_pointer) once per element slot
  })
));
```

The rules: visit every slot (a missed slot leaks, it never crashes); pass
the slot's pointer, never the element by value (a by-value visit would
touch the count in the middle of a collection); do not recurse into
elements yourself, `visit` does. (planned: W3) A `Weak` field or slot is
not visited.

## 10. Diagnostics and knobs

| Code or knob | Meaning |
| --- | --- |
| `E0602` | a `Send` bound fails: the value reaches an `Rc` (or a non-`Send` type) and cannot cross a thread |
| `Arc(T)`'s bound | `T` is not `Send`, `Sync` (or, today, `Acyclic`) |
| `Gc.collect()`, `Gc.tracked_count()` | section 3 |
| `YO_GC_THRESHOLD`, `YO_GC_FULL_PCT` | section 3 |
| `--allocator fixed --debug-heap` | the exit leak report, which lists leaked cycles |
| (planned: W1) `--cycle-collector off` | section 6 |

## 11. The end state (planned: W6)

With the collector deleted, this page shrinks to the model Rust documents:

- `Rc` and `Arc` cells are freed by their last strong handle; their
  payload's `Drop` runs there and nowhere else.
- A cycle leaks. A back edge is a `Weak` or an `ArcWeak`; `upgrade` is
  how it is read.
- `yo test --allocator debug` fails a test that leaks, and `--allocator
  debug`'s exit report names the leaked cells and their allocation sites.
- Every cell has one 16-byte header; `Acyclic`, `Trace`, `Gc`,
  `YO_GC_THRESHOLD` and `--cycle-collector` no longer exist.
- An `Rc` payload may hold a reference (`Rc(&(T, p))`), as in Rust: there
  is no later moment at which its `Drop` could run.

## 12. Design records

- [`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md): §3.2 `Box`/`Rc`/`Arc`;
  §3.8 `Send`/`Sync`; §3.10 exclusivity and `RefCell`; §3.12 the
  collector's tracking predicate; decisions 21 (the compiler's trees
  declared `Acyclic`), 41 (`RefCell`), 45 (`Drop`), 46 (`Rc` is
  read-only; `Weak` reopened 2026-10-21).
- [`backlog/WEAK_AND_UNCOLLECTED_RC.md`](backlog/WEAK_AND_UNCOLLECTED_RC.md):
  `Weak`/`ArcWeak`, the uncollected build, `Arc` without `Acyclic`,
  phases W1–W6 (W6 deletes the collector, `Trace` and `Acyclic`).
- [`backlog/REFERENCES_AND_ORIGINS.md`](backlog/REFERENCES_AND_ORIGINS.md)
  O9 and O10: borrows through a handle; `Escapable` and why an `Rc`
  payload carries no reference.
- [`backlog/RC_HEADER_SPLIT.md`](backlog/RC_HEADER_SPLIT.md): the two cell
  headers.
- The algorithm's own record, with the emitted C, stays in the current
  `docs/en-US/CYCLE_COLLECTION.md` until this draft replaces it; the
  Bacon–Rajan and resurrection sections there are current.
