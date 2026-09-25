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
Thread(unit).spawn(io => {
  shared_counter.store(true, MemoryOrder.Release);
});
```

## Atomic Field Mutation is Forbidden in Safe Code

Writes through an `atomic object` are **compile-time errors** in safe code — field and index
assignment, and any `inout` route into it (an `inout` argument, or a method whose `self` is
`inout(self)`) whose callee may write through that parameter:

```rust
a := arc(i32(0));
a.* = i32(5);          // ERROR: cannot write to atomic object field
c := arc(Counter(n : i32(0)));
c.*.bump();            // ERROR: cannot call an inout(self) method on atomic object 'c'
bump_by_ten(c.*);      // ERROR: cannot pass an inout argument rooted in atomic object 'c'
```

A local copy is a value, so `k := c.*; k.bump()` is fine (it mutates the copy);
`Mutex.with_lock`'s `inout(v)` is a parameter, so the body may write through `v`; and a
read-only `inout(self)` method — `ToString`'s `${c.*.n}`, `Sender.clone` — is fine, because the
compiler decides by what the callee's body does (`plans/reference/PARALLELISM_RULES.md` D3), not
by the parameter mode alone.

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

Every wrapper exposes `load`, `store`, `swap` and `compare_exchange`. Every
**integer** wrapper additionally exposes the full read-modify-write family —
`fetch_add`, `fetch_sub`, `fetch_and`, `fetch_or`, `fetch_xor`, `fetch_min`,
`fetch_max` — each returning the value held *before* the operation and
wrapping on overflow, exactly like C11 `atomic_fetch_*`. `AtomicBool` has none
of them: it is not an integer atomic.

Every method takes `self : Self`, the same receiver convention the rest of
`std/sync` uses for `atomic(ref(...))` types; only `compare_exchange`'s
`expected` is `inout`, because a failing exchange writes the observed value
back into it. Every operation takes an explicit `MemoryOrder`:

```rust
{ AtomicBool, AtomicI32, AtomicU32, AtomicUsize, MemoryOrder } :: import("std/sync/atomic");

flag := AtomicBool(false);
flag.store(true, MemoryOrder.Release);
if(flag.load(MemoryOrder.Acquire), {
  println("flag is set!");
});

counter := AtomicI32(i32(0));
counter.fetch_add(i32(1), MemoryOrder.Relaxed);
println(`count = ${counter.load(MemoryOrder.Acquire)}`);

// The whole read-modify-write family, on every integer atomic:
bits := AtomicU32(u32(0));
bits.fetch_or(u32(4), MemoryOrder.AcqRel); // set a bit
bits.fetch_and(u32(4294967291), MemoryOrder.AcqRel); // clear it again
bits.fetch_xor(u32(1), MemoryOrder.AcqRel); // flip a bit
high_water := AtomicUsize(usize(0));
high_water.fetch_max(usize(512), MemoryOrder.AcqRel);
```

`MemoryOrder` enum: `Relaxed`, `Acquire`, `Release`, `AcqRel`, `SeqCst`.

There is no `Consume`. C11 has it, but every production compiler promotes it
to `Acquire`, so the name promised a weaker barrier than any target actually
emits; Rust omits it for the same reason. Use `Acquire`.

An order that the operation cannot legally take — `Release` on a load,
`Acquire` on a store, `AcqRel` on either — panics rather than being silently
reinterpreted.

Each operation requires an **explicit** memory order — there is no default
`SeqCst` to avoid accidental performance cost.

`fence(order)` is also exported. It lowers to C11 `atomic_thread_fence`: where
an atomic operation's own ordering constrains accesses around *that* object, a
fence constrains every prior and subsequent memory access of the calling
thread, which is what lets a `Relaxed` store on one thread pair with a
`Relaxed` load on another.

`AtomicI32` lowers `fetch_add`/`sub`/`and`/`or`/`xor` straight to the C11
`atomic_fetch_*_explicit` generic macros — it is the only atomic type
`std/libc/stdatomic.yo` binds them for, since a `c_include` binding is keyed by
C symbol name and each macro has exactly one Yo binding. Every other type, and
`fetch_min`/`fetch_max` on all of them (C11 has no atomic min/max at all), runs
a strong compare-exchange loop over that type's
`__yo_atomic_compare_exchange_*` primitive. The loop is lock-free and yields
the same value and the same wrapping semantics; it only costs a retry under
contention.

## Mutex(T) — Closure-Scoped Locking

Every lock in `std/sync` records its holder, so misuse is a **panic** with a message naming the
API, on every platform, never the OS primitive's undefined behaviour: locking a mutex again from
the thread that holds it, unlocking from another thread, `Cond.wait_with(m)` without holding `m`,
and a `Once` initializer that re-enters its own `Once` all trap (rule D5 of
`plans/reference/PARALLELISM_RULES.md`). `try_with_lock` answers `.None` for the holder on
Windows too, where the underlying `CRITICAL_SECTION` would have recursed.

`Mutex(T)` wraps protected data inside the lock. Access is granted through a closure:

```rust
{ Mutex } :: import("std/sync/mutex");

counter := Mutex(i32).new(i32(0));

// Thread-safe mutation via with_lock
counter.with_lock(v => {
  v = (v + i32(1));
});

// Return values propagate through with_lock
new_value := counter.with_lock(v => (v + i32(1)));
```

The closure receives `inout(v) : T` — a **second-class reference** that:

- Can read and write through `v`
- Cannot be stored in a struct field
- Cannot be returned from the closure
- Cannot be captured by a `Send` closure

This is structurally guaranteed by the compiler, so the lock window cannot escape the closure scope. There is no user-visible guard type or lifetime to manage.

Unlock is automatic — a private unlocker object calls `_raw_unlock()` on both normal return and `unwind(...)`, guaranteeing structured unlock pairing.

**Re-entrant locking deadlocks.** Calling `with_lock` from inside another `with_lock` on the same mutex will deadlock (matching Rust's `std::sync::Mutex`). Yo does not provide a reentrant mutex.

## Module-Level Globals

A module-level runtime binding (`name := init` or `(name : T) = init` outside any function) is
one static that every thread shares. In safe code:

- a closure that runs on another thread (a `Thread.spawn` body, a pool task, a
  `spawn_blocking` callback — anything bound to `Impl(Fn(...), Send)`) may not reach a global
  whose type is not `Send`, directly or through any function it calls. A non-atomic
  reference-counted global (`ArrayList`, `String`, any `ref(struct)`) stays legal for the main
  thread, but reading a field through such a handle updates a reference count, so no other
  thread may touch it;
- a `Send` value global (a scalar or a struct with no reference inside) that is WRITTEN
  anywhere — assigned, the root of a field or index store, or handed to an `inout` parameter
  whose callee writes through it — is a mutable static, and a closure that runs on another
  thread may not reach it. Written and read on one thread only, it is an ordinary global; read
  from every thread and never written, it is a shared constant. The error lands on whichever
  of the two sites the compiler sees second and names the other.

```rust
LIMIT :: i32(5);                              // a constant: fine from any thread
hits := AtomicI32(i32(0));                    // an atomic object: shared state, fine
(thread_local(scratch) : i32) = i32(0);       // per-thread mutable state: fine
g := ArrayList(i32).new();                    // fine on the main thread only
fill :: (fn() -> unit)({ g.push(i32(1)); });
Thread(unit).spawn(io => { fill(); });        // ERROR: the closure calls fill, which reaches g
(counter : i32) = i32(0);
bump :: (fn() -> unit)({ counter = (counter + i32(1)); });   // fine on its own...
Thread(i32).spawn(io => counter);             // ERROR: ...but another thread reads counter
```

## Functions and Closures Across Threads

A function value is `Send` when **what it captures** is `Send` and **what its code reaches**
obeys the global rules above. Its type cannot answer this: two functions of one signature share
the type, and a closure that captures nothing still runs code. So the compiler judges the value
wherever it can see it:

- **Spawn and task bodies.** A closure literal written straight into a `Send` slot (a
  `Thread.spawn` body, a pool task, a `spawn_blocking` callback) is checked where it is
  written.
- **Function values passed in.** A named function or a closure passed to an
  `Impl(Fn(...), Send)` parameter is judged at the call.
- **Generic bounds.** A function bound to a `where(T <: Send)` parameter is judged too:
  `arc(f)`, `Channel(typeof(f))`, a generic `g(f)`.
- **Captured functions.** A closure captured by another thread's closure is judged by the
  captured value.

A bare `fn(...)` type whose value the compiler cannot see is **not `Send`**: a struct field, a
collection element, a `Channel(fn() -> unit)` payload, or a plain local `f := count` captured by
another thread's closure. `Impl(Fn(...), Send)` is the function type that carries the promise:
write `(f : Impl(Fn(Io) -> unit, Send)) = count`. A value is checked once, where it is
converted into that type (an argument, a return, a declared binding).

```rust
g := ArrayList(i32).new();                          // main thread only
hits := AtomicI32(i32(0));
fill :: (fn(io : Io) -> unit)({ g.push(i32(1)); });
count :: (fn(io : Io) -> unit)({ hits.fetch_add(i32(1), MemoryOrder.AcqRel); ();});
Thread(unit).spawn(count);                          // fine: count reaches only an atomic
Thread(unit).spawn(fill);                           // ERROR: fill's code reaches g
(k : Impl(Fn() -> unit)) = (() => { g.push(i32(2)); });
a := arc(k);                                        // ERROR: k's code reaches g
Holder :: struct(f : (fn(io : Io) -> unit));
h := Holder(f : count);
Thread(unit).spawn((io : Io) => { (h.f)(io); });    // ERROR: Holder has a bare fn field
```

## Negative Impls — Opting Out of Send

A type that would auto-derive `Send` can explicitly opt out with `!(Send)`:

```rust
impl(MyHandle, !Send()); // MyHandle is NOT Send, regardless of fields
```

This is used by the standard library for:

- **`JoinHandle(T)`** — the async task handle lives on the spawner's event-loop thread
- **`Io`** — the async runtime is per-thread

Negative impls do **not** require `pragma(Pragma.AllowUnsafe)` — they are restrictive (removing a capability), never permissive. Anyone can declare `impl(MyType, !(Send()))` freely.

## Iso(T) — Unique Ownership Transfer

`Iso(T)` wraps a non-`Send` value for one-shot transfer to another thread: `T` can be a plain
`ref(struct)` graph, and `Iso(T)` itself is `Send` without requiring `T <: Send`. The argument
for that is uniqueness — at the moment of use, at most one thread holds the inner value.

```rust
data := box(MyData(...));
match(
  ^data,                        // '^' constructs the Iso; .None if `data` is not unique
  .Some(iso) => Thread(unit).spawn(io => {
    inner := iso.extract();     // returns T; panics on a second extract
    // ... use inner on this thread only ...
  }),
  .None => ()
);
```

**What is enforced** (`plans/reference/PARALLELISM_RULES.md` D2). `^v` is the only constructor in
safe code (the raw `Iso(T)(v)` needs the pragma). It checks at compile time that `v` owns its
value, has no other alias and cannot form a reference cycle, and at run time walks the value's
whole graph: every non-atomic object reachable from it must have a reference count of exactly
1, or `^v` answers `.None` — an aliased interior (`Wrap(items : shared)`) is refused, not moved.
An atomic object inside the value is shared by design and stops the walk. `T` must be a
non-atomic reference object (`Iso(i32)` is a compile error). `extract()`'s atomic one-shot flag
hands the value out exactly once. Details: `docs/en-US/ISOLATED.md`.

- `Iso(Arc(T))`, `Iso(<atomic object>)` and `Iso(Iso(T))` are rejected at compile time — redundant (send the value directly)
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
| **User code** (no pragma)  | Nothing                                        | All cross-thread sharing goes through `std/sync/` primitives. Manual Send impls rejected. Atomic-object writes rejected (field and index assignment, `inout` arguments, `inout(self)` receivers). Non-Send captures rejected. A function value crossing threads is judged by what it captures and what its code reaches (D4, D9); a bare `fn` field or payload is not Send. |
| **`std/sync/`** (pragma'd) | Primitive bodies implement contracts correctly | Manual Send impls require `// SAFETY:` comments. Phase F re-verifies atomic-object field Send-ness.                                                  |
| **Codegen runtime**        | Atomic RC ops use correct memory ordering      | C11 `atomic_fetch_add_explicit(..., relaxed)` for increment, `atomic_fetch_sub_explicit(..., acq_rel)` for decrement.                                |
| **`extern("c", ...)`**     | C functions are reentrant-safe                 | Out of scope — same audit boundary as the memory-safety pass.                                                                                        |

## What's Not Covered (Yet)

- **Deadlock prevention** — same as Rust. Lock ordering is the user's responsibility.
- **`Sync` trait** — cross-thread shared references. Deferred; cross-thread sharing always goes through `Arc + Mutex / Atomic / Channel`.
- **`AtomicPtr(T)`** — generic atomic pointer for lock-free data structures. Deferred since safe code cannot construct or deref raw pointers, so the primitive would only be usable from pragma'd code. Will be added when a concrete `std/` consumer surfaces.
- **`Sender(T)` / `Receiver(T)` split** — currently `Channel(T)` exposes both send and receive ends on the same handle. Rust-style split halves are a future ergonomic refinement.
- **TSan covers the thread corpus, not every program.** The Linux/Clang CI job (a required status check) runs `tests/sync` and, through `scripts/tsan-thread-corpus.sh`, the thread corpus under `--sanitize thread`: `tests/thread*.test.yo`, `arc`, `atomic_object`, `iso*`, `cross_thread_wake`, `spawn_blocking`, `imm_threading`, `parallelism_soundness`, `encoding/html`, `unsafe_cast_rc_borrow`. Each file must spawn at least one thread (a file that spawns none is reported HOLLOW), and a both-ways ratchet (`scripts/bootstrap/tsan-known-failing.tsv`) fails the job when an unlisted file reports a race or a listed one stops reporting one. The compile-time rules are pinned by `tests/thread_safety.test.yo` and `tests/parallelism_soundness.test.yo`, which carries one rejection block and one over-rejection canary per rule.

## Known Holes

None known. The 2026-09-25 parallelism-soundness audit measured eleven violations of the
guarantee above. All of them are closed (`plans/archive/PARALLELISM_SOUNDNESS.md`), as is the
function-value route found while closing it (rule D9). A violation found later is filed under
`issues/` and listed here until it is fixed.

## See Also

- `plans/reference/PARALLELISM_RULES.md` — the rules (D1–D9) the compiler enforces
- `plans/archive/PARALLELISM_SOUNDNESS.md` — the 2026-09-25 audit and its fix plan (closed)
- `plans/archive/THREAD_SAFETY.md` — the original design document with its 27-vector inventory (see its correction banner)
- `docs/en-US/PARALLELISM.md` — Thread, ThreadPool, and Channel API
- `docs/en-US/ISOLATED.md` — `Iso(T)` design details
- `docs/en-US/MEMORY_SAFETY.md` — memory safety pass
