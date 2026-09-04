# Atomic Object & Immutable Collection Optimizations
> **ARCHIVED 2026-09-04 — RECORD OF APPLIED OPTIMIZATIONS** (the rc()
> thread-safety fix and the std/imm optimizations described here are in the
> tree; nothing pending).


This document records the optimizations applied to `atomic object(...)` types
and `std/imm/*` persistent data structures.

---

## 1. `rc()` thread-safety fix

The `rc()` builtin originally emitted a plain memory read:

```c
((__yo_ref_header_t*)(ptr))->ref_count
```

For `atomic object(...)`, this is a **C11 data race** (undefined behavior). Fixed
to use atomic load:

```c
atomic_load_explicit(
    (_Atomic size_t*)&((__yo_ref_header_t*)(ptr))->ref_count,
    memory_order_acquire
)
```

`acquire` ordering ensures that if the check returns 1, we see all prior writes
to the object's fields before mutating.

**Why TOCTOU is not a concern for `rc == 1`:** If the atomic load returns 1, no
other thread holds a reference. No other thread can increment RC because they
have no pointer to increment. The value is provably thread-local at that instant.

Location: `src/codegen/exprs/rc-fns.ts`.

---

## 2. Copy-on-Write (COW) for Vec and String

### Design: `own(self)` COW

Inspired by Swift's `isKnownUniquelyReferenced` + `mutating` pattern. The
equivalent in Yo is `own(self)`:

```rust
push : (fn(own(self): Self, val: T) -> Self)
```

With `own(self)`:

- The caller **transfers ownership** (no dup, RC unchanged).
- Inside the function, `rc(self) == usize(1)` means truly unique.
- The function can safely mutate in place and return the same object.
- The caller's old binding is **consumed** — no persistence violation.

If the caller wants to preserve old versions, they explicitly clone:

```rust
v := Vec(i32).new();
v = v.push(i32(1));     // rc=1 -> mutate in place, O(1)
v = v.push(i32(2));     // rc=1 -> mutate in place, O(1)

old := v;               // dup, rc=2
v = v.push(i32(3));     // rc=2 -> copy path, O(n)
// old still has [1, 2], v has [1, 2, 3]
```

| Swift                                 | Yo equivalent                       |
| ------------------------------------- | ----------------------------------- |
| `mutating func append(...)`           | `fn(own(self): Self, ...) -> Self`  |
| `let arr2 = arr` (share)              | `arr2 := arr` (dup, RC incremented) |
| `isKnownUniquelyReferenced(&storage)` | `rc(self) == usize(1)`              |

### Why not borrow-based COW?

With borrowed `self`, if `push` mutates in place when `rc == 1` then returns
`self` (which inserts `___dup`), both the caller's binding and the return value
point to the **same mutated object** — breaking persistence semantics. The
`own(self)` approach avoids this by consuming the caller's reference.

### COW coverage

Only `Vec(T)` and `imm.String` benefit from COW — they are `atomic object` types
with flat buffers where mutation copies ALL elements/bytes.

The remaining collections (`Map`, `SortedMap`, `Set`, `SortedSet`, `List`) are
`struct` types. Their internal tree nodes are `atomic object`, but per-node COW
is not feasible because `match` extraction dups inner RC values, making uniqueness
checks unreliable at each recursion level. These collections already use structural
sharing (O(log n) path-copies per mutation), which is efficient enough.

`List.prepend` is inherently O(1) — no COW needed.

| Collection   | Type             | COW | Notes                                          |
| ------------ | ---------------- | --- | ---------------------------------------------- |
| `Vec(T)`     | `atomic object`  | ✓   | `push`, `set`, `pop`, `concat`, `reverse`, etc |
| `imm.String` | `atomic object`  | ✓   | `concat`, `to_lowercase`, `to_uppercase`       |
| `Map(K,V)`   | `struct`         | —   | HAMT structural sharing, O(log n)              |
| `SortedMap`  | `struct`         | —   | LLRB structural sharing, O(log n)              |
| `Set(T)`     | `struct` wrapper | —   | Delegates to Map                               |
| `SortedSet`  | `struct` wrapper | —   | Delegates to SortedMap                         |
| `List(T)`    | `struct`         | —   | `prepend` already O(1)                         |

Read-only methods (`len`, `get`, `contains`, `iter`, etc.) remain borrowed:

```rust
len : (fn(self: Self) -> usize)                  // borrow, no mutation
get : (fn(self: Self, idx: usize) -> Option(T))  // borrow, no mutation
```

---

## 3. Atomic RC memory ordering relaxation

Atomic RC operations originally used the default `memory_order_seq_cst` (implicit
in `atomic_fetch_add`/`atomic_fetch_sub`). Relaxed to the standard Arc pattern:

| Operation    | Ordering               | Rationale                                     |
| ------------ | ---------------------- | --------------------------------------------- |
| Increment    | `memory_order_relaxed` | No ordering needed for new reference creation |
| Decrement    | `memory_order_acq_rel` | Acquire on last drop to see all prior writes  |
| `rc()` check | `memory_order_acquire` | See all writes before acting on uniqueness    |

Same pattern as Rust `Arc`, Swift ARC, C++ `shared_ptr`. Changed in both GC and
non-GC code paths in `src/codegen/functions/generation.ts`.

---

## Compiler Bugs Fixed During COW Implementation

Five compiler bugs were discovered and fixed:

1. **Dup/drop optimizer: consumed derived variable** (`begin.ts`) — optimizer
   cancels dup for `v2 := v` with `v`'s scope-end drop even when `v2` is
   consumed by `own(push)`. Fixed with `consumedDerivedCountByBase` tracking.

2. **Assignment codegen UAF** (`assignment.ts`) — `v = v.push(i32(1))` where
   push has `own(self)`: LHS `v` consumed during RHS eval, codegen tries to
   attach temp to consumed variable. Fixed with `consumedAtToken` check.

3. **Return-own-parameter leak** (`begin.ts`, `return.ts`) — two sub-issues:
   (a) `return self` generates unnecessary dup; (b) `return Struct(vec: self)`
   dups self for struct field but never drops it. Fixed with parameter name
   matching and own-parameter deferred drops.

4. **Pending deferred drops for consumed variables** (`return.ts`) — when all
   match branches return, variables consumed within branches appear unconsumed
   in merged env, causing double-drops. Fixed by checking `consumedAtToken`
   in `generatePendingDeferredDrops`.

5. **Dup/drop optimizer: consumed base variable** (`begin.ts`) — `b := a` then
   `a.concat(own)` incorrectly cancels dup(a)→b because optimizer only checked
   consumed derived variables, not consumed base. Fixed with `baseConsumed`
   check.

See `issues/` directory for detailed write-ups of each bug.

---

## 4. Send enforcement for atomic object

`atomic object` types now produce a **hard compile error** if any field does not
implement `Send`. This catches mistakes early — e.g., putting a regular `object`
(non-thread-safe) inside an `atomic object`.

The `Acyclic` trait is **auto-derived** for types that cannot form reference cycles
(checked structurally). Self-referential types like `ListNode(_next: Option(Self))`
do not auto-derive `Acyclic`, but can declare it manually via
`impl(ListNode(T), Acyclic())`. This opt-in pattern is used by `std/imm/list` and
`std/imm/sorted_map` for their immutable node types, where the immutability
invariant prevents cycles at runtime despite structural self-reference.

Location: `src/evaluator/types/struct.ts` (enforcement check after auto-derive).
