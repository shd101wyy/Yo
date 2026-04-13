# Immutable Collections (`std/imm`)

The `std/imm` module provides persistent, immutable data structures backed by
`atomic object` nodes. Every mutation returns a **new** collection while the
original stays unchanged, enabling safe structural sharing across threads.

## Key Properties

| Property        | Detail                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thread-safe** | All node types use `atomic object` (atomic reference counting).                                                                                             |
| **Send**        | Every type constructor requires `T <: Send`, so values can be shared across threads.                                                                        |
| **No cycles**   | `atomic object` does not participate in the cycle collector. Cyclic references are structurally impossible because all collections are acyclic trees/lists. |
| **Persistent**  | Old versions remain valid after "mutation".                                                                                                                 |

## Module Overview

| Module               | Type              | Backing structure                               |
| -------------------- | ----------------- | ----------------------------------------------- |
| `std/imm/list`       | `List(T)`         | Cons list (singly-linked)                       |
| `std/imm/string`     | `String`          | Immutable byte buffer (UTF-8)                   |
| `std/imm/vec`        | `Vec(T)`          | Flat-array copy-on-write                        |
| `std/imm/map`        | `Map(K, V)`       | Hash Array Mapped Trie (HAMT)                   |
| `std/imm/set`        | `Set(T)`          | HAMT (wrapper around `Map(T, bool)`)            |
| `std/imm/sorted_map` | `SortedMap(K, V)` | Left-leaning red-black tree                     |
| `std/imm/sorted_set` | `SortedSet(T)`    | LLRB tree (wrapper around `SortedMap(T, bool)`) |

## Quick Start

```rust
{ List } :: import "std/imm/list";
{ Map } :: import "std/imm/map";
{ SortedSet } :: import "std/imm/sorted_set";

// Persistent list — O(1) prepend
xs := List(i32).new().prepend(i32(3)).prepend(i32(2)).prepend(i32(1));
assert((xs.head().unwrap() == i32(1)), "head is 1");

// Persistent hash map — O(log32 n) insert/lookup
m := Map(i32, i32).new();
m = m.insert(i32(1), i32(100));
m2 := m.insert(i32(2), i32(200));
assert((m.len() == usize(1)), "original unchanged");
assert((m2.len() == usize(2)), "new map has both");

// Sorted set — elements always in order
s := SortedSet(i32).new();
s = s.insert(i32(5)).insert(i32(1)).insert(i32(3));
// s.to_list() → [1, 3, 5]
```

## `atomic object` Syntax

The `atomic object(...)` keyword creates a reference-counted type that uses
**atomic** increment/decrement instead of the regular (non-atomic) reference
counting used by plain `object(...)`. Types defined with `atomic object`
automatically derive the `Send` trait if all their fields are `Send`.

```rust
// Regular object — single-threaded RC, NOT Send
Node :: (fn(comptime(T) : Type) -> comptime(Type))(
  object(value: T, next: Option(Self))
);

// Atomic object — atomic RC, auto-derives Send
SafeNode :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  atomic object(value: T, next: Option(Self))
);
```

Key differences from `object(...)`:

- Uses `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` (C11 `_Atomic` operations)
- Does **not** participate in the cycle collector (no GC registration)
- Auto-derives `Send` when all fields implement `Send`
- Cannot form cycles (by design — no cycle collector means cycles would leak)

## API Reference

### `List(T)` — Persistent Cons List

Constraint: `T <: Send`

| Method     | Signature                                      | Description        |
| ---------- | ---------------------------------------------- | ------------------ |
| `new`      | `() -> Self`                                   | Empty list         |
| `prepend`  | `(self, value: T) -> Self`                     | O(1) add to front  |
| `head`     | `(self) -> Option(T)`                          | First element      |
| `tail`     | `(self) -> Self`                               | All but first      |
| `len`      | `(self) -> usize`                              | Length             |
| `is_empty` | `(self) -> bool`                               | Check empty        |
| `get`      | `(self, index: usize) -> Option(T)`            | O(n) index access  |
| `reverse`  | `(self) -> Self`                               | Reverse the list   |
| `concat`   | `(self, other: Self) -> Self`                  | Concatenate        |
| `map`      | `(self, f: Impl(Fn(T) -> U)) -> List(U)`       | Transform elements |
| `filter`   | `(self, f: Impl(Fn(T) -> bool)) -> Self`       | Keep matching      |
| `foldl`    | `(self, init: U, f: Impl(Fn(U, T) -> U)) -> U` | Left fold          |

Also implements `Eq(Self)` when `T <: Eq(T)`.

### `String` — Immutable Thread-Safe String

| Method        | Signature                                  | Description         |
| ------------- | ------------------------------------------ | ------------------- |
| `new`         | `() -> Self`                               | Empty string        |
| `from`        | `(s: str) -> Self`                         | From string literal |
| `len`         | `(self) -> usize`                          | Byte length         |
| `is_empty`    | `(self) -> bool`                           | Check empty         |
| `as_bytes`    | `(self) -> Slice(u8)`                      | Byte view           |
| `byte_at`     | `(self, i: usize) -> u8`                   | Byte at index       |
| `concat`      | `(self, other: Self) -> Self`              | Concatenate         |
| `slice`       | `(self, start: usize, end: usize) -> Self` | Substring           |
| `contains`    | `(self, needle: Self) -> bool`             | Search              |
| `starts_with` | `(self, prefix: Self) -> bool`             | Prefix check        |
| `ends_with`   | `(self, suffix: Self) -> bool`             | Suffix check        |

Also implements `Eq(Self)`, `Hash`, and `Send`.

### `Vec(T)` — Persistent Vector (Copy-on-Write)

Constraint: `T <: Send`

| Method     | Signature                                      | Description     |
| ---------- | ---------------------------------------------- | --------------- |
| `new`      | `() -> Self`                                   | Empty vector    |
| `len`      | `(self) -> usize`                              | Length          |
| `is_empty` | `(self) -> bool`                               | Check empty     |
| `get`      | `(self, index: usize) -> Option(T)`            | O(1) access     |
| `push`     | `(self, value: T) -> Self`                     | Append          |
| `set`      | `(self, index: usize, value: T) -> Self`       | Update at index |
| `pop`      | `(self) -> Self`                               | Remove last     |
| `slice`    | `(self, start: usize, end: usize) -> Self`     | Sub-vector      |
| `concat`   | `(self, other: Self) -> Self`                  | Concatenate     |
| `map`      | `(self, f: Impl(Fn(T) -> U)) -> Vec(U)`        | Transform       |
| `filter`   | `(self, f: Impl(Fn(T) -> bool)) -> Self`       | Keep matching   |
| `foldl`    | `(self, init: U, f: Impl(Fn(U, T) -> U)) -> U` | Left fold       |
| `reverse`  | `(self) -> Self`                               | Reverse         |
| `zip_with` | `(self, other: Vec(U), f) -> Vec(R)`           | Zip + transform |

Also implements `Eq(Self)` when `T <: Eq(T)`.

### `Map(K, V)` — Persistent Hash Map (HAMT)

Constraint: `K <: (Eq(K), Hash, Send)`, `V <: Send`

| Method         | Signature                          | Description        |
| -------------- | ---------------------------------- | ------------------ |
| `new`          | `() -> Self`                       | Empty map          |
| `len`          | `(self) -> usize`                  | Entry count        |
| `is_empty`     | `(self) -> bool`                   | Check empty        |
| `get`          | `(self, key: K) -> Option(V)`      | Lookup             |
| `contains_key` | `(self, key: K) -> bool`           | Key exists?        |
| `insert`       | `(self, key: K, value: V) -> Self` | Insert/update      |
| `remove`       | `(self, key: K) -> Self`           | Remove key         |
| `merge`        | `(self, other: Self) -> Self`      | Merge (right wins) |
| `keys`         | `(self) -> List(K)`                | All keys           |
| `values`       | `(self) -> List(V)`                | All values         |
| `entries`      | `(self) -> List(MapEntry(K, V))`   | All entries        |
| `map_values`   | `(self, f) -> Map(K, U)`           | Transform values   |
| `filter`       | `(self, f) -> Self`                | Keep matching      |

Also implements `Eq(Self)` when `V <: Eq(V)`.

### `Set(T)` — Persistent Hash Set

Constraint: `T <: (Eq(T), Hash, Send)`

| Method         | Signature                     | Description      |
| -------------- | ----------------------------- | ---------------- |
| `new`          | `() -> Self`                  | Empty set        |
| `len`          | `(self) -> usize`             | Element count    |
| `is_empty`     | `(self) -> bool`              | Check empty      |
| `contains`     | `(self, elem: T) -> bool`     | Membership       |
| `insert`       | `(self, elem: T) -> Self`     | Add element      |
| `remove`       | `(self, elem: T) -> Self`     | Remove element   |
| `union`        | `(self, other: Self) -> Self` | Set union        |
| `intersection` | `(self, other: Self) -> Self` | Set intersection |
| `difference`   | `(self, other: Self) -> Self` | Set difference   |
| `is_subset`    | `(self, other: Self) -> bool` | Subset check     |
| `is_disjoint`  | `(self, other: Self) -> bool` | Disjoint check   |
| `to_list`      | `(self) -> List(T)`           | Collect to list  |

Also implements `Eq(Self)`.

### `SortedMap(K, V)` — Persistent Sorted Map (LLRB Tree)

Constraint: `K <: (Eq(K), Ord(K), Send)`, `V <: Send`

| Method         | Signature                          | Description         |
| -------------- | ---------------------------------- | ------------------- |
| `new`          | `() -> Self`                       | Empty map           |
| `len`          | `(self) -> usize`                  | Entry count         |
| `is_empty`     | `(self) -> bool`                   | Check empty         |
| `get`          | `(self, key: K) -> Option(V)`      | Lookup              |
| `contains_key` | `(self, key: K) -> bool`           | Key exists?         |
| `insert`       | `(self, key: K, value: V) -> Self` | Insert/update       |
| `remove`       | `(self, key: K) -> Self`           | Remove key          |
| `min_key`      | `(self) -> Option(K)`              | Smallest key        |
| `max_key`      | `(self) -> Option(K)`              | Largest key         |
| `keys`         | `(self) -> List(K)`                | In-order keys       |
| `values`       | `(self) -> List(V)`                | Values in key order |

Also implements `Eq(Self)` when `V <: Eq(V)`.

### `SortedSet(T)` — Persistent Sorted Set

Constraint: `T <: (Eq(T), Ord(T), Send)`

| Method         | Signature                     | Description      |
| -------------- | ----------------------------- | ---------------- |
| `new`          | `() -> Self`                  | Empty set        |
| `len`          | `(self) -> usize`             | Element count    |
| `is_empty`     | `(self) -> bool`              | Check empty      |
| `contains`     | `(self, elem: T) -> bool`     | Membership       |
| `insert`       | `(self, elem: T) -> Self`     | Add element      |
| `remove`       | `(self, elem: T) -> Self`     | Remove element   |
| `min`          | `(self) -> Option(T)`         | Smallest element |
| `max`          | `(self) -> Option(T)`         | Largest element  |
| `to_list`      | `(self) -> List(T)`           | Sorted list      |
| `union`        | `(self, other: Self) -> Self` | Set union        |
| `intersection` | `(self, other: Self) -> Self` | Set intersection |
| `difference`   | `(self, other: Self) -> Self` | Set difference   |
| `is_subset`    | `(self, other: Self) -> bool` | Subset check     |
| `is_disjoint`  | `(self, other: Self) -> bool` | Disjoint check   |

Also implements `Eq(Self)`.

## Design Decisions

1. **`atomic object` vs `Arc` wrapper**: Instead of wrapping `object(...)` in
   `Arc(...)`, we introduced `atomic object(...)` as a first-class syntax. This
   gives the compiler full knowledge of atomicity for optimization and trait
   derivation.

2. **No cycle collector**: `atomic object` nodes are excluded from the cycle
   collector. All `std/imm` data structures are acyclic by construction (trees,
   lists, tries), so this is safe and avoids GC overhead.

3. **`Map(T, bool)` for sets**: `Set(T)` and `SortedSet(T)` use `bool` as
   the value type instead of `unit`, because `unit` has no C representation
   and cannot be used as a struct field value in generated code.

4. **Standalone functions in HAMT**: The `Map` implementation uses standalone
   functions instead of methods for internal tree operations to work around
   a limitation in generic type resolution from match branches.

For the full design document, see [`plans/IMMUTABLE_COLLECTIONS.md`](../../plans/IMMUTABLE_COLLECTIONS.md).
