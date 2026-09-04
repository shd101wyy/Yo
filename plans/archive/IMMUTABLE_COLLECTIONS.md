# std/imm — Immutable / Persistent Data Structures
> **ARCHIVED 2026-09-04 — SUPERSEDED** by plans/reference/STD_API_AUDIT.md §D4
> (2026-08-26, D4 PR 5): the API surface below shipped, then D4 replaced this
> plan as the authority for std/imm evolution.


## Overview

This plan describes a new standard library module `std/imm` providing **immutable, persistent, thread-safe** data structures for Yo. These complement `std/collections` (mutable, single-threaded) with structures optimized for sharing across threads and functional programming patterns.

### Design Principles

1. **Persistent** — "Modification" operations return a new version; the old version remains valid and unchanged.
2. **Structural sharing** — New versions share unmodified sub-trees/nodes with old versions via `Arc` or `atomic object`, making copies near-free.
3. **Thread-safe** — All types use atomic reference counting. All types implement `Send`.
4. **Send-constrained** — Type constructors require `where(T <: Send)` to guarantee contents are safe to share across threads.
5. **No cyclic references** — By construction, persistent data structures are acyclic (DAGs at most). Atomic RC does not support cycle collection, so this is a hard requirement.
6. **Immutable API** — No `push`, `set_len`, or other in-place mutation methods. All operations that "change" data return a new value.

### Why not just `Arc(HashMap(K, V))`?

Wrapping mutable collections in `Arc` makes them shareable but not usable — you can't mutate through an `Arc`, and cloning the entire collection to make changes is O(n). Persistent data structures provide O(log n) or O(1) "updates" through structural sharing.

Additionally, `object(...)` types (like `ArrayList`, `HashMap`) use **non-atomic** reference counting and do **not** implement `Send`. `Arc` wrapping an `object` type would give double reference counting (one atomic outer, one non-atomic inner), which is wasteful and still unsound if the inner RC is accessed from multiple threads.

---

## Prerequisite: `atomic object(...)` — Atomic RC Object Type

### Motivation

The existing Yo type system has a gap for immutable/persistent data structures:

| Type               | RC                   | Send                            | Dispose             | Custom cleanup        |
| ------------------ | -------------------- | ------------------------------- | ------------------- | --------------------- |
| `struct(...)`      | None (value type)    | Auto-derives if fields are Send | ❌ No               | ❌ No                 |
| `object(...)`      | Non-atomic           | ❌ Never auto-derives           | ✅ Yes              | ✅ Yes                |
| `Arc(T)`           | Atomic (wrapper)     | ✅ Always                       | N/A (wrapper)       | N/A                   |
| `Arc(struct(...))` | Atomic outer only    | ✅ Yes                          | ❌ No inner Dispose | ❌ Raw ptrs leak      |
| `Arc(object(...))` | Double RC (wasteful) | ✅ Outer only                   | ✅ Inner object     | ⚠️ Works but wasteful |

**`Arc(struct(...))`** works for tree nodes (fields are other `Arc` pointers), but fails for types needing custom cleanup (e.g., `imm.String` with a raw byte buffer — the raw `*(u8)` pointer leaks because `struct` has no `Dispose`).

**`atomic object(...)`** fills this gap: an `object` type with atomic RC that auto-derives `Send` and supports `Dispose`.

### Syntax

```rust
// Atomic RC object type — thread-safe, supports Dispose
ArcBytes :: atomic object(
  _ptr : *(u8),
  _len : usize,
  _capacity : usize
);

impl(ArcBytes, Dispose(
  dispose : (fn(self: Self) -> unit)({
    free(self._ptr);
  })
));
```

**Constraints:**

- `atomic` is ONLY valid directly before `object(...)` — no other type constructors (`struct`, `enum`, `newtype`)
- `atomic SomeExistingType` is NOT valid — `atomic` is a definition-site modifier, not a type operator
- `atomic object(...)` supports the same field syntax, method impl, and trait impl as regular `object(...)`

### Semantics

| Property            | `object(...)`                                | `atomic object(...)`                                   |
| ------------------- | -------------------------------------------- | ------------------------------------------------------ |
| RC type             | Non-atomic (`__yo_incr_rc` / `__yo_decr_rc`) | Atomic (`__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`) |
| `Send`              | ❌ Does not auto-derive                      | ✅ Auto-derives when all fields are `Send`             |
| `Dispose`           | ✅ Supported                                 | ✅ Supported                                           |
| `Rc` trait          | ✅ Implements                                | ✅ Implements                                          |
| Cycle collection    | ✅ Participates in trial-deletion cycle GC   | ❌ **No cycle collection** — acyclic by contract       |
| Reference semantics | ✅ Yes                                       | ✅ Yes                                                 |
| Heap-allocated      | ✅ Yes                                       | ✅ Yes                                                 |
| Methods/impls       | Same as object                               | Same as object                                         |

**No cycle collection**: Regular `object(...)` types participate in Yo's thread-local trial-deletion cycle collector (QuickJS-style). When `needsCycleGC` is true, the `__yo_ref_header_t` includes `gc_mark`, `gc_flags`, `gc_prev`/`gc_next` fields and a `dispose_fn` pointer. **`atomic object` types do NOT participate in cycle collection.** They use pure atomic reference counting with no GC metadata. This means:

- `atomic object` header is smaller (no GC fields) — just `_Atomic size_t ref_count` + dispose info
- No cycle collector overhead (no trial-deletion scans)
- Cyclic references between `atomic object` instances will **leak** — this is by design and documented as a hard constraint
- The `canTypeFormRcCycle()` check in `codegen-c.ts` should exclude `atomic object` types from the `needsCycleGC` analysis

### Compiler Implementation

#### 1. Lexer (`src/lexer.ts`)

- Add `atomic` as a recognized keyword token

#### 2. Parser (`src/parser.ts`)

- When the parser encounters `atomic`, check that the next token is `object`
- If not `object`, emit a parse error: "`atomic` can only be used before `object(...)`"
- Parse the `object(...)` body normally
- Set a flag on the AST node (e.g., `isAtomic: true` on the struct expression)

#### 3. Evaluator (`src/evaluator/types/struct.ts`)

- When creating a `StructType` for an `atomic object(...)`:
  - Set `isReferenceSemantics = true` (same as regular object)
  - Set a new field `isAtomicRc = true` on the StructType
- Generate `___dup` / `___drop` functions that use atomic operations
- Auto-derive `Send` for atomic object types (update the check in `utils.ts` line 1271-1273):
  ```typescript
  // Before:
  if (structType.isReferenceSemantics) {
    return env; // No auto-derive Send for object types
  }
  // After:
  if (structType.isReferenceSemantics && !structType.isAtomicRc) {
    return env; // No auto-derive Send for non-atomic object types
  }
  ```

#### 4. Type Definitions (`src/types/definitions.ts`)

- Add `isAtomicRc?: boolean` field to `StructType` interface

#### 5. Codegen (`src/codegen/`)

- In `drop-dup.ts`: check `isAtomicRc` to emit `__yo_decr_rc_atomic` / `__yo_incr_rc_atomic` instead of non-atomic variants
- In type generation: emit the same struct layout as regular objects (ref header + fields), but use the **atomic RC header** (same as Arc/Iso) — no cycle GC fields (`gc_mark`, `gc_flags`, `gc_prev`/`gc_next`)
- In `codegen-c.ts`: exclude `atomic object` types from the `canTypeFormRcCycle()` scan that determines `needsCycleGC` — atomic objects are acyclic by contract
- Dispose dispatch: `atomic object` uses the same dispose mechanism as Arc (type-id dispatch or `dispose_fn` pointer depending on `needsCycleGC` mode)

#### 6. Type Guards (`src/types/guards.ts`)

- `isRcType()` already returns `true` for `isObjectType()` — no change needed
- Add `isAtomicObjectType()` guard for code that needs to distinguish

---

## Data Structures

### 1. `imm.List(T)` — Persistent Singly-Linked List

A classic cons list. Ideal for stack-like access patterns and functional programming.

```rust
// std/imm/list.yo

ListNode :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  atomic object(
    value : T,
    next : Option(ListNode(T))
  )
);

List :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  struct(
    _head : Option(ListNode(T)),
    _len : usize
  )
);
```

**Key**: `ListNode` is an `atomic object` — it has atomic RC for thread-safe sharing, and supports `Dispose` if needed. When multiple `List` values share the same tail, the shared `ListNode` objects have their atomic ref counts incremented. The `List` wrapper itself is a `struct` (value type, cheap to copy — just an atomic RC pointer + length). Since `ListNode(T)` is `atomic object` with `Send` fields, it auto-derives `Send`, and `List(T)` (a struct with Send fields) also auto-derives `Send`.

**API**:

| Method       | Signature                                              | Complexity | Description                  |
| ------------ | ------------------------------------------------------ | ---------- | ---------------------------- |
| `new`        | `fn() -> Self`                                         | O(1)       | Empty list                   |
| `from_slice` | `fn(s: Slice(T)) -> Self`                              | O(n)       | Build from slice             |
| `prepend`    | `fn(self: Self, value: T) -> Self`                     | O(1)       | New list with value at front |
| `head`       | `fn(self: Self) -> Option(T)`                          | O(1)       | First element                |
| `tail`       | `fn(self: Self) -> Self`                               | O(1)       | All but first (shared)       |
| `len`        | `fn(self: Self) -> usize`                              | O(1)       | Cached length                |
| `is_empty`   | `fn(self: Self) -> bool`                               | O(1)       | Check emptiness              |
| `get`        | `fn(self: Self, index: usize) -> Option(T)`            | O(n)       | Access by index              |
| `reverse`    | `fn(self: Self) -> Self`                               | O(n)       | Reversed copy                |
| `concat`     | `fn(self: Self, other: Self) -> Self`                  | O(n)       | Concatenate two lists        |
| `map`        | `fn(self: Self, f: Impl(Fn(T) -> U, Send)) -> List(U)` | O(n)       | Transform elements           |
| `filter`     | `fn(self: Self, f: Impl(Fn(T) -> bool, Send)) -> Self` | O(n)       | Filter elements              |
| `fold`       | `fn(self: Self, init: U, f: Impl(Fn(U, T) -> U)) -> U` | O(n)       | Left fold                    |
| `contains`   | `fn(self: Self, value: T, where(T <: Eq(T))) -> bool`  | O(n)       | Membership test              |
| `into_iter`  | `fn(self: Self) -> ListIter(T)`                        | O(1)       | Iterator                     |

**Traits**: `Eq(Self)` (where T <: Eq), `Clone`, `Hash` (where T <: Hash), `Iterator`, `IntoIterator`, `ToString` (where T <: ToString), `Send`

---

### 2. `imm.String` — Immutable Thread-Safe String

The current `String` type (in `std/string`) uses `ArrayList(u8)` internally (an `object` type with non-atomic RC) and has mutable methods (`push_string`, `push_str`, `push_byte`). It does **not** implement `Send` because `object` types do not auto-derive `Send`.

`imm.String` provides an immutable, `Send`-safe string using `atomic object`.

```rust
// std/imm/string.yo

/// Immutable, thread-safe UTF-8 string.
/// Uses atomic RC — cheap to clone, safe to share across threads.
/// No mutable operations. All "modification" methods return a new String.
String :: atomic object(
  _ptr : *(u8),
  _len : usize,
  _capacity : usize
);

impl(String, Dispose(
  dispose : (fn(self: Self) -> unit)({
    // Free the byte buffer when ref count reaches zero
    if((self._capacity > usize(0)), {
      free(*(void)(self._ptr));
    });
  })
));
```

**Why `atomic object` is essential here**: `String` owns a raw `*(u8)` byte buffer that must be freed when the last reference is dropped. With `struct + Arc`, the raw pointer would leak because `struct` has no `Dispose`. With `atomic object`, we get atomic RC (→ Send) + Dispose (→ proper cleanup).

**Naming note**: Within the `imm` module, the type is simply `String`. Users import it as `{ String } :: import "std/imm/string"` or can alias it: `ImmString :: import "std/imm/string".String`. This avoids conflict with the existing `std/string` `String` because Yo uses explicit imports — users choose which `String` to bring into scope.


**API** — mirrors `std/string.String` but with no mutation methods:

| Method         | Signature                                          | Description                          |
| -------------- | -------------------------------------------------- | ------------------------------------ |
| `new`          | `fn() -> Self`                                     | Empty string                         |
| `from`         | `fn(s: str) -> Self`                               | From str literal                     |
| `from_string`  | `fn(s: std.String) -> Self`                        | Convert mutable String to imm.String |
| `len`          | `fn(self: Self) -> usize`                          | Byte length                          |
| `is_empty`     | `fn(self: Self) -> bool`                           | Check emptiness                      |
| `as_str`       | `fn(self: Self) -> str`                            | Borrow as str slice                  |
| `byte_at`      | `fn(self: Self, idx: usize) -> Option(u8)`         | Byte access                          |
| `concat`       | `fn(self: Self, other: Self) -> Self`              | New string = self + other            |
| `slice`        | `fn(self: Self, start: usize, end: usize) -> Self` | Substring (new allocation)           |
| `starts_with`  | `fn(self: Self, prefix: Self) -> bool`             | Prefix check                         |
| `ends_with`    | `fn(self: Self, suffix: Self) -> bool`             | Suffix check                         |
| `contains`     | `fn(self: Self, needle: Self) -> bool`             | Substring search                     |
| `split`        | `fn(self: Self, sep: Self) -> List(String)`        | Split into list                      |
| `trim`         | `fn(self: Self) -> Self`                           | Trim whitespace                      |
| `to_uppercase` | `fn(self: Self) -> Self`                           | Uppercase copy                       |
| `to_lowercase` | `fn(self: Self) -> Self`                           | Lowercase copy                       |
| `replace`      | `fn(self: Self, from: Self, to: Self) -> Self`     | Replace first                        |
| `replace_all`  | `fn(self: Self, from: Self, to: Self) -> Self`     | Replace all                          |

**Traits**: `Eq(Self)`, `Eq(str)`, `Ord(Self)`, `Hash`, `Clone`, `ToString`, `Send`, `Index(usize)`, `Index(Range(usize))`

---

### 3. `imm.Vec(T)` — Persistent Vector

A general-purpose indexed sequence with efficient random access, update, and append. Internally uses a **bit-partitioned trie** (the same structure as Clojure's PersistentVector / Scala's Vector).

```rust
// std/imm/vec.yo

// Branching factor: 32 (5 bits per level)
IMM_VEC_BITS :: comptime(usize)(usize(5));
IMM_VEC_WIDTH :: comptime(usize)(usize(32));  // 1 << 5
IMM_VEC_MASK :: comptime(usize)(usize(31));   // 32 - 1

VecNode :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  atomic object(
    kind : VecNodeKind(T)
  )
);

VecNodeKind :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  enum(
    Branch(children : Array(Option(VecNode(T)), 32)),
    Leaf(elements : Array(Option(T), 32))
  )
);

Vec :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  struct(
    _root : Option(VecNode(T)),
    _tail : Array(Option(T), 32),    // tail buffer for amortized O(1) append
    _len : usize,
    _shift : usize                   // tree depth * BITS
  )
);
```

**Note**: `VecNode` is `atomic object` so child node references are atomically ref-counted for thread-safe sharing. The `Vec` wrapper is a `struct` (value type).

**API**:

| Method       | Signature                                              | Complexity     | Description                   |
| ------------ | ------------------------------------------------------ | -------------- | ----------------------------- |
| `new`        | `fn() -> Self`                                         | O(1)           | Empty vector                  |
| `from_slice` | `fn(s: Slice(T)) -> Self`                              | O(n)           | Build from slice              |
| `len`        | `fn(self: Self) -> usize`                              | O(1)           | Length                        |
| `is_empty`   | `fn(self: Self) -> bool`                               | O(1)           | Check emptiness               |
| `get`        | `fn(self: Self, idx: usize) -> Option(T)`              | O(log₃₂ n)     | Access by index               |
| `set`        | `fn(self: Self, idx: usize, val: T) -> Self`           | O(log₃₂ n)     | New vec with updated index    |
| `push`       | `fn(self: Self, val: T) -> Self`                       | O(1) amortized | New vec with element appended |
| `pop`        | `fn(self: Self) -> (Self, Option(T))`                  | O(1) amortized | New vec without last element  |
| `slice`      | `fn(self: Self, start: usize, end: usize) -> Self`     | O(log n)       | Sub-vector                    |
| `concat`     | `fn(self: Self, other: Self) -> Self`                  | O(log n)       | Concatenation                 |
| `map`        | `fn(self: Self, f: Impl(Fn(T) -> U, Send)) -> Vec(U)`  | O(n)           | Transform                     |
| `filter`     | `fn(self: Self, f: Impl(Fn(T) -> bool, Send)) -> Self` | O(n)           | Filter                        |
| `fold`       | `fn(self: Self, init: U, f: Impl(Fn(U, T) -> U)) -> U` | O(n)           | Left fold                     |
| `into_iter`  | `fn(self: Self) -> VecIter(T)`                         | O(1)           | Iterator                      |

**Traits**: `Eq(Self)`, `Clone`, `Hash`, `Iterator`, `IntoIterator`, `Index(usize)`, `ToString`, `Send`

---

### 4. `imm.Map(K, V)` — Persistent Hash Map

Uses a **Hash Array Mapped Trie (HAMT)** — the standard structure for persistent hash maps (used by Clojure, Scala, Haskell's unordered-containers).

#### Node representation — compact arrays for memory efficiency

Real-world HAMT nodes are typically sparse: most internal nodes have only 2–8 out of 32 possible children. A naïve `Array(Option(MapNode), 32)` wastes ~192 bytes of empty Option slots per node. Instead, we use **compact arrays** where only occupied slots are stored:

```rust
// std/imm/map.yo

/// HAMT branch node — uses bitmap + compact child array.
/// `bitmap` indicates which of the 32 hash positions are occupied.
/// `_children` stores only `popcount(bitmap)` children in a contiguous allocation.
MapBranch :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Eq(K), Hash, Send)),
  where(V <: Send)
) -> comptime(Type))(
  atomic object(
    bitmap : u32,
    _children_ptr : *(MapNode(K, V)),
    _children_len : u8                    // = popcount(bitmap), max 32
  )
);

/// HAMT leaf node — single key-value entry.
MapLeaf :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Eq(K), Hash, Send)),
  where(V <: Send)
) -> comptime(Type))(
  atomic object(
    hash : u64,
    key : K,
    value : V
  )
);

/// HAMT collision node — multiple entries with the same hash.
MapCollision :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Eq(K), Hash, Send)),
  where(V <: Send)
) -> comptime(Type))(
  atomic object(
    hash : u64,
    _pairs_ptr : *(struct(key : K, value : V)),
    _pairs_len : u8
  )
);

/// HAMT node — tagged union pointing to one of the three node kinds.
MapNode :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Eq(K), Hash, Send)),
  where(V <: Send)
) -> comptime(Type))(
  enum(
    Branch(node : MapBranch(K, V)),
    Leaf(node : MapLeaf(K, V)),
    Collision(node : MapCollision(K, V))
  )
);

Map :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Eq(K), Hash, Send)),
  where(V <: Send)
) -> comptime(Type))(
  struct(
    _root : Option(MapNode(K, V)),
    _len : usize
  )
);
```

**Design rationale**: Each node kind is a separate `atomic object` with `Dispose` for cleanup of raw child/pair arrays. `MapNode` itself is a lightweight enum (tag + pointer, 16 bytes) with value semantics — the `atomic object` behind each variant pointer handles RC. This gives:

- **Memory**: A branch with 4 children uses ~(header + bitmap + ptr + len + 4 × 16) ≈ ~100 bytes, vs ~(header + bitmap + 32 × 16) ≈ ~530 bytes with fixed arrays.
- **Cache**: Compact arrays have better locality for iteration and lookup.
- **Dispose**: `MapBranch.dispose` frees the `_children_ptr` allocation; `MapCollision.dispose` frees the `_pairs_ptr` allocation. `MapLeaf` needs no Dispose (no raw pointers).

**API**:

| Method         | Signature                                                 | Complexity | Description                      |
| -------------- | --------------------------------------------------------- | ---------- | -------------------------------- |
| `new`          | `fn() -> Self`                                            | O(1)       | Empty map                        |
| `len`          | `fn(self: Self) -> usize`                                 | O(1)       | Number of entries                |
| `is_empty`     | `fn(self: Self) -> bool`                                  | O(1)       | Check emptiness                  |
| `get`          | `fn(self: Self, key: K) -> Option(V)`                     | O(log₃₂ n) | Lookup                           |
| `contains_key` | `fn(self: Self, key: K) -> bool`                          | O(log₃₂ n) | Key membership                   |
| `insert`       | `fn(self: Self, key: K, val: V) -> Self`                  | O(log₃₂ n) | New map with entry added/updated |
| `remove`       | `fn(self: Self, key: K) -> Self`                          | O(log₃₂ n) | New map without key              |
| `merge`        | `fn(self: Self, other: Self) -> Self`                     | O(n + m)   | Union of two maps                |
| `keys`         | `fn(self: Self) -> List(K)`                               | O(n)       | All keys                         |
| `values`       | `fn(self: Self) -> List(V)`                               | O(n)       | All values                       |
| `entries`      | `fn(self: Self) -> List(struct(key: K, value: V))`        | O(n)       | All entries                      |
| `map_values`   | `fn(self: Self, f: Impl(Fn(V) -> U, Send)) -> Map(K, U)`  | O(n)       | Transform values                 |
| `filter`       | `fn(self: Self, f: Impl(Fn(K, V) -> bool, Send)) -> Self` | O(n)       | Filter entries                   |
| `into_iter`    | `fn(self: Self) -> MapIter(K, V)`                         | O(1)       | Iterator over entries            |

**Traits**: `Eq(Self)`, `Clone`, `Hash`, `Iterator`, `IntoIterator`, `Index(K)`, `ToString`, `Send`

---

### 5. `imm.Set(T)` — Persistent Hash Set

Thin wrapper around `imm.Map(T, unit)`.

```rust
// std/imm/set.yo

Set :: (fn(
  comptime(T) : Type,
  where(T <: (Eq(T), Hash, Send))
) -> comptime(Type))(
  struct(
    _map : Map(T, unit)
  )
);
```

**API**:

| Method         | Signature                             | Complexity | Description             |
| -------------- | ------------------------------------- | ---------- | ----------------------- |
| `new`          | `fn() -> Self`                        | O(1)       | Empty set               |
| `len`          | `fn(self: Self) -> usize`             | O(1)       | Cardinality             |
| `is_empty`     | `fn(self: Self) -> bool`              | O(1)       | Check emptiness         |
| `contains`     | `fn(self: Self, val: T) -> bool`      | O(log₃₂ n) | Membership              |
| `insert`       | `fn(self: Self, val: T) -> Self`      | O(log₃₂ n) | New set with element    |
| `remove`       | `fn(self: Self, val: T) -> Self`      | O(log₃₂ n) | New set without element |
| `union`        | `fn(self: Self, other: Self) -> Self` | O(n + m)   | Set union               |
| `intersection` | `fn(self: Self, other: Self) -> Self` | O(n)       | Set intersection        |
| `difference`   | `fn(self: Self, other: Self) -> Self` | O(n)       | Set difference          |
| `is_subset`    | `fn(self: Self, other: Self) -> bool` | O(n)       | Subset check            |
| `into_iter`    | `fn(self: Self) -> SetIter(T)`        | O(1)       | Iterator                |

**Traits**: `Eq(Self)`, `Clone`, `Hash`, `Iterator`, `IntoIterator`, `ToString`, `Send`

---

### 6. `imm.SortedMap(K, V)` — Persistent Sorted Map

Uses a **persistent red-black tree** (or weight-balanced tree) for ordered key-value storage.

```rust
// std/imm/sorted_map.yo

Color :: enum(Red, Black);

RBNode :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Ord(K), Send)),
  where(V <: Send)
) -> comptime(Type))(
  atomic object(
    color : Color,
    key : K,
    value : V,
    left : Option(RBNode(K, V)),
    right : Option(RBNode(K, V))
  )
);

SortedMap :: (fn(
  comptime(K) : Type,
  comptime(V) : Type,
  where(K <: (Ord(K), Send)),
  where(V <: Send)
) -> comptime(Type))(
  struct(
    _root : Option(RBNode(K, V)),
    _len : usize
  )
);
```

**Note**: `RBNode` is `atomic object` for thread-safe sharing. Path copying during rebalancing creates new nodes for the modified path while sharing the rest of the tree.

**API**:

| Method      | Signature                                            | Complexity   | Description       |
| ----------- | ---------------------------------------------------- | ------------ | ----------------- |
| `new`       | `fn() -> Self`                                       | O(1)         | Empty sorted map  |
| `len`       | `fn(self: Self) -> usize`                            | O(1)         | Number of entries |
| `get`       | `fn(self: Self, key: K) -> Option(V)`                | O(log n)     | Lookup            |
| `insert`    | `fn(self: Self, key: K, val: V) -> Self`             | O(log n)     | Insert/update     |
| `remove`    | `fn(self: Self, key: K) -> Self`                     | O(log n)     | Remove            |
| `min`       | `fn(self: Self) -> Option(struct(key: K, value: V))` | O(log n)     | Minimum key       |
| `max`       | `fn(self: Self) -> Option(struct(key: K, value: V))` | O(log n)     | Maximum key       |
| `range`     | `fn(self: Self, lo: K, hi: K) -> Self`               | O(log n + k) | Sub-map in range  |
| `into_iter` | `fn(self: Self) -> SortedMapIter(K, V)`              | O(1)         | In-order iterator |

**Traits**: `Eq(Self)`, `Clone`, `Hash`, `Iterator`, `IntoIterator`, `Index(K)`, `ToString`, `Send`

---

### 7. `imm.SortedSet(T)` — Persistent Sorted Set

Thin wrapper around `imm.SortedMap(T, unit)`.

```rust
// std/imm/sorted_set.yo

SortedSet :: (fn(
  comptime(T) : Type,
  where(T <: (Ord(T), Send))
) -> comptime(Type))(
  struct(
    _map : SortedMap(T, unit)
  )
);
```

**API**:

| Method         | Signature                              | Complexity   | Description             |
| -------------- | -------------------------------------- | ------------ | ----------------------- |
| `new`          | `fn() -> Self`                         | O(1)         | Empty sorted set        |
| `len`          | `fn(self: Self) -> usize`              | O(1)         | Cardinality             |
| `is_empty`     | `fn(self: Self) -> bool`               | O(1)         | Check emptiness         |
| `contains`     | `fn(self: Self, val: T) -> bool`       | O(log n)     | Membership              |
| `insert`       | `fn(self: Self, val: T) -> Self`       | O(log n)     | New set with element    |
| `remove`       | `fn(self: Self, val: T) -> Self`       | O(log n)     | New set without element |
| `min`          | `fn(self: Self) -> Option(T)`          | O(log n)     | Minimum element         |
| `max`          | `fn(self: Self) -> Option(T)`          | O(log n)     | Maximum element         |
| `union`        | `fn(self: Self, other: Self) -> Self`  | O(n + m)     | Sorted union            |
| `intersection` | `fn(self: Self, other: Self) -> Self`  | O(n + m)     | Sorted intersection     |
| `difference`   | `fn(self: Self, other: Self) -> Self`  | O(n + m)     | Sorted difference       |
| `range`        | `fn(self: Self, lo: T, hi: T) -> Self` | O(log n + k) | Sub-set in range        |
| `into_iter`    | `fn(self: Self) -> SortedSetIter(T)`   | O(1)         | In-order iterator       |

**Traits**: `Eq(Self)`, `Clone`, `Hash`, `Iterator`, `IntoIterator`, `ToString`, `Send`

---

## Module Organization

Following the pattern from `std/collections` and the module conventions (no `index.yo` for multi-submodule directories):

```
std/imm/
  list.yo          — imm.List(T)
  string.yo        — imm.String
  vec.yo           — imm.Vec(T)
  map.yo           — imm.Map(K, V) + HAMT internals
  set.yo           — imm.Set(T)
  sorted_map.yo    — imm.SortedMap(K, V) + red-black tree internals
  sorted_set.yo    — imm.SortedSet(T)
```

**Usage**:

```rust
{ List } :: import "std/imm/list";
{ Map } :: import "std/imm/map";
{ String } :: import "std/imm/string";
// etc.
```

---

## Structural Sharing with `atomic object` — How It Works

### Node sharing example (List prepend)

```
Before: list1 = [A -> B -> C]

    list1._head --> Node(A) --> Node(B) --> Node(C) --> None
                  (rc=1)      (rc=1)      (rc=1)

After: list2 = list1.prepend(X)

    list2._head --> Node(X) --\
                   (rc=1)      +--> Node(A) --> Node(B) --> Node(C) --> None
    list1._head ---------------/    (rc=2)      (rc=1)      (rc=1)

list1 and list2 share the entire [A, B, C] tail.
Only the new Node(X) is allocated. Node(A)'s atomic ref count is 2.
```

### Path copying example (Map insert)

```
Before: map1
          Root(rc=1)
         / | \
        A  B  C     (HAMT trie nodes, each an atomic object)
       / \
      D   E

After: map2 = map1.insert(key_in_D_subtree, new_val)
          Root'(rc=1)         (new root — path copied)
         / | \
        A' B  C              (A' is new, B(rc=2) and C(rc=2) are shared)
       / \
      D'  E                  (D' is new, E(rc=2) is shared)

Only Root, A, D are newly allocated (the path from root to the modified leaf).
Everything else is shared via atomic ref count increment.
```

---

## Challenges and Considerations

### 1. Atomic RC overhead per node

Every `atomic object` node pays:

- 8 bytes for the atomic reference count header
- One heap allocation per node
- Atomic operations (slightly slower than non-atomic) on every dup/drop

**Mitigation**: Use wide branching (32-way for HAMT/trie) to reduce tree depth and node count. The tail buffer optimization in `imm.Vec` keeps the most recent 32 elements in a flat array, avoiding node overhead for append-heavy workloads.

### 2. No cyclic references

Atomic RC does not support cycle detection or collection. All data structures must be strictly acyclic.

- **List**: Singly-linked → acyclic by construction.
- **Vec (trie)**: Tree → acyclic by construction.
- **Map (HAMT)**: Tree → acyclic by construction.
- **SortedMap (RB-tree)**: Tree → acyclic by construction.
- **Values stored in collections**: Constrained to `Send`, but users could still store values that form cycles externally. This is a user responsibility — document it clearly.

### 3. Compact arrays in HAMT nodes

HAMT branch and collision nodes use **compact arrays** (raw pointer + length) to store only occupied slots. This is memory-efficient but adds complexity:

- `MapBranch` allocates `popcount(bitmap)` children via `malloc` and needs `Dispose` to free
- `MapCollision` allocates N pairs via `malloc` and needs `Dispose` to free
- Path copying must allocate a new compact array for the modified branch, copy unchanged children, and insert/replace the changed child
- Bitmap indexing: `child_index = popcount(bitmap & ((1 << position) - 1))` maps from the 32-position hash space to the compact array index

This is the standard HAMT approach (used by Clojure, Scala, im-rs). The added complexity is justified by the significant memory savings, especially for sparse internal nodes.

**Vec trie nodes** use fixed-size `Array(Option(T), 32)` since trie nodes are typically dense (sequential indices fill left-to-right). Compact arrays would add complexity with minimal benefit for dense nodes.

### 4. Iterator stack for tree traversal

Tree-based iterators (Vec trie, Map HAMT, SortedMap RB-tree) need a stack to track position:

```rust
MapIter :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(
  struct(
    _stack : ArrayList(struct(node: MapNode(K, V), idx: usize)),
    _remaining : usize
  )
);
```

The stack is mutable (iterator state), but the **data being iterated** is immutable and shared. The iterator holds references to `atomic object` nodes, keeping them alive during iteration.

### 5. Performance vs mutable collections

Persistent structures have inherent overhead vs mutable ones:

| Operation | Mutable HashMap    | imm.Map (HAMT)          |
| --------- | ------------------ | ----------------------- |
| Lookup    | O(1) average       | O(log₃₂ n) ≈ O(1)       |
| Insert    | O(1) amortized     | O(log₃₂ n) + allocation |
| Memory    | Compact flat table | Trie nodes + RC headers |

The 32-way branching keeps the constant factor small (depth ≤ 7 for 4 billion entries). The primary cost is allocation of new path-copied nodes.

### 6. Equality and hashing

Structural equality for persistent collections:

- **O(1) fast path**: If two values point to the same `atomic object` node, they are equal (pointer/identity equality).
- **O(n) slow path**: Otherwise, compare element by element.

This optimization is significant for persistent data structures where many values share structure.

### 7. `Send` auto-derivation

Since `atomic object` auto-derives `Send` when all fields are `Send`, and the outer `struct` wrappers (List, Vec, Map, etc.) also auto-derive `Send` when their fields are `Send`, the entire chain is automatic. The `where(T <: Send)` constraint on type constructors ensures user-provided element types are also `Send`.

### 8. Conversion between mutable and immutable

Provide conversion methods:

```rust
// Mutable → Immutable (copies data into persistent structure)
imm_list := List(i32).from_array_list(mutable_array_list);
imm_map := Map(K, V).from_hash_map(mutable_hash_map);
imm_str := imm.String.from_string(mutable_string);

// Immutable → Mutable (copies data out)
mutable_list := imm_list.to_array_list();
mutable_map := imm_map.to_hash_map();
mutable_str := imm_str.to_string();
```

### 9. Builder pattern for efficient bulk construction

Building a persistent structure one element at a time is O(n log n) due to repeated path copying. Provide transient/builder APIs for O(n) bulk construction:

```rust
// Builder API — mutable internally, produces immutable result
builder := Vec(i32).builder();
// ... add many elements to builder (mutable, O(1) amortized each) ...
imm_vec := builder.build();  // Freeze into immutable Vec
```

The builder uses a mutable internal representation during construction, then "freezes" it into the persistent structure. This mirrors Clojure's transient collections.

---

## Implementation Phases

### Phase 0 — `atomic object(...)` Compiler Support

- Add `atomic` keyword to lexer
- Update parser to handle `atomic object(...)` syntax
- Add `isAtomicRc` field to `StructType`
- Update evaluator to set `isAtomicRc` and generate atomic `___dup`/`___drop`
- Update Send auto-derivation to include atomic objects
- Update codegen to emit `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` for atomic objects
- Write tests for `atomic object` (basic creation, Send derivation, Dispose)
- Test file: `tests/atomic_object.test.yo`

### Phase 1 — `imm.List(T)`

- Create `std/imm/` directory
- Implement `List(T)` with `atomic object` nodes
- Establish patterns: Send constraints, structural sharing
- Implement core traits: Eq, Clone, Hash, Iterator, IntoIterator, ToString
- Write tests in `tests/imm_list.test.yo`

### Phase 2 — `imm.String`

- Implement `String` as `atomic object` with Dispose for byte buffer cleanup
- Port relevant std/string String methods (read-only ones)
- Implement Eq, Ord, Hash, Clone, ToString, Index traits
- Conversion: `std.String ↔ imm.String`, `str → imm.String`
- Write tests in `tests/imm_string.test.yo`

### Phase 3 — `imm.Vec(T)`

- Implement bit-partitioned trie with tail buffer
- Core operations: get, set, push, pop
- Implement traits: Eq, Clone, Hash, Iterator, IntoIterator, Index, ToString
- Write tests in `tests/imm_vec.test.yo`

### Phase 4 — `imm.Map(K, V)` + `imm.Set(T)`

- Implement HAMT with `atomic object` nodes
- Handle hash collisions
- Implement Set as Map wrapper
- Write tests in `tests/imm_map.test.yo`, `tests/imm_set.test.yo`

### Phase 5 — `imm.SortedMap(K, V)` + `imm.SortedSet(T)`

- Implement persistent red-black tree with `atomic object` nodes
- Balancing operations with path copying
- Ordered iteration
- Implement `SortedSet(T)` as wrapper around `SortedMap(T, unit)`
- Write tests in `tests/imm_sorted_map.test.yo`, `tests/imm_sorted_set.test.yo`

### Phase 6 — Builders + Optimizations ✅ DONE

- **Bulk constructors**: Added `from_slice` (Vec, Set, SortedSet) and `from_entries` (Map, SortedMap)
  - `Vec.from_slice` uses memcpy for O(n) bulk copy
  - `Map.from_entries` / `SortedMap.from_entries` accept `Slice(Pair(K,V))`
  - `Set.from_slice` / `SortedSet.from_slice` accept `Slice(T)`
  - SortedMap imports `Pair` from `map.yo`
- **Eq simplification**: Set/SortedSet delegate equality to inner Map/SortedMap
  - Map/SortedMap: added empty-length fast path `(lhs._len == 0 && rhs._len == 0)`
- **Pointer equality**: Not feasible — Yo cannot cast `atomic object` to pointer/integer for identity comparison. Deferred until language-level support is added.
- **Small-map optimization**: Deferred — not high priority; HAMT already performs well for small maps.
- **Performance benchmarks**: Deferred — no benchmark framework in Yo yet.
- Tests added for all from_slice/from_entries APIs across all 5 collection test files.

### Phase 7 — Migrate `std/sync` to `atomic object` ✅ DONE

- Migrated `Mutex`, `Cond`, `Once`, `RwLock`, `WaitGroup` from `object(...)` to `atomic object(...)`
- They now natively implement `Send` without needing `Arc` wrapper
- Added `impl(Send)` for `__YO_THREAD_SYNC_TYPE` and `__YO_COND_TYPE` extern types
  so Mutex/Cond auto-derive Send as atomic objects
- **Channel** migrated to `atomic object` with inline ring buffer (replaced `Deque(T)`)
  - Added `where(T <: Send)` constraint on type constructor
  - Custom `Dispose` to drop remaining elements and free buffer
  - Tests updated: removed `arc()` wrapping and `.(*)` dereferences
- All `tests/sync/` tests pass: channel (24), once (11), waitgroup (14), rwlock (15)

### Phase 8 — Remove Builtin Arc ✅ DONE

- Removed ~800 lines of builtin `Arc` support from the compiler (type system, evaluator, codegen)
- Redefined `Arc` in `std/prelude.yo` as `atomic object((*) : V)` — same pattern as `Box`
- `arc(value)` helper function and `impl(forall(T : Type), Arc(T), Send())` in prelude
- `a.(*)` dereference syntax works unchanged (field named `*`, same as Box)
- All 14 Arc tests pass with zero test changes
- All sync/imm tests pass (no regressions)

---

## Resolved Decisions

1. **Module path**: `std/imm` — short and ergonomic for imports.
2. **Type names**: Bare names (`List`, `Vec`, `Map`, `String`, `Set`, `SortedMap`, `SortedSet`) — no `Imm` prefix. Users disambiguate via explicit imports. **PARTIALLY REVERSED for the string (2026-08-26, D4 PR 5): the string type is now `ImmString`** — see the superseded naming note in §2 above; the collections keep their bare names.
3. **`imm.String` vs `std/string.String`**: They are separate types. The immutable one (**`ImmString`** since 2026-08-26) is for thread-safe sharing; `std/string.String` remains the mutable single-threaded string. No deprecation or replacement planned.
4. **`std/sync` migration**: Complete. All sync primitives (Mutex, Cond, Once, RwLock, WaitGroup, Channel) use `atomic object` and auto-derive `Send`.
5. **Builder API location**: Builders live in the same file as each collection (not separate files).
6. **`SortedSet(T)`**: Included — wrapper around `SortedMap(T, bool)`, added to Phase 5.
7. **`Arc` as library type**: Builtin `Arc` removed from compiler. Now defined in prelude as `atomic object((*) : V)`, sharing identical C-level atomics. Simplifies the compiler and proves `atomic object` is sufficient.
