# Iterator Implementation Plan
> **ARCHIVED 2026-09-04 — IMPLEMENTED.** The Iterator/IntoIterator traits and the `for`
> macro live in `std/prelude.yo`; collection support shipped across `std/`
> (combinator coverage in tests/iterator_combinators.test.yo).


## Overview

Implement Rust-style iterator support for all Yo standard library collections. The `Iterator` and `IntoIterator` traits and the `for` macro are defined in `prelude.yo`. This plan adds iterator support across the entire `std/` library.

> **Note:** The `Iterator` and `IntoIterator` traits now use direct trait types with associated types (see [Associated Types plan](../reference/ASSOCIATED_TYPES.md)). The syntax has been updated from the original function-wrapper pattern (`Iterator(T)(next : ...)`) to direct trait fields (`Iterator(Item : T, next : ...)`).

## Design Decisions

### Following Rust's Approach

Two iteration modes for each collection:

| Method        | Self parameter               | Iterator yields | Semantics                          |
| ------------- | ---------------------------- | --------------- | ---------------------------------- |
| `into_iter()` | `self: Self` (by value)      | `T`             | Takes ownership of the RC handle   |
| `iter()`      | `self: *(Self)` (by pointer) | `*(T)`          | Borrows the collection via pointer |

- `into_iter` is the `IntoIterator` trait method — works with `for` macro
- `iter` is a conventional method (not trait-based) — also works with `for` macro
- Since Yo has no mutable/immutable reference distinction (only mutable pointers), we omit `iter_mut` — `iter()` already returns mutable pointers

### Existing Infrastructure (prelude.yo)

**Iterator trait** — direct trait with associated type `Item`:

```rust
Iterator :: trait(
  Item : Type,
  next : (fn(self : *(Self)) -> Option(Self.Item))
);
```

**IntoIterator trait** — with `where` clause constraining the iterator's `Item` type:

```rust
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

> **History:** These traits were originally defined as function wrappers (`fn(...) -> Trait`). They were migrated to direct trait types with associated types as part of the [Associated Types redesign](../reference/ASSOCIATED_TYPES.md).

**`for` macro** (lines 3685–3743):

```rust
for iter_expr, (variable) => { body };
// Expands to:
// iter_var := iter_expr;
// while true { match(&(iter_var).next(), .Some(variable) => body, .None => break) }
```

### Iterator Struct Pattern

Each collection defines:

1. **Value iterator struct** — implements `Iterator(Item : T, ...)`, used by `into_iter()`
2. **Pointer iterator struct** — implements `Iterator(Item : *(T), ...)`, used by `iter()`

Both are `struct` (value types), not `object`. Iterators are lightweight, stack-allocated, and mutated via pointer by the `for` macro.

```rust
// Pattern for each collection (VERIFIED WORKING SYNTAX):
CollectionIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _source : Collection(T),   // RC handle keeps collection alive
    _index  : usize            // iteration state
  )
;

impl(forall(T : Type), CollectionIter(T), Iterator(
  Item : T,
  // IMPORTANT: Use expression form (cond(...)), NOT block form ({...})
  next : (fn(self : *(Self)) -> Option(Self.Item))(cond(
    self.*._index < self.*._source.length(), {
      val := self.*._source.get(self.*._index);
      self.*._index = self.*._index + usize(1);
      return Option(T).Some(val);
    },
    true, Option(T).None
  ))
));

// into_iter as PLAIN METHOD (not IntoIterator trait — see Lessons Learned)
impl(forall(T : Type), Collection(T),
  into_iter : (fn(self : Self) -> CollectionIter(T))(
    CollectionIter(T)(_source: self, _index: usize(0))
  )
);
```

For the pointer variant:

```rust
CollectionIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _source : Collection(T),   // RC handle
    _index  : usize
  )
;

impl(forall(T : Type), CollectionIterPtr(T), Iterator(
  Item : *(T),
  next : (fn(self : *(Self)) -> Option(Self.Item))(cond(
    self.*._index < self.*._source.length(), {
      ptr := self.*._source._ptr &+ self.*._index;
      self.*._index = self.*._index + usize(1);
      return Option(*(T)).Some(ptr);
    },
    true, Option(*(T)).None
  ))
));

impl(forall(T : Type), Collection(T),
  iter : (fn(self : *(Self)) -> CollectionIterPtr(T))(
    CollectionIterPtr(T)(_source: self.*, _index: usize(0))
  )
);
```

---

## Lessons Learned (from ArrayList implementation)

### 1. Trait impl function bodies must use expression form

Trait impl function bodies using block form `({...})` cause "Enum variant not selected" errors. Use expression form `(cond(...))` instead — the cond branches can still contain `{...}` begin blocks.

```rust
// ❌ WRONG — causes evaluator error
next : (fn(self : *(Self)) -> Option(T))({
  // body
})

// ✅ CORRECT
next : (fn(self : *(Self)) -> Option(T))(cond(
  condition, { ... },
  true, fallback_value
))
```

### 2. IntoIterator trait was unusable for generic impls (now resolved)

`Self.IntoIter` in the IntoIterator trait could not be resolved for `impl(forall(T), ...)` due to the same evaluator limitation that affected `Self.Item`. This was addressed by the [Associated Types redesign](../reference/ASSOCIATED_TYPES.md), which added proper associated type support via `extractTraitTypeArgsFromImplExpr` for direct trait types.

**Current status:** The IntoIterator trait now works correctly with associated types and where clause enforcement. However, the existing `into_iter` implementations remain as plain methods (not IntoIterator trait impls) since they were written before the fix and work correctly as-is. The `for` macro doesn't require IntoIterator — it just calls `.next()` on whatever is returned by the expression.

### 3. Named field constructors required for structs

Struct constructors use named fields: `Type(_field: value)` not positional `Type(value1, value2)`.

### 4. Evaluator fix was needed for Self.Item resolution

Added `findAssociatedTypeFromGenericImpls` in `src/evaluator/values/impl.ts` (called from `src/evaluator/exprs/property-access.ts`) to resolve associated types like `Self.Item` from generic impl declarations.

### 5. `iter()` auto-referencing works

`list.iter()` works even when `iter` takes `self: *(Self)` — Yo auto-references the receiver. No need for `(&list).iter()`.

### 6. Iterator types should be exported

Iterator struct types are exported alongside the collection type, allowing users to name them if needed.

### Safety Note

`iter()` returns raw pointers to elements within the collection's backing storage. Modifying the collection during iteration (e.g., pushing to an ArrayList causing reallocation) invalidates these pointers. Yo has no borrow checker — this is the user's responsibility, consistent with Yo's approach to raw pointers.

---

## Phase 1: Core Collections — `into_iter` and `iter`

### 1.1 `std/collections/array_list.yo` — ArrayList(T)

**Iterator structs:**

```rust
ArrayListIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _list  : ArrayList(T),
    _index : usize
  )
;

ArrayListIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _list  : ArrayList(T),
    _index : usize
  )
;
```

**Implementations:**

- `impl(forall(T), ArrayListIter(T), Iterator(Item : T, ...))` — `next` returns `_list.get(_index)`, increments `_index`
- `impl(forall(T), ArrayListIterPtr(T), Iterator(Item : *(T), ...))` — `next` returns pointer to element at `_index` in backing buffer (`_list._ptr &+ _index`)
- `impl(forall(T), ArrayList(T), into_iter)` — plain method (not IntoIterator trait), creates `ArrayListIter(T)(_list: self, _index: usize(0))`
- `impl(forall(T), ArrayList(T), iter)` — `iter` takes `*(Self)`, returns `ArrayListIterPtr(T)(_list: self.*, _index: usize(0))`

---

### 1.2 `std/collections/linked_list.yo` — LinkedList(T)

**Iterator structs:**

```rust
LinkedListIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _current : Option(Node(T))
  )
;

LinkedListIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _current : Option(Node(T))
  )
;
```

**Implementations:**

- `impl(forall(T), LinkedListIter(T), Iterator(Item : T, ...))` — `next` pattern-matches `_current`: `.Some(node)` yields `node.value`, advances to `node.next`; `.None` returns `.None`
- `impl(forall(T), LinkedListIterPtr(T), Iterator(Item : *(T), ...))` — `next` yields `&(node.value)` (pointer to the node's value field)
- `impl(forall(T), LinkedList(T), into_iter)` — plain method, creates iter from `self.head`
- `impl(forall(T), LinkedList(T), iter)` — takes `*(Self)`, creates iter from `self.*.head`

---

### 1.3 `std/collections/deque.yo` — Deque(T)

**Iterator structs:**

```rust
DequeIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _deque     : Deque(T),
    _pos       : usize,
    _remaining : usize
  )
;

DequeIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _deque     : Deque(T),
    _pos       : usize,
    _remaining : usize
  )
;
```

**Implementations:**

- `next` computes physical index as `(_deque._head + _pos) % _deque._capacity`, reads element, increments `_pos`, decrements `_remaining`
- Pointer variant returns `*(T)` to the element in the circular buffer
- `into_iter` creates `DequeIter(T)(self, usize(0), self._len)`
- `iter` takes `*(Self)`

---

### 1.4 `std/collections/hash_map.yo` — HashMap(K, V)

**Iterator structs:**

```rust
HashMapIter :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  struct(
    _map   : HashMap(K, V),
    _index : usize
  )
;

HashMapIterPtr :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  struct(
    _map   : HashMap(K, V),
    _index : usize
  )
;
```

**Yields:** `Bucket(K, V)` (which is `struct(key: K, value: V)`)

**Implementations:**

- `impl(forall(K, V), where(K <: (Eq(K), Hash)), HashMapIter(K, V), Iterator(Item : Bucket(K, V), ...))` — `next` scans `ctrl` array from `_index` for occupied slots (ctrl byte with high bit clear = occupied), yields `_map._data_ptr() &+ i`, increments `_index`
- Pointer variant: `Iterator(Item : *(Bucket(K, V)), ...)` — yields pointer to bucket
- `into_iter` plain method on `HashMap(K, V)`
- `iter` method on `HashMap(K, V)`

**Additional iterators:**

- `keys()` → iterator yielding `K` values
- `values()` → iterator yielding `V` values

```rust
HashMapKeys :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  struct(_inner : HashMapIter(K, V))
;
// impl Iterator(K) — wraps inner iter, extracts .key

HashMapValues :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  struct(_inner : HashMapIter(K, V))
;
// impl Iterator(V) — wraps inner iter, extracts .value
```

---

### 1.5 `std/collections/hash_set.yo` — HashSet(T)

**Iterator structs:**

```rust
HashSetIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _set   : HashSet(T),
    _index : usize
  )
;

HashSetIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _set   : HashSet(T),
    _index : usize
  )
;
```

**Implementations:**

- `impl(forall(T), where(T <: (Eq(T), Hash)), HashSetIter(T), Iterator(Item : T, ...))` — scans ctrl array for occupied slots, yields element values
- Pointer variant: `Iterator(Item : *(T), ...)` — yields pointer to element
- `into_iter` plain method on `HashSet(T)`
- `iter` method

---

### 1.6 `std/collections/btree_map.yo` — BTreeMap(K, V)

Since BTreeMap uses a sorted `ArrayList(BTreeEntry(K, V))` internally, iteration is straightforward.

**Iterator structs:**

```rust
BTreeMapIter :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  struct(
    _entries : ArrayList(BTreeEntry(K, V)),
    _index   : usize
  )
;

BTreeMapIterPtr :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  struct(
    _entries : ArrayList(BTreeEntry(K, V)),
    _index   : usize
  )
;
```

**Yields:** `BTreeEntry(K, V)` (sorted order)

**Implementations:**

- `impl(forall(K, V), BTreeMapIter(K, V), Iterator(Item : BTreeEntry(K, V), ...))` — iterates over `_entries` by index
- Pointer variant: `Iterator(Item : *(BTreeEntry(K, V)), ...)`
- `into_iter` plain method on `BTreeMap(K, V)`
- `iter` method

**Additional:** `keys()` → `K`, `values()` → `V`

---

### 1.7 `std/collections/priority_queue.yo` — PriorityQueue(T)

Iteration yields elements in **arbitrary heap order** (not sorted), consistent with Rust's `BinaryHeap::iter()`.

**Iterator structs:**

```rust
PriorityQueueIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _data  : ArrayList(T),
    _index : usize
  )
;

PriorityQueueIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _data  : ArrayList(T),
    _index : usize
  )
;
```

**Implementations:**

- Iterates over `_data` ArrayList (heap array) by index
- `into_iter` plain method on `PriorityQueue(T)`
- `iter` method

---

## Phase 2: String Iterators

### 2.1 `std/string/string.yo` — String

String iteration is different — runes are decoded from UTF-8 bytes on-the-fly, so the pointer variant (`iter`) is not applicable for rune iteration.

**Iterator structs:**

```rust
StringChars :: struct(
  _string     : String,
  _byte_index : usize
);

StringBytes :: struct(
  _string : String,
  _index  : usize
);
```

**Methods on String:**

- `chars()` → `StringChars` — implements `Iterator(rune)`, decodes UTF-8 runes sequentially
- `bytes()` → `StringBytes` — implements `Iterator(u8)`, yields raw bytes

**IntoIterator:** `into_iter` plain method on String — yields runes (like Rust's `String::chars()`)

**No pointer variant** — runes are decoded values, not stored contiguously in memory as `rune` values.

---

## Phase 3: Builtin Types (Future)

### 3.1 Array(T, N)

Array is a value type. `iter` with `self: *(Self)` is the natural fit.

```rust
ArrayIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _ptr : *(T),
    _index : usize,
    _len : usize
  )
;
```

- `iter` on `*(Array(T, N))` yields `*(T)` — pointer to each element
- This requires `impl(forall(T, N), Array(T, N), iter : ...)` in `prelude.yo`

### 3.2 Slice(T)

Similar to Array but dynamically sized.

```rust
SliceIter :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(
    _ptr : *(T),
    _index : usize,
    _len : usize
  )
;
```

- `iter` on `*(Slice(T))` yields `*(T)`

**Note:** Array and Slice iterators are Phase 3 because they are **builtin types** defined in `prelude.yo` and may require more careful integration.

---

## Phase 4: Iterator Adapters (Future)

Following Rust, add adapter methods to Iterator itself in `prelude.yo`. Each adapter returns a new iterator struct.

| Adapter        | Description                      | Returns                                                                   |
| -------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `map(f)`       | Transform each element           | `Map(Self, F)` implementing `Iterator(U)`                                 |
| `filter(f)`    | Keep elements matching predicate | `Filter(Self, F)` implementing `Iterator(T)`                              |
| `enumerate()`  | Pair elements with index         | `Enumerate(Self)` implementing `Iterator(struct(index: usize, value: T))` |
| `zip(other)`   | Pair elements from two iterators | `Zip(Self, Other)`                                                        |
| `take(n)`      | First n elements                 | `Take(Self)` implementing `Iterator(T)`                                   |
| `skip(n)`      | Skip first n elements            | `Skip(Self)` implementing `Iterator(T)`                                   |
| `chain(other)` | Concatenate two iterators        | `Chain(Self, Other)`                                                      |

**Consuming methods** (return non-iterator values):

| Method          | Description                 | Returns        |
| --------------- | --------------------------- | -------------- |
| `fold(init, f)` | Reduce to single value      | `U`            |
| `collect()`     | Collect into ArrayList      | `ArrayList(T)` |
| `count()`       | Count elements              | `usize`        |
| `any(f)`        | True if any element matches | `bool`         |
| `all(f)`        | True if all elements match  | `bool`         |
| `find(f)`       | First matching element      | `Option(T)`    |
| `sum()`         | Sum of elements             | `T`            |
| `last()`        | Last element                | `Option(T)`    |
| `nth(n)`        | Nth element                 | `Option(T)`    |

Phase 4 is deferred — requires further design for generic adapter structs with function type parameters.

---

## Test Plan

One test file per collection at `tests/collections/<name>.test.yo` (append to existing test files).

### Test categories per collection:

**`into_iter` tests:**

1. Empty collection — `for` loop body never executes
2. Single element — body executes once with correct value
3. Multiple elements — correct order, all elements visited
4. Use with `for` macro syntax

**`iter` (pointer) tests:** 5. Elements accessible via pointer dereference (`.*`) 6. Pointer modification — mutate element through pointer, verify collection changed 7. Use with `for` macro syntax (variable is `*(T)`)

**String-specific tests:** 8. `chars()` — ASCII string yields correct runes 9. `chars()` — multi-byte UTF-8 (emoji, CJK) yields correct runes 10. `chars()` — empty string yields nothing 11. `bytes()` — yields raw byte values 12. `into_iter` on String yields runes (default)

### Test file plan:

| File                                                               | New tests | Description                                                             |
| ------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------- |
| `tests/collections/array_list.test.yo`                             | 6         | into_iter empty/single/multi, iter ptr/deref/mutate                     |
| `tests/collections/linked_list.test.yo`                            | 6         | into_iter empty/single/multi, iter ptr/deref/mutate                     |
| `tests/collections/deque.test.yo`                                  | 6         | into_iter empty/single/multi, iter ptr/deref/mutate                     |
| `tests/collections/hash_map.test.yo`                               | 8         | into_iter empty/single/multi, iter ptr, keys(), values()                |
| `tests/collections/hash_set.test.yo`                               | 5         | into_iter empty/single/multi, iter ptr/deref                            |
| `tests/collections/btree_map.test.yo`                              | 7         | into_iter empty/single/multi (sorted order), iter ptr, keys(), values() |
| `tests/collections/priority_queue.test.yo`                         | 4         | into_iter empty/single/multi, iter ptr                                  |
| `tests/string/string.test.yo` (or new `tests/string/iter.test.yo`) | 6         | chars ascii/utf8/empty, bytes, into_iter                                |
| **Total**                                                          | **~48**   |                                                                         |

---

## Implementation Order

| Step | File(s)                             | What                                                                             | Status  |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------- | ------- |
| 1    | `std/collections/array_list.yo`     | `ArrayListIter`, `ArrayListIterPtr`, `into_iter`, `iter` + tests                 | ✅ Done |
| 2    | `std/collections/linked_list.yo`    | `LinkedListIter`, `LinkedListIterPtr`, `into_iter`, `iter` + tests               | ✅ Done |
| 3    | `std/collections/deque.yo`          | `DequeIter`, `DequeIterPtr`, `into_iter`, `iter` + tests                         | ✅ Done |
| 4    | `std/collections/hash_set.yo`       | `HashSetIter`, `HashSetIterPtr`, `into_iter`, `iter` + tests                     | ✅ Done |
| 5    | `std/collections/hash_map.yo`       | `HashMapIter`, `HashMapIterPtr`, `into_iter`, `iter`, `keys`, `values` + tests   | ✅ Done |
| 6    | `std/collections/btree_map.yo`      | `BTreeMapIter`, `BTreeMapIterPtr`, `into_iter`, `iter`, `keys`, `values` + tests | ✅ Done |
| 7    | `std/collections/priority_queue.yo` | `PriorityQueueIter`, `PriorityQueueIterPtr`, `into_iter`, `iter` + tests         | ✅ Done |
| 8    | `std/string/string.yo`              | `StringChars`, `StringBytes`, `chars`, `bytes`, `into_iter` + tests              | ✅ Done |
| 9    | `std/prelude.yo`                    | Array(T, N) and Slice(T) iterators                                               | ✅ Done |
| 10   | `std/prelude.yo`                    | Iterator adapter methods (map, filter, fold, etc.)                               | Future  |

**Strategy:** Start with ArrayList — it's the simplest and most commonly used. Validate that the `Iterator`/`IntoIterator` trait implementations and `for` macro work end-to-end. Then apply the same pattern to other collections.

---

## Open Questions

1. **HashMap/HashSet ctrl byte semantics** — Need to verify which ctrl byte values indicate occupied vs empty/deleted slots during implementation.
2. ~~**Struct constructor syntax**~~ — **RESOLVED:** Named fields required: `ArrayListIter(T)(_list: self, _index: usize(0))`.
3. ~~**`iter()` auto-referencing**~~ — **RESOLVED:** Yo auto-references the receiver. `list.iter()` works even when `iter` takes `self: *(Self)`.
4. ~~**Export strategy**~~ — **RESOLVED:** Iterator types are exported alongside the collection type.
5. **PriorityQueue sorted iteration** — Consider adding `into_sorted_iter()` that pops elements in priority order (destructive but sorted). Deferred.
