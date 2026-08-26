# Immutable Collections (`std/imm`)

`std/imm` provides persistent, immutable collections built on `atomic(ref(struct(...)))`.
Every "mutation" returns a **new** value while the old one remains valid, so
structural sharing is safe across threads.

This page is intentionally an **overview and design guide**. For the up-to-date
per-module API surface, prefer the generated `yo doc` output (locally or from CI).

## Shared properties

| Property                | Detail                                                                         |
| ----------------------- | ------------------------------------------------------------------------------ |
| **Persistent**          | Old versions remain valid after insert/update/remove-style operations.         |
| **Thread-safe sharing** | Backing nodes use `atomic(ref(struct(...)))` and atomic reference counting.    |
| **`Send`-constrained**  | Collection type constructors require `Send` element/value types.               |
| **Acyclic by design**   | The data structures are trees/lists/tries and do not rely on cycle collection. |

## Collection overview

| Module               | Type              | Best for                                                  | Backing structure            |
| -------------------- | ----------------- | --------------------------------------------------------- | ---------------------------- |
| `std/imm/list`       | `List(T)`         | Cheap prepend, stack-like workloads, recursive algorithms | Cons list                    |
| `std/imm/string`     | `ImmString`       | Shared immutable UTF-8 text                               | Immutable byte buffer        |
| `std/imm/vec`        | `Vec(T)`          | Indexed reads and append-heavy immutable workflows        | Flat-array copy-on-write     |
| `std/imm/map`        | `Map(K, V)`       | Fast hash-based lookup                                    | HAMT                         |
| `std/imm/set`        | `Set(T)`          | Hash-based membership tests                               | `Map(T, bool)` wrapper       |
| `std/imm/sorted_map` | `SortedMap(K, V)` | Ordered keys, min/max, deterministic iteration            | Left-leaning red-black tree  |
| `std/imm/sorted_set` | `SortedSet(T)`    | Ordered membership tests                                  | `SortedMap(T, bool)` wrapper |

## Quick start

```rust
{ List } :: import "std/imm/list";
{ Map } :: import "std/imm/map";
{ SortedSet } :: import "std/imm/sorted_set";

xs := List(i32).new().prepend(i32(3)).prepend(i32(2)).prepend(i32(1));
assert((xs.head().unwrap() == i32(1)), "head is 1");

m := Map(i32, i32).new();
m = m.insert(i32(1), i32(100));
m2 := m.insert(i32(2), i32(200));
assert((m.len() == usize(1)), "original unchanged");
assert((m2.len() == usize(2)), "new map has both");

s := SortedSet(i32).new();
s = s.insert(i32(5)).insert(i32(1)).insert(i32(3));
```

## Choosing a collection

- Choose **`List(T)`** when prepend and recursive decomposition matter more than indexed access.
- Choose **`Vec(T)`** when you want immutable indexed reads or slice-like workflows.
- Choose **`Map(K, V)`** / **`Set(T)`** for hash-based lookup and membership.
- Choose **`SortedMap(K, V)`** / **`SortedSet(T)`** when ordering is part of the API.
- Choose **`ImmString`** when you need a shareable immutable string; keep using `std/string.String` for mutable string-building APIs.

## API reference

Use generated docs for the latest signatures and doc comments:

```bash
yo doc ./std
yo doc ./std/imm
```

In this repository, CI publishes generated docs for the standard library. Prefer
those pages for method-by-method reference.

## Design notes

1. **`atomic(ref(struct(...)))` instead of `Arc(...)` wrappers**: the collections are
   defined directly as atomic reference-counted types, so the compiler sees the
   ownership model explicitly.
2. **No cycle collector participation**: immutable collections are acyclic by
   construction, so excluding them from cycle collection avoids unnecessary GC work.
3. **`Set(T)` / `SortedSet(T)` use `bool` values internally**: `unit` has no C
   representation, so the set wrappers use `Map(T, bool)` / `SortedMap(T, bool)`.
4. **API docs are generated, not hand-maintained**: this document stays focused on
   concepts, tradeoffs, and module selection instead of duplicating signatures.

### Acyclic trait and self-referential nodes

`atomic(ref(struct(...)))` types use atomic reference counting without a cycle collector.
The compiler automatically derives the `Acyclic` trait for types whose structure
cannot form cycles. Self-referential types (e.g., linked list nodes with
`_next : Option(Self)`) fail auto-derivation because the structure _could_ form
cycles.

Immutable collections can **never** form cycles at runtime because all operations
create new nodes — existing nodes are never mutated. To express this guarantee, the
internal node types declare a **manual `Acyclic` impl**:

```rust
ListNode :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  atomic(ref(struct(_value : T, _next : Option(Self))))
);
impl(generic(T : Type), where(T <: Send), ListNode(T), Acyclic());
```

This is analogous to Rust's `unsafe impl Send` — the programmer asserts a safety
property the compiler cannot verify structurally. The `Send` constraint on `atomic
object` fields is enforced as a hard error; `Acyclic` is auto-derived when possible
and manually declared otherwise.

## Copy-on-write (COW) optimization

`Vec(T)` and `ImmString` use **copy-on-write** semantics via `own(self)`
parameters on mutation methods (`push`, `set`, `pop`, `concat`, `reverse`,
`dedup`, `to_lowercase`, `to_uppercase`).

### How it works

Mutation methods take ownership of `self` instead of borrowing:

```rust
push : (fn(own(self): Self, val: T) -> Self)
```

Inside the method, `rc(self) == usize(1)` is checked:

- **Unique (rc = 1)**: the buffer is mutated in-place and the same object is
  returned. No allocation, no copy — O(1).
- **Shared (rc > 1)**: a new buffer is allocated, data is copied, and a new
  object is returned. The original is unchanged — O(n).

### Usage pattern

```rust
{ Vec } :: import "std/imm/vec";

// Normal usage — each push is O(1) because v is unique:
v := Vec(i32).new();
v = v.push(i32(1));    // rc=1, mutate in place
v = v.push(i32(2));    // rc=1, mutate in place

// Preserving old version — push copies because v is shared:
old := v;              // dup, rc=2
v = v.push(i32(3));    // rc=2, copy path taken
// old still has [1, 2], v has [1, 2, 3]
```

### Thread safety

The `rc == 1` check uses `atomic_load_explicit(memory_order_acquire)` for
`atomic object` types. If the load returns 1, no other thread holds a reference,
so in-place mutation is safe (no TOCTOU race).

### Which collections support COW

| Collection   | COW support | Notes                                    |
| ------------ | ----------- | ---------------------------------------- |
| `Vec(T)`     | ✓           | `push`, `set`, `pop`, `concat`, etc.     |
| `ImmString` | ✓           | `concat`, `to_lowercase`, `to_uppercase` |
| `Map(K, V)`  | —           | Structural sharing via HAMT              |
| `SortedMap`  | —           | Structural sharing via LLRB tree         |
| `List(T)`    | —           | `prepend` is already O(1)                |

Map and SortedMap already use structural sharing (only O(log n) nodes copied per
mutation), so COW would provide diminishing returns. List's primary operation
(`prepend`) is inherently O(1).

## Related docs

- `plans/IMMUTABLE_COLLECTIONS.md` — implementation plan and design history
- `docs/en-US/ARC.md` — shared ownership overview
- Generated `yo doc` output for module-level API details
