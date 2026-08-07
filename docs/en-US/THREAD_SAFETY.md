# Thread Safety

Yo provides **data-race-freedom by default** for safe (non-pragma'd) code. Every shared-mutable handoff between threads goes through an audited synchronization primitive in `std/sync/`. Sharing unsynchronized state across threads is a compile error.

## The Guarantee

> For every program that compiles without `pragma(Pragma.AllowUnsafe)` and uses only primitives from `std/`, every shared cross-thread mutable access is mediated by a synchronization primitive. The program is data-race-free under the C11 memory model.

## The Send Trait

`Send` is a marker trait meaning "safe to transfer between threads." A type implements `Send` if it is safe to move a value of that type to another thread.

### Auto-Derivation

`Send` is auto-derived for structs, enums, unions, and tuples: a composite type is `Send` if **all** of its fields are `Send`.

```rust
// All fields are Send → Point is Send
Point :: struct(x : i32, y : i32);

// Regular reference type is NOT Send — it uses non-atomic RC
MyObj :: ref(struct(data : Vec(i32)));
```

### Manual Send Impls Require Pragma

Writing `impl(MyType, Send())` requires `pragma(Pragma.AllowUnsafe)` and a `// SAFETY:` comment explaining why the type is safe to send across threads. This ensures every manual Send claim is auditable.

## Atomic Objects vs Regular Objects

|                          | `ref(struct(...))`           | `atomic(ref(struct(...)))`              |
| ------------------------ | ---------------------------- | --------------------------------------- |
| **Reference counting**   | Non-atomic RC (thread-local) | Atomic RC (thread-safe)                 |
| **Cross-thread sharing** | Not allowed (not Send)       | Allowed (Send when all fields are Send) |
| **Cycle collection**     | Yes (stop-the-world GC)      | No (purely atomic RC)                   |
| **Example**              | `ArrayList`, `HashMap`       | `Arc(T)`, `Mutex(T)`, `Channel(T)`      |

```rust
// Regular object — thread-local only
local_data := MyList.new();

// Atomic object — can be sent across threads
shared_counter := AtomicBool(false);
Thread.spawn((io) => {
  shared_counter.store(true, MemoryOrder.Release);
});
```

## Atomic Field Mutation is Forbidden in Safe Code

Direct writes to fields of an `atomic object` are **compile-time errors** in safe code:

```rust
a := arc(i32(0));
a.* = i32(5);  // ERROR: cannot write to atomic object field
```

This prevents the most common data-race vector — two threads writing to the same memory without synchronization. To mutate shared state, compose with the right primitive:

| Want to...                          | Use                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Share an atomic counter             | `Arc(AtomicI32)` → `counter.fetch_add(i32(1), ...)`   |
| Share locked mutable data           | `Arc(Mutex(T))` → `arc.with_lock((v) => { ... })`     |
| Share many-reader / one-writer data | `Arc(RwLock(T))` → `arc.with_read` / `arc.with_write` |
| Share immutable config              | `Arc(T)` (read-only after construction)               |

Pragma'd code (files with `pragma(Pragma.AllowUnsafe)`) bypasses this rule — that's how `std/sync/` primitives mutate their internal state after acquiring locks.

## Atomic Wrappers and MemoryOrder

`std/sync/atomic.yo` provides high-level atomic wrappers built on C11 `<stdatomic.h>`:

| Type                                                 | C backing                                                          | Use case                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| `AtomicBool`                                         | `atomic_bool`                                                      | Boolean flags (closed, done, ready) |
| `AtomicI8` / `AtomicI16` / `AtomicI32` / `AtomicI64` | `atomic_schar` / `atomic_short` / `atomic_int` / `atomic_llong`    | Signed integer counters             |
| `AtomicU8` / `AtomicU16` / `AtomicU32` / `AtomicU64` | `atomic_uchar` / `atomic_ushort` / `atomic_uint` / `atomic_ullong` | Unsigned integer counters           |
| `AtomicUsize`                                        | `atomic_size_t`                                                    | Collection sizes, indices           |
| `AtomicIsize`                                        | `atomic_ptrdiff_t`                                                 | Signed indices, offsets             |

Each wrapper exposes `load`, `store`, `swap`, `compare_exchange`, plus `fetch_add`/`fetch_sub` on integer types. Every operation takes an explicit `MemoryOrder`:

```rust
{ AtomicBool, AtomicI32, MemoryOrder } :: import("std/sync/atomic");

flag := AtomicBool(false);
flag.store(true, MemoryOrder.Release);
if(flag.load(MemoryOrder.Acquire), {
  println("flag is set!");
});

counter := AtomicI32(i32(0));
counter.fetch_add(i32(1), MemoryOrder.Relaxed);
println(`count = ${counter.load(MemoryOrder.Acquire)}`);
```

`MemoryOrder` enum: `Relaxed`, `Consume`, `Acquire`, `Release`, `AcqRel`, `SeqCst`.

Each operation requires an **explicit** memory order — there is no default `SeqCst` to avoid accidental performance cost.

## Mutex(T) — Closure-Scoped Locking

`Mutex(T)` wraps protected data inside the lock. Access is granted through a closure:

```rust
{ Mutex } :: import("std/sync/mutex");

counter := Mutex(i32).new(i32(0));

// Thread-safe mutation via with_lock
counter.with_lock((v) => {
  v = (v + i32(1));
});

// Return values propagate through with_lock
new_value := counter.with_lock((v) => (v + i32(1)));
```

The closure receives `inout(v) : T` — a **second-class reference** that:

- Can read and write through `v`
- Cannot be stored in a struct field
- Cannot be returned from the closure
- Cannot be captured by a `Send` closure

This is structurally guaranteed by the compiler, so the lock window cannot escape the closure scope. There is no user-visible guard type or lifetime to manage.

Unlock is automatic — a private unlocker object calls `_raw_unlock()` on both normal return and `unwind(...)`, guaranteeing structured unlock pairing.

**Re-entrant locking deadlocks.** Calling `with_lock` from inside another `with_lock` on the same mutex will deadlock (matching Rust's `std::sync::Mutex`). Yo does not provide a reentrant mutex.

## Negative Impls — Opting Out of Send

A type that would auto-derive `Send` can explicitly opt out with `!(Send)`:

```rust
impl(MyHandle, !(Send()));   // MyHandle is NOT Send, regardless of fields
```

This is used by the standard library for:

- **`JoinHandle(T)`** — the async task handle lives on the spawner's event-loop thread
- **`Io`** — the async runtime is per-thread

Negative impls do **not** require `pragma(Pragma.AllowUnsafe)` — they are restrictive (removing a capability), never permissive. Anyone can declare `impl(MyType, !(Send()))` freely.

## Iso(T) — Unique Ownership Transfer

`Iso(T)` wraps a value for unique, one-shot transfer across threads. Unlike `Send` types (which can be shared freely), `Iso(T)` guarantees **at most one thread** observes the inner value at extraction time via a runtime `rc == 1` check.

```rust
data := Box(MyData).new(...);
iso := ^(data);   // '^' macro — wraps value in Iso

Thread.spawn((io) => {
  // extract() returns the inner value directly,
  // panicking if rc != 1 or already extracted
  inner := iso.extract();
  // ... use inner ...
});
```

`Iso(T)` is **unconditionally Send** — it does not require `T <: Send`. This is safe because `extract()` atomically verifies `rc == 1`, ensuring at most one thread observes `T` at a time.

- `Iso(Arc(T))` is rejected at compile time — redundant (send the Arc directly)
- `Arc(Iso(T))` is rejected at compile time — contradictory (Arc shares, Iso is unique)

## Field Visibility — `_`-Prefix Convention

Fields whose names start with `_` are private to the **file and directory** that defines the containing type:

```rust
// In std/sync/mutex.yo:
Mutex :: atomic(ref(struct(_handle : __YO_THREAD_SYNC_TYPE, _value : T)));
```

User code **cannot** access `mutex._value` or `mutex._handle` — the compiler rejects cross-directory `_`-prefixed field access. This closes the synchronized-interior read hole (reading `mutex._value` without acquiring the lock).

Same-directory access is allowed — `std/sync/` files access each other's `_`-prefixed internals.

Non-`_`-prefixed fields (like `arc.*`, `box.*`) are readable but not writable in safe code (see Atomic Field Mutation above).

## Trust Boundary

| Layer                      | What's Trusted                                 | What's Enforced                                                                                                                                      |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User code** (no pragma)  | Nothing                                        | All cross-thread sharing goes through `std/sync/` primitives. Manual Send impls rejected. Atomic-object writes rejected. Non-Send captures rejected. |
| **`std/sync/`** (pragma'd) | Primitive bodies implement contracts correctly | Manual Send impls require `// SAFETY:` comments. Phase F re-verifies atomic-object field Send-ness.                                                  |
| **Codegen runtime**        | Atomic RC ops use correct memory ordering      | C11 `atomic_fetch_add_explicit(..., relaxed)` for increment, `atomic_fetch_sub_explicit(..., acq_rel)` for decrement.                                |
| **`extern("c", ...)`**     | C functions are reentrant-safe                 | Out of scope — same audit boundary as the memory-safety pass.                                                                                        |

## What's Not Covered (Yet)

- **Deadlock prevention** — same as Rust. Lock ordering is the user's responsibility.
- **`Sync` trait** — cross-thread shared references. Deferred; cross-thread sharing always goes through `Arc + Mutex / Atomic / Channel`.
- **`AtomicPtr(T)`** — generic atomic pointer for lock-free data structures. Deferred since safe code cannot construct or deref raw pointers, so the primitive would only be usable from pragma'd code. Will be added when a concrete `std/` consumer surfaces.
- **`Sender(T)` / `Receiver(T)` split** — currently `Channel(T)` exposes both send and receive ends on the same handle. Rust-style split halves are a future ergonomic refinement.
- **TSan empirical validation on CI** — `--sanitize thread` is plumbed and the Linux/Clang CI job runs `./yo-cli test ./tests/sync`. The job is informational (`continue-on-error: true`) until we have a first green Linux run; the codegen pin tests in `src/tests/thread-safety-codegen.test.ts` are the primary regression guard today.

## See Also

- `plans/THREAD_SAFETY.md` — full design document with 27-vector inventory and phase breakdown
- `docs/en-US/PARALLELISM.md` — Thread, Worker, and Channel API
- `docs/en-US/ISOLATED.md` — `Iso(T)` design details
- `docs/en-US/MEMORY_SAFETY.md` — memory safety pass
