# Weak(T) — Non-Owning Handles to an `Rc`

`Weak(T)` is Rust's `rc::Weak<T>`: a handle to an `Rc(T)` cell that does not keep
the payload alive. It is defined in `std/prelude.yo` beside `Rc`, so `Weak` is
available everywhere. A `Weak` is the way to close a cycle without leaking: a
parent owns its children through `Rc`, and each child names its parent through a
`Weak`. The design is `plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §3.

## The API

```yo ignore
impl(generic(T : Type), Rc(T),
  downgrade : (fn(self : &Self) -> Weak(T))(...)              // Rust's Rc::downgrade(&rc)
);
impl(generic(T : Type), Weak(T),
  new : (fn() -> Self)(...),                                   // names no cell: upgrade is .None
  upgrade : (fn(self : &Self) -> Option(Rc(T)))(...),
  strong_count : (fn(self : &Self) -> usize)(...),
  weak_count : (fn(self : &Self) -> usize)(...),
  ptr_eq : (fn(self : &Self, other : &Self) -> bool)(...)
);
// plus Clone (a second Weak to the same cell), Default (Weak.new()) and Drop
```

`Rc.downgrade(&h)` is spelled through the type, as `Rc.try_unwrap` is, so a
payload method named `downgrade` stays reachable as `h.downgrade()`.

```yo
a := rc(i32(7));
w := Rc.downgrade(&a);
assert(w.strong_count() == usize(1), "one Rc");
match(
  w.upgrade(),
  .Some(b) => assert(b.* == i32(7), "a new Rc to the same cell"),
  .None => assert(false, "a is alive")
);
consume(a); // the last Rc: the payload is dropped
assert(w.upgrade().is_none(), "nothing to upgrade to");
```

## Semantics

- **Two counts.** The cell counts its `Rc` handles (the strong count) and its
  `Weak` handles (the weak count). `downgrade` and `Weak.clone` raise the weak
  count; dropping a `Weak` lowers it. A `Weak` never raises the strong count.
- **The last `Rc` drops the payload.** Its `Drop` runs then, whether or not a
  `Weak` remains. While it runs the strong count is already 0, so an `upgrade`
  from inside it is `.None`.
- **The last handle of either kind frees the cell.** A `Weak` keeps the cell's
  bytes allocated, never its payload: an `Rc` dropped while a `Weak` remains
  leaves the allocation for the last `Weak` to free. A cell placed by an
  explicit allocator (`rc(v, alloc : .Some(a))`) is freed into it either way.
- **`upgrade`** is `.Some(h)`, a new strong handle, while the payload is alive,
  and `.None` once the last `Rc` is gone. `Weak.new()` names no cell and always
  upgrades to `.None`.
- **The counts read as Rust's.** `strong_count` is 0 once the payload is gone;
  `weak_count` counts this handle too, and is 0 once the payload is gone.
- **The weak count saturates** at 32767 handles to one cell. A saturated cell
  stops counting and is never freed: a leak, never a dangling handle.
  `weak_count()` reports `usize.MAX` then.
- **`Rc.try_unwrap`** succeeds with `Weak` handles alive; they upgrade to `.None`
  afterwards. **`Rc.make_mut`** on the only `Rc` writes in place even when a
  `Weak` names the cell, so the `Weak`'s later `upgrade` sees the write. Rust's
  `make_mut` disassociates the `Weak` handles instead; Yo follows once the seed
  compiler carries the weak-count runtime
  (`plans/backlog/SEED_VERSION_AUTOMATION.md`).

## What a `Weak` is not

- **No `Deref`.** The payload may be gone, so every read goes through `upgrade`.
  There is no `Weak(p)` pattern either.
- **Explicit-copy.** A `Weak` has a `Drop`, so it is move-only: `w2 := w` moves
  it when `w` is not used again, and any other copy is error E0901.
  `Weak.clone(&w)` makes a second handle.
- **Not `Send` or `Sync`.** An `Rc` graph is thread-local, and so is a `Weak`
  into it.

## A parent pointer

The Rust shape for a tree with parent pointers is a strong child edge and a weak
parent edge. A write reaches the payload through `RefCell(T)`
(`std/sync/refcell`), since an `Rc`'s payload is read-only through the handle:

```yo
{ RefCell } :: import("std/sync/refcell");
{ ArrayList } :: import("std/collections/array_list");

Node :: struct(
  value : i32,
  parent : Weak(RefCell(Node)),
  children : ArrayList(Rc(RefCell(Node)))
);

root := rc(RefCell(Node).new(Node(value : i32(1), parent : Weak(RefCell(Node)).new(), children : ArrayList(Rc(RefCell(Node))).new())));
leaf := rc(RefCell(Node).new(Node(value : i32(2), parent : Rc.downgrade(&root), children : ArrayList(Rc(RefCell(Node))).new())));
root.with_mut({ leaf }(n) => {
  n.children.push(leaf);
});
parent_value := leaf.with(n => match(n.parent.upgrade(), .Some(p) => p.with(pn => pn.value), .None => i32(0)));
assert(parent_value == i32(1), "the leaf reaches its parent");
```

Dropping `root` drops the tree: the only strong edges point down.

## With the cycle collector

A `Weak` is not an edge of the ownership graph. The collector's walk does not
visit a `Weak` field, and a hand-written `Trace` must not visit one either, so a
cycle closed through a `Weak` is not a cycle: a type whose only back edge is a
`Weak` is acyclic, and its cells are never tracked. Under
`--cycle-collector off` ([CYCLE_COLLECTION.md](./CYCLE_COLLECTION.md)) a `Weak`
back edge is what keeps such a structure from leaking.

When the collector frees a garbage cycle, an `upgrade` from a `Drop` it runs is
`.None` for a cell of that cycle and succeeds for a live cell. A garbage cell a
`Weak` outside the cycle still names has its payload dropped and its allocation
kept until that `Weak` goes; `tracked_count()` no longer counts it.

## Related docs

- [ARC.md](./ARC.md) — `Arc(T)`, the atomically counted handle
- [CYCLE_COLLECTION.md](./CYCLE_COLLECTION.md) — the collector and `--cycle-collector off`
- [MEMORY_SAFETY.md](./MEMORY_SAFETY.md) — the leak oracles
