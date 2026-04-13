# Atomic Object & Immutable Collection Optimizations

## Problem

`atomic object(...)` gives Yo a correct, thread-shareable, acyclic RC type, but
performance is left on the table in three places:

1. `std/imm/*` persistent data structures always path-copy, even when the internal
   buffer or node is uniquely owned.
2. The `rc()` builtin has a thread-safety bug for atomic objects (plain read
   instead of atomic load).
3. Atomic RC operations use `memory_order_seq_cst` (strongest, most expensive).

This document plans how to close those gaps.

## Scope

This plan covers:

- **shared compiler optimization work** that benefits both `object(...)` and
  `atomic object(...)`, plus
- **atomic-object-specific work** where thread-safe atomic RC changes the
  implementation constraints, plus
- **`std/imm/*` library-level COW** using `own(self)` + `rc == 1` checks.

The existing `object(...)` ownership model is documented in
`docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` and
`plans/RC_OWNERSHIP_IMPLEMENTATION.md`. This plan does not restate it.

### What the evaluator already does uniformly

The evaluator-level ownership infrastructure already handles both `object(...)`
and `atomic object(...)` uniformly:

- `isOwningTheRcValue` / `isOwningTheSameRcValueAs` do not distinguish atomic
  from non-atomic.
- Phase 1.5 dup/drop cancellation in `src/evaluator/exprs/begin.ts` works for
  both types.
- Loop traversal borrow chain optimization applies uniformly to all RC types.

The real missing pieces are:

1. A thread-safe uniqueness check (prerequisite bug fix).
2. A copy-on-write (COW) mechanism usable by `std/imm/*` implementations.
3. Cross-function and cross-loop dup/drop elimination (all RC types).
4. Atomic RC memory ordering relaxation (codegen-level, atomic-specific).

## Goals

- Enable safe in-place mutation when an atomic object is provably unique.
- Speed up `std/imm/*` persistent data structures without changing semantics.
- Reduce unnecessary `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`.
- Keep `atomic object(...)` acyclic and thread-safe.

## Non-Goals

- Adding cycle GC to `atomic object(...)`.
- Making shared atomic objects generally mutable in place.
- Doing a full Perceus-style ownership rewrite as the first step.
- Adding `_mut` / `_cow` suffixed API variants.

---

## Design: `own(self)` COW

### Prior art: Swift `isKnownUniquelyReferenced`

Swift's COW collections check uniqueness inside `mutating` methods. The `mutating`
keyword ensures the caller cannot observe the old version through the same binding.
If `rc == 1`, the method mutates in place; otherwise it copies.

### Mapping to Yo

The equivalent of Swift's `mutating` is Yo's `own(self)`:

```rust
push : (fn(own(self): Self, val: T) -> Self)
```

With `own(self)`:

- The caller **transfers ownership** (no dup, RC unchanged).
- Inside the function, `rc(self) == usize(1)` means truly unique.
- The function can safely mutate in place and return the same object.
- The caller's old binding is **consumed** -- no persistence violation.

If the caller wants to preserve old versions, they explicitly clone:

```rust
// Normal usage -- v1 consumed, COW kicks in:
v1 := imm.Vec.new(i32);
v2 := v1.push(i32(1));      // v1 consumed; rc was 1 -> mutate in place
v3 := v2.push(i32(2));      // v2 consumed; rc was 1 -> mutate in place

// Preserving old version:
v4 := v3;                    // dup, rc = 2
v5 := v4.push(i32(3));      // v4 consumed; rc was 2 -> copy path taken
// v3 still alive with [1, 2], v5 has [1, 2, 3]
```

| Swift                                 | Yo equivalent                       |
| ------------------------------------- | ----------------------------------- |
| `mutating func append(...)`           | `fn(own(self): Self, ...) -> Self`  |
| `let arr2 = arr` (share)              | `arr2 := arr` (dup, RC incremented) |
| `isKnownUniquelyReferenced(&storage)` | `rc(self) == usize(1)`              |

### Why not borrow-based COW?

With borrowed `self`, if `push` mutates in place when `rc == 1` then returns
`self` (which inserts `___dup`), both the caller's binding and the return value
point to the **same mutated object** -- breaking persistence semantics. The
`own(self)` approach avoids this by consuming the caller's reference.

### API migration

All `std/imm/*` collection methods that return a modified version will change from:

```rust
push : (fn(self: Self, val: T) -> Self)          // borrow, always copy
```

to:

```rust
push : (fn(own(self): Self, val: T) -> Self)     // own, COW when unique
```

Read-only methods (`len`, `get`, `contains`, `iter`, etc.) remain borrowed:

```rust
len : (fn(self: Self) -> usize)                  // borrow, no mutation
get : (fn(self: Self, idx: usize) -> Option(T))  // borrow, no mutation
```

---

## Prerequisite: Fix `rc()` for atomic objects

**This must be done before any COW work.**

The current `rc()` codegen emits a plain memory read:

```c
((__yo_ref_header_t*)(ptr))->ref_count
```

For `atomic object(...)`, this is a **C11 data race** (undefined behavior). Fix:

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

Location: `src/codegen/exprs/rc-fns.ts` line ~543.

---

## Collection-specific impact analysis

| Collection           | Internal structure                      | Mutation cost today           | COW benefit                    | Priority |
| -------------------- | --------------------------------------- | ----------------------------- | ------------------------------ | -------- |
| **Vec**              | Flat buffer (`atomic object`)           | Copies **ALL n elements**     | **Huge** -- O(n) -> O(1)       | **1st**  |
| **String**           | Flat byte buffer (`atomic object`)      | Copies **ALL bytes**          | **Huge** -- O(n) -> O(1)       | **2nd**  |
| **Map (HAMT)**       | 32-way trie of `atomic object` nodes    | Path-copies 5-10 nodes        | **Good** -- reuse unique nodes | **3rd**  |
| **SortedMap (LLRB)** | Red-black tree of `atomic object` nodes | Path-copies ~2-3xlog(n) nodes | **Good** -- reuse unique nodes | **4th**  |
| **Set / SortedSet**  | Thin wrappers over Map / SortedMap      | Same as underlying map        | Same                           | Same     |
| **List**             | Singly-linked cons list                 | `prepend` already O(1)        | **Minimal**                    | **Low**  |

### Vec and String: flat buffer reuse

When `rc == 1`:

- `push`: write at `_ptr + _len`, increment `_len` in place (no copy).
- `set(i, val)`: overwrite at `_ptr + i` in place (no copy).
- `pop`: decrement `_len`, drop last element (no copy).

### HAMT and LLRB: node reuse on path

Per-node uniqueness check during recursive traversal. Recently-modified subtrees
tend to have unique nodes (benefit). Widely-shared historical versions do not
(falls back to current path-copy).

---

## Proposed Phases

### Phase 0 -- Prerequisite fixes

- Fix `rc()` to use `atomic_load_explicit(acquire)` for atomic object types.
- Verify `atomic object(...)` field mutation works through owned parameters.
- **This is a correctness fix, not an optimization.**

### Phase 1 -- Baseline measurement

- Add microbenchmarks for:
  - `std/imm` hot operations (`push`, `set`, `insert`, `remove`, `concat`)
  - atomic object copy chains
  - thread handoff / worker handoff
- Count atomic dup/drop operations in representative programs.
- Confirm the O(n)-copy hypothesis dominates cost for Vec/String.

### Phase 2 -- COW for Vec and String

Highest impact. Migrate `push`/`set`/`pop`/`concat` to `own(self)` + `rc == 1`:

- If unique: mutate in place, return self.
- If shared: allocate new buffer, copy, return new object.
- Update `imm.String` analogously.
- Benchmark to confirm O(n) -> O(1) for unique case.

### Phase 3 -- COW for tree collections

**STATUS: DEFERRED** — requires language-level "destructuring move" support.

The challenge: HAMT/LLRB nodes are `atomic object` types wrapped in a `MapNode`
enum. When `match` extracts a node, it dups the inner RC. At each recursion
level of `_node_insert`/`_node_remove`, the rc grows by 1, making uniqueness
checks unreliable:

- Level 0: `rc == original + 1` (extraction dup)
- Level 1: `rc == original + 2` (child extraction dup + extraction dup)
- Level N: `rc == original + N + 1`

Without destructuring move (consuming the enum to take ownership of its inner
RC field without duping), per-node COW requires brittle `rc == N+1` threshold
checks.

The structural sharing already provides O(log n) path-copies per mutation.
COW would improve to O(1) for uniquely-owned trees, but the fragility cost
outweighs the benefit until the language supports move semantics on pattern
matching.

### Phase 4 -- Shared compiler optimization

In parallel with library-level COW:

- **Cross-function dup/drop elimination**: extend cancellation across function
  call boundaries.
- **Cross-loop dup/drop elimination**: extend beyond the specific linked-list
  traversal pattern.
- **Consume/borrow propagation through temporaries**: improve tracking through
  helper calls.
- These benefit all RC types equally.

### Phase 5 -- Builders and atomic RC tuning

**STATUS: DONE**

- **Memory ordering relaxation** (implemented):

  - Increment: `memory_order_relaxed` (no ordering needed for new reference creation)
  - Decrement: `memory_order_acq_rel` (acquire on last drop to see all prior writes)
  - `rc()` check: `memory_order_acquire` (see all writes before acting on uniqueness)
  - Same pattern as Rust `Arc`, Swift ARC, C++ `shared_ptr`.
  - Changed in both GC and non-GC code paths in `generation.ts`.

- **Builder APIs**: NOT implemented — determined unnecessary.
  - `from_slice` / `from_entries` already exist for all collections.
  - With COW optimization, chained `push` on a unique Vec is already O(1) per op.
  - A builder would be syntactic sugar over what `v = v.push(x)` already achieves.

### Phase 6 -- Reassess broader RC optimization

After phases 2-5, decide whether Perceus-style lowering is still worth the
complexity. At that point we'll know whether the remaining cost is redundant RC
ops, path-copying, or atomic instruction overhead itself.

---

## Safety Constraints

- `atomic object(...)` remains **acyclic**.
- No cycle collector for atomic RC types.
- No in-place mutation on values that might still be observably shared.
- `rc == 1` is safe: no other thread holds a reference, so no concurrent
  increment is possible. `acquire` ordering ensures field visibility.
- `own(self)` guarantees the caller's binding is consumed, preventing observation
  of the mutated object through the "old" binding.

## Validation Strategy

- Keep all existing tests for `atomic object`, `std/imm/*`, `std/sync/*`.
- Add regressions for:
  - COW mutate-in-place (verify no allocation when unique)
  - Fallback-to-copy (verify copy when `rc > 1`)
  - Persistence semantics (clone + update preserves old version)
  - Thread handoff (sharing -> copy path)
  - RC-backed element correctness
  - Builder APIs
- Track benchmark deltas before/after each phase.

## Implementation Order

1. Fix `rc()` thread-safety (Phase 0) — **DONE**
2. Benchmark baseline (Phase 1) — pending
3. COW for Vec and String (Phase 2) — **DONE**
4. COW for Map and SortedMap (Phase 3) — **DEFERRED** (needs destructuring move)
5. Shared compiler optimization (Phase 4) — pending
6. Builders and atomic RC tuning (Phase 5) — **DONE** (memory ordering relaxed; builder APIs not needed — from_slice/from_entries exist, COW makes chained push O(1))
7. Re-evaluate Perceus-style lowering (Phase 6) — pending

## Compiler Bugs Fixed During COW Implementation

During Phase 2 implementation, five compiler bugs were discovered and fixed:

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
