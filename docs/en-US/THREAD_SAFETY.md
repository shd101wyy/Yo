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

**What is enforced today (2026-09-25).** `^v` checks at compile time that `v` owns its value,
has no other alias and cannot form a reference cycle, and at run time calls
`Isolation.can_isolate` (`rc == 1` on the wrapper) — which only `Box(T)` implements. The raw
constructor `Iso(T)(v)` runs the compile-time checks for a named variable and nothing for a
literal argument; `extract()` checks a one-shot flag and does NOT check any reference count.
Nothing looks inside the value: an aliased interior (`Wrap(items : shared)`) crosses threads.

**What is being changed** (`plans/reference/PARALLELISM_RULES.md` D2): `^` becomes the only
constructor in safe code, `T` must contain a reference type, uniqueness is checked DEEPLY at
construction, and `extract()` gains the wrapper `rc == 1` check. Until that lands, treat `Iso`
as safe only for a value you built yourself and never aliased — see
`issues/iso-constructor-is-unchecked-and-extract-verifies-no-uniqueness.md`.

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
| **User code** (no pragma)  | Nothing                                        | All cross-thread sharing goes through `std/sync/` primitives. Manual Send impls rejected. Atomic-object writes rejected (field and index assignment, `inout` arguments, `inout(self)` receivers). Non-Send captures rejected. |
| **`std/sync/`** (pragma'd) | Primitive bodies implement contracts correctly | Manual Send impls require `// SAFETY:` comments. Phase F re-verifies atomic-object field Send-ness.                                                  |
| **Codegen runtime**        | Atomic RC ops use correct memory ordering      | C11 `atomic_fetch_add_explicit(..., relaxed)` for increment, `atomic_fetch_sub_explicit(..., acq_rel)` for decrement.                                |
| **`extern("c", ...)`**     | C functions are reentrant-safe                 | Out of scope — same audit boundary as the memory-safety pass.                                                                                        |

## What's Not Covered (Yet)

- **Deadlock prevention** — same as Rust. Lock ordering is the user's responsibility.
- **`Sync` trait** — cross-thread shared references. Deferred; cross-thread sharing always goes through `Arc + Mutex / Atomic / Channel`.
- **`AtomicPtr(T)`** — generic atomic pointer for lock-free data structures. Deferred since safe code cannot construct or deref raw pointers, so the primitive would only be usable from pragma'd code. Will be added when a concrete `std/` consumer surfaces.
- **`Sender(T)` / `Receiver(T)` split** — currently `Channel(T)` exposes both send and receive ends on the same handle. Rust-style split halves are a future ergonomic refinement.
- **TSan empirical validation on CI** — `--sanitize thread` is plumbed and the Linux/Clang CI job runs `yo test ./tests/sync`. The job GATES pull requests — it is one of the required status checks (it was informational until 2026-08-06). The primary regression guard today is `tests/thread_safety.test.yo`, which pins the Send/atomic-field/negative-impl/field-visibility rules in Yo itself, plus the `tests/sync/` suite the TSan job runs; the old codegen pin tests (`src/tests/thread-safety-codegen.test.ts`) were retired with the TypeScript compiler tree and have no self-hosted successor.

## Known Holes (2026-09-25 audit)

The guarantee at the top of this page is the contract; the parallelism-soundness audit
(`plans/PARALLELISM_SOUNDNESS.md`) measured these violations of it on the current compiler, and
each is being closed by the phase named there. Until a bullet is removed, safe code CAN write
the race it describes.

- **`Iso(T)` uniqueness is shallow and the constructor is unchecked** (section above).
- **Module-level globals are shared statics** with no `Send` check
  (`issues/module-globals-bypass-send-so-safe-code-can-data-race.md`); inside std,
  `html_decode`'s tables race on read
  (`issues/std-html-entity-tables-are-non-atomic-globals-read-from-every-thread.md`).
- **A closure type satisfies `where(T <: Send)`** regardless of its captures, so `arc(f)` and
  `Channel(typeof(f))` pass `yo check` with a non-Send capture (the C compiler rejects the
  program today by accident)
  (`issues/a-capturing-closure-type-satisfies-a-send-bound-so-arc-and-channel-accept-it-at-check.md`).
- **A closure may capture a `with_lock` body's `inout(v)`** at `yo check` (codegen fails)
  (`issues/a-closure-capturing-an-inout-lock-body-parameter-passes-check.md`).
- **Runtime races** that no user rule can avoid: the cross-thread `Waker` release ordering on a
  spawned thread's loop, the non-atomic `borrow_count` on atomic objects, `rc()` on an `Iso`
  handle, and Windows/macOS-specific runtime state — listed in `plans/PARALLELISM_SOUNDNESS.md`
  §3 (P-11 to P-25).
- **A safe file can call raw runtime externs** imported from `std/sys/externs.yo`
  (`issues/safe-code-reaches-pragmad-runtime-externs-through-std-sys-externs.md`).

## See Also

- `plans/reference/PARALLELISM_RULES.md` — the rules (D1–D8) the compiler enforces or is being brought to
- `plans/PARALLELISM_SOUNDNESS.md` — the 2026-09-25 audit and its fix plan
- `plans/archive/THREAD_SAFETY.md` — the original design document with its 27-vector inventory (see its correction banner)
- `docs/en-US/PARALLELISM.md` — Thread, ThreadPool, and Channel API
- `docs/en-US/ISOLATED.md` — `Iso(T)` design details
- `docs/en-US/MEMORY_SAFETY.md` — memory safety pass
