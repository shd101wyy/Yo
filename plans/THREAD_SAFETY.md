# Thread Safety by Default

**Status:** 13 of 14 phases implemented. **Phase P (field visibility) NEVER
LANDED** — `_`-prefixed fields are file-private by CONVENTION ONLY, verified
2026-08-25: a file outside `std/sync` reads `mutex._value` and `yo check` passes
(issues/thread-safety-phase-p-never-landed-but-plan-says-complete.md, with a
reproducer). This document previously said "Complete. All 14 phases
implemented", and vector 27 below is still marked closed BY Phase P — it is
open.
**Companion to:** `plans/MEMORY_SAFETY.md`.
**Decided so far:**

- Phase A approach: **A2** — manual `impl(T, Send())` requires `pragma(Pragma.AllowUnsafe)`.
- Phase B scope: **B1** — `ref(T)` stays second-class, never crosses a thread boundary. No `Sync` trait, no shared `&T` for v1.
- Phase I syntax: **existing `Dyn(Trait1, Trait2, ...)` form**, e.g. `Dyn(MyTrait, Send)` — no new syntax needed.
- Phase D shape: **closure-scoped lock APIs**, e.g. `mutex.with_lock((v) => {...})`. No user-visible guard type. The `ref(v) : T` parameter is second-class so the borrow can't escape; the private unlocker's `Drop` handles normal-and-unwind unlock.
- Channel error model: **only "channel closed" (and "buffer full" for bounded `try_send`) flow through the `Result`. OOM panics** via the existing allocator contract, same as every other std/ heap-using primitive.
- `Iso` / `Arc` composition: **ban direct `Iso(Arc(T))` and `Arc(Iso(T))`** (the former is redundant with naked Arc + move-on-spawn; the latter is contradictory — Arc means shared, Iso means unique). Transitive nesting through a user struct stays legal.
- Phase C atomic wrapping: **`atomic object((*) : atomic_int)` using libc's existing atomic types** — no new `atomic T` field modifier. Only the existing `atomic object` form is used.
- Mutex re-entrant lock: **deadlock + doc warning**, matching Rust's `std::sync::Mutex`. No thread-id check, no recursion counter.
- Async cross-thread bound: **`Impl(Future(T, E))` is NOT Send and `JoinHandle(T)` is NOT Send.** Yo's async/await is single-threaded; both stay thread-pinned. Cross-thread result delivery uses `Channel(T)`. Non-Send is enforced via the new negative-impl syntax (Phase N).
- Negative trait impls: **new `impl(T, !(Trait))` syntax** (Phase N) for opting a type out of an auto-derived marker trait. Used to keep `JoinHandle(T)` and `Io` non-Send without changing their representation. No pragma gate — negative impls are restrictive, not permissive.
- Atomic-object field writes: **forbidden in safe code** (Phase O) — a new structural rule, uniform across all field names (no `(*)` carve-out). `arc.* = ...`, `myarc._inner = ...`, `arc.field.subfield = ...`, and passing such an expression as `ref(T)` / `inout` are all rejected. Reads stay allowed at the Phase O layer; the synchronized-interior read concern is closed separately by Phase P (field visibility). Mutation requires composition with `AtomicX` / `Mutex(T)` / `RwLock(T)`. The rule is purely lexical (checks the root of the LHS / argument expression). Pragma'd code bypasses.
- Field visibility: **`_`-prefix is file-private** (Phase P) — a general language rule, not specific to thread safety. A field whose name starts with `_` is accessible only within the file that defines its containing type. Promotes the existing `_handle`/`_value`/`_inner`/`_ptr`/`_capacity` convention (already pervasive in `std/`) to enforced privacy. Closes Mutex/RwLock/Once interior-read holes (`mutex._value` racing with `with_lock` writers) and a class of latent encapsulation gaps for non-atomic types too (`string._ptr`, `arraylist._capacity`, etc.). No new keyword, no breaking change for std/ — the convention already matches.
- `Once` fast-path: **closed in Phase D** — the current plain `bool` read of `_done` (`std/sync/once.yo:22, 43`) lacks an acquire-load happens-before edge with the initializer's release-store, so a thread observing `_done == true` on the fast path may not observe side-effects written by the initializer. Phase D switches `_done` to `atomic_bool` with Acquire-load on the fast path and Release-store on completion, restoring the publication edge.
- Phase J **dropped**: drop's thread-portability is safe by design under the current rules (`object` only ever drops on its owning thread; `atomic object` requires all fields to be Send, so the drop body operates only on Send data).
- Phase K **dropped**: no `immutable` modifier in the type system. Immutable data structures (`std/imm/list.yo`, etc.) live in pragma'd files and audit-establish their Acyclic claim through implementation review, the same way `unsafe(...)` audit works today.
- Channel/WaitGroup unsynchronized query methods: **fix in Phase D** — migrate `Channel._closed`/`_len` to `atomic_bool`/`atomic_usize` and `WaitGroup._count` to `atomic_int`, giving query methods lock-free snapshot semantics (matching Rust's `mpsc` idiom). Writers still use the mutex for multi-field ordering; readers use atomic loads.
- Cond × Mutex cross-file access: **`Mutex._raw_handle_ptr()` pragma-only method in Phase D** — returns `*(__YO_THREAD_SYNC_TYPE)` so safe code cannot call it (memory-safety pass rejects `*(T)` expressions), while pragma'd `cond.yo`/`channel.yo`/`rwlock.yo` can. No same-directory visibility exception needed in Phase P.
- No backwards compatibility constraints.

## Goal

Same trust model as the memory-safety pass:

- **User code (no pragma) cannot construct a data race.** Every shared-mutable handoff between threads goes through a primitive whose soundness is audited in std/. Sharing unsynchronized state across threads is a compile error, not a runtime check.
- **Stdlib code (pragma'd) builds the primitives.** The audit surface is the file boundary; `yo unsafe-report` already covers it.
- **Performance parity with Rust.** No atomic-by-default tax on single-threaded data — the compile-time distinction between `object` (thread-local Rc) and `atomic object` (Arc) already exists; we're hardening it.

**Non-goals (this pass):**

- Deadlock prevention (same as Rust).
- A `Sync` trait / cross-thread shared references (deferred; B1 chosen).
- Dynamic ThreadSanitizer integration (TSan already buildable via `--sanitize thread`; goal is that it finds nothing in user code).

## What "data-race-free" means in Yo

A **data race** = two threads access the same memory location, at least one is a write, with no synchronization edge between them. C11 / Rust definitions apply.

**Theorem we want to be able to state:**

> For every program P that compiles without `pragma(Pragma.AllowUnsafe)` and uses only primitives from `std/`, every shared cross-thread mutable access in P is mediated by a synchronization primitive in `std/sync/`. P is therefore data-race-free under the C11 memory model.

**Important correction vs an earlier draft:** `Send` is **not** a move. `Thread.spawn` / `Worker.spawn` / `Channel.send` all take their payload by-value (e.g. `cb : Impl(Fn(io : Io) -> unit, Send)`, no `own()`), which means the closure's capture struct is _duped_ — both sender and receiver hold an Rc to the same heap value. Uniqueness is only enforced where we explicitly opt into it: `Iso(T).extract()` checks `rc == 1` at runtime (atomic load on an `atomic object`). So the data-race story rests on _shared-ownership_ primitives doing the right thing, not on move semantics.

The induction:

1. **Single-thread base case.** Within one thread, Yo's compile-time Rc forbids aliased mutation (the same machinery that gives memory safety). One mutable owner at a time within a thread ⇒ no intra-thread race.
2. **Cross-thread capture / send.** A captured / sent value always falls into one of three categories, each safe by construction:
   - **(a) Plain value-typed (primitives, structs/enums of primitives).** The closure capture struct _copies_ the value. Sender and receiver have independent copies — they're not the same memory, so no race.
   - **(b) Shared via an Rc-managed synchronization primitive** (`Arc(T)`, `Channel(T)`, `Mutex(T)`, `RwLock(T)`, `Atomic*`). Both sides hold an Rc to the same heap object. The primitive's public API only exposes _synchronized_ reads/writes (mutex lock, atomic op, channel send/recv) — direct field mutation through these types is structurally forbidden in safe code by Phase O. To mutate shared state, the user composes (`Arc(AtomicI32)`, `Arc(Mutex(T))`, etc.), and the inner type's methods do the synchronization. The Rc itself uses atomic increment/decrement (`__yo_incr_rc_atomic` relaxed, `__yo_decr_rc_atomic` acq_rel). ⇒ every access is serialized by the primitive.
   - **(c) Shared as `Iso(T)`, with uniqueness checked at the receiver.** The closure-capture dup still happens (sender keeps its Iso reference until it drops). The receiver calls `Iso(T).extract()`, which atomically loads the Rc and succeeds only if `rc == 1`. If the sender hasn't dropped its reference yet, `extract()` returns `.None` (Phase H tightens this to a panic — see below). ⇒ at the moment of extraction, no other thread can observe the inner T.
3. **No fourth path.** `Send` blocks `object` / `Box(T)` / `Future` / raw `*(T)`-with-non-Send-pointee from being captured into a Send-bounded closure or sent through a channel. Phase B1 keeps `ref(T)` second-class, so a borrow never crosses a thread. Phase I requires `Dyn(Trait + Send)` for cross-thread trait objects. So categories (a/b/c) above are exhaustive.

Soundness collapses to three trusted bases:

- **`std/sync/` primitives are correctly implemented** (audit boundary).
- **The compile-time Rc analysis is sound** (established by the memory-safety pass).
- **The codegen atomic-RC ops use correct C11 memory ordering** (Phase G pins this).

**Caveat on `Iso(T)`.** The runtime `rc == 1` check at `extract()` is the actual enforcement. If the sender forgets to drop its `Iso` reference before the receiver extracts, `extract()` fails — that's safety-preserving (no race), but it's runtime-late, not compile-time-early. The compile-time Rc analysis _can_ often prove uniqueness statically at the construction site, but the cross-thread move boundary is checked dynamically. Plan Phase H tightens the failure mode (panic vs `.None`) and considers whether a stronger compile-time check is feasible.

**Why `Iso(T)` is unconditionally `Send` (no `T <: Send` bound).** Every other shareable type in std/ that crosses a thread (`Arc(T)`, `Channel(T)`, `Mutex(T)`, `RwLock(T)`) carries a `where(T <: Send)` clause. `Iso(T)` does not — the impl at `std/prelude.yo:7503` is `impl(forall(T : Type), Iso(T), Send())` with no `where` clause. This is intentional and safe for the following reason:

> A type is required to be `Send` so that any thread that gets a hold of a value of that type can use it without racing against another thread also using that same value. The whole point of `Iso(T)` is that **at the moment of use (i.e. `extract()`), at most one thread holds a live reference to the inner T.** The runtime `rc == 1` atomic-load check at `extract()` is the gate: if the sending thread still has its `Iso(T)` reference, the receiver's `extract()` panics (post-Phase H) rather than handing out a second pointer to the same T. So the inner T is only ever observed by one thread at a time — non-Send-ness of T cannot cause a race, because the precondition for a race (two threads observing the same T concurrently) is exactly what `Iso` excludes by construction.

This is the same logic behind Rust's `T: Send` being automatically derived for `Box<T> where T: Send` — once you transfer ownership uniquely, the destination thread is the sole observer. `Iso(T)` makes the uniqueness check explicit (`rc == 1`), so the `T <: Send` bound is not needed on top.

### `Iso(T)` design notes — precedent and known risks

`Iso(T)` is not invented from scratch. The closest direct ancestor is **Pony's `iso` reference capability**, which means exactly what `Iso(T)` means: a unique alias safe to send across threads even when the inner type isn't otherwise sendable. Pony has been in production for over a decade; the `iso` pattern is the load-bearing concurrency primitive there. **Project Verona** (Microsoft Research) generalizes the idea to region-based isolation. **Rust** has no direct library-level equivalent — Rust uses move semantics + the borrow checker to enforce uniqueness statically; the closest pattern is `unsafe impl<T> Send for ...` wrapping a non-Send `T`, but Rust offers no audited primitive that wraps this.

Key implementation difference: **Pony enforces uniqueness at compile time via consume tokens; Yo enforces it at runtime via the `rc == 1` check at `extract()`.** Pony's model is more sound but requires a whole reference-capability system; Yo's is lighter but has runtime failure modes. This is a deliberate trade-off — Yo trades static soundness for system-level simplicity, and accepts the resulting discipline burden listed below.

The following risks **are real** and the design accepts them as the cost of avoiding a Pony-style reference-cap system. They are documented here so future contributors understand what they're maintaining:

1. **Hidden API-surface precondition.** The "unconditionally Send" rule has a precondition: `Iso(T)`'s public API must expose **nothing** that touches the inner `T` except `extract()`. The moment anyone adds an `Iso(T)::map(self, f)`, `Iso(T)::peek(self)`, or any method that operates on the inner `T` while `rc > 1`, the safety story collapses — both threads now race on the non-Send `T`. This is a _discipline_ invariant, not a _type-system_ invariant. One careless future PR could break it. Phase H below makes the invariant explicit and adds an audit-gate comment in `std/prelude.yo`.

2. **Runtime-late failure mode.** The `rc == 1` check at `extract()` fires on the receiver, but the bug (sender forgot to drop its handle) is at the sender. By the time `extract()` panics, the thread has been spawned, other work has run, and the failure is far from its cause. Pony catches this at compile time; Yo does not.

3. **Sender-side "drop before receiver extracts" is implicit.** In Pony, `consume` is a syntactically visible token. In Yo, the sender keeps its `Iso` reference and the rc==1 check only succeeds after the sender's reference is dropped (scope exit, explicit re-assign, etc.). Easy footgun: holding the `Iso` in an outer-scope struct that outlives the spawn — then `extract()` perpetually fails. The compile-time RC analysis _can_ see this; Phase H notes a possible follow-up hint.

4. **Narrow use case relative to surface complexity.** Most cross-thread types users encounter will already be `Send`. The non-Send-handoff niche is real (handing off a non-atomic `object` graph one-shot to a worker) but uncommon. We accept the surface cost because the alternatives — make everything `atomic object` from the start, or hand-write `unsafe impl Send` per type — are worse.

**Conclusion:** `Iso(T)` is a pragmatic primitive that fills a real niche by paying a documentation/discipline cost. It is not as elegant as Pony's compile-time `iso`, but it fits Yo's existing infrastructure (`atomic object` + atomic RC) without requiring a reference-capability system. We keep it, and the safeguards in Phase H below are how we contain its sharp edges.

## The data-race vector inventory

Every concrete way user or compiler-emitted code could cause a race, paired with how this plan closes it.

| #   | Vector                                                                                                                  | How closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Move a `Box(T)` / `object(T)` value across `Thread.spawn`                                                               | `Send` bound on the closure's capture struct (already in place). Box and non-atomic `object` are not Send.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | Send a struct with a non-Send field                                                                                     | Auto-derive Send only when _all_ fields are Send (already enforced for `atomic object` at struct-def; **Phase A** extends to all structs).                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | Hand-written `impl(T, Send())` lies about T being Send                                                                  | **Phase A2:** manual Send impls require `pragma(Pragma.AllowUnsafe)`. **Phase F:** post-impl re-verification on `atomic object` rejects the lie at struct-def time.                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | `atomic object` with a non-atomic `object` field                                                                        | Auto-derive rejects (today). Manual Send impl could lie ⇒ closed by F.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | Cross-thread shared `Arc(T)` where T has a non-atomic mutable interior                                                  | `Arc(V)` requires `V <: Send` (today). Send is structural ⇒ T's mutable interior must itself be Send (i.e., `atomic_*` or wrapped in Mutex/RwLock).                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | `Iso(T).extract()` after the Iso has been aliased                                                                       | Compile-time RC check at construction + runtime `can_isolate` (`rc == 1`). **Phase H** tightens the runtime path to panic instead of returning `.None` whenever `rc != 1` at the extract site (i.e., the sender's reference has not yet been dropped).                                                                                                                                                                                                                                                                                    |
| 7   | Capture a `ref(T)` borrow inside a `Thread.spawn` closure                                                               | Already blocked: closures cannot capture ctl-typed _or_ ref-bound values (Phase B of MEMORY_SAFETY). Re-affirmed in **Phase E** with a Send-specific diagnostic.                                                                                                                                                                                                                                                                                                                                                                          |
| 8   | Capture a non-Send local in a `Thread.spawn` closure (current aggregate check is too coarse to identify the offender)   | **Phase E:** per-variable Send check at the capture site, with the diagnostic pointing at the offending capture name.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 9   | Pass a raw `*(T)` whose pointee is non-Send across a thread                                                             | `*(T) <: Send` already requires `T <: Send` (`std/prelude.yo:5478`). Audit confirmed.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 10  | Construct a `*(T)` in safe code that escapes via Send                                                                   | Safe code cannot construct or deref `*(T)` (memory-safety pass). Pragma'd module exporting a `*(T)` field: the field's _type_ leaks into safe scope (Issue 26/27 deferred), but the deref still requires `unsafe(...)`. ⇒ no race-capable use.                                                                                                                                                                                                                                                                                            |
| 11  | `Dyn(Trait)` cross-thread with a non-Send concrete type                                                                 | **Phase I:** use the existing `Dyn(Trait, Send)` multi-trait form. The evaluator already rejects `dyn(value)` when the concrete type doesn't impl every listed trait. Sending a bare `Dyn(Trait)` (no Send in the list) to `Thread.spawn` is rejected by the spawn-API bound.                                                                                                                                                                                                                                                             |
| 12  | Non-atomic increment of `Arc::clone()`                                                                                  | Already correct: `__yo_incr_rc_atomic` emits `atomic_fetch_add_explicit(..., relaxed)`, `__yo_decr_rc_atomic` uses `acq_rel`. Pinned in **Phase G** by a codegen test.                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | Drop of a `T` running on a different thread than construction                                                           | **Safe by design.** A non-atomic `object` only drops on its owning thread (it can't be sent). An `atomic object` is Send only if all its fields are Send, so the drop body operates on Send data; per-thread services it uses are accessed via that thread's own thread-local state. No phase needed.                                                                                                                                                                                                                                     |
| 14  | Drop ordering between Arc's atomic decrement and the final-release destructor                                           | Already correct: `acq_rel` on the decrement establishes the happens-before edge for the destructor. Pinned in **Phase G**.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 15  | Mutex's lock-state escaping the locking thread                                                                          | **Phase D:** lock is exposed only through `with_lock((v) => {...})`. The closure's `ref(v) : T` parameter is second-class — it can't be stored, returned, or captured by another Send closure. Lock state lives inside the private `__MutexUnlocker` local; no user-visible handle to leak.                                                                                                                                                                                                                                               |
| 16  | Manual `unlock()` not paired with `lock()` (no race per se, but unsoundness vector)                                     | **Phase D:** remove public `lock()` / `unlock()`; only `with_lock` exists. The private unlocker's `Drop` fires on both normal scope exit and unwind, so unlock is structurally paired with lock.                                                                                                                                                                                                                                                                                                                                          |
| 17  | `static` mutable state accessed from multiple threads                                                                   | User code cannot declare `static mut`. Compiler-internal statics (e.g., `__yo_argc`) are immutable after init. Per-thread runtime state is `_Thread_local` (`src/codegen/async/runtime-io-*.ts`). Verified.                                                                                                                                                                                                                                                                                                                               |
| 18  | `Atomic*` operations with mismatched memory ordering                                                                    | **Phase C:** typed `MemoryOrder` enum; primitive APIs require an explicit order at each call site (Rust-style, per your direction below).                                                                                                                                                                                                                                                                                                                                                                                                 |
| 19  | Self-referential `atomic object` (e.g. `ListNode(T)`) with mutated tail                                                 | **Audit boundary** (no compile-time marker). The Acyclic claim on a self-referential `atomic object` is established by data-structure implementation review inside a pragma'd file. Phase A2 enforces that the manual `impl(T, Acyclic())` site requires `pragma(Pragma.AllowUnsafe)`; that file's `// SAFETY:` comment documents the immutability invariant.                                                                                                                                                                             |
| 20  | `io.async` Future moved to another thread                                                                               | Today's async runtime is per-thread (per AGENTS.md). **Phase L:** mark `Impl(Future(T, E))` as NOT Send unless the runtime explicitly supports cross-thread futures. Sending a Future to `Thread.spawn` should fail.                                                                                                                                                                                                                                                                                                                      |
| 21  | Iterator chain consumed across threads                                                                                  | Iterators are derived from collections via `.iter()`; the iterator wraps a ref-bound `self`. **Phase E** subsumes — if the iterator captures a `ref` or a non-Send collection, the send fails. Iterators over Send collections that own their state (e.g., `into_iter()`) are themselves Send.                                                                                                                                                                                                                                            |
| 22  | Channel send/receive race on the channel handle itself                                                                  | `Channel(T)` is `atomic object` ⇒ Arc semantics. Multiple producers / consumers share via `arc.clone()`. The handle is Send. The element type is bounded `T <: Send` at channel construction.                                                                                                                                                                                                                                                                                                                                             |
| 23  | Worker pool re-entrancy: a worker spawning into its own pool                                                            | Pool init is idempotent (`__yo_worker_pool_init`). Per-worker mutex + cond protect the queue. No user-visible race. **Phase G** pins with stress tests.                                                                                                                                                                                                                                                                                                                                                                                   |
| 24  | `extern "c"` function called from multiple threads (race in C code)                                                     | Out of user-code scope. Pragma'd `extern("c", ...)` carries the audit burden, same as memory-safety pass. **Phase G** doc note.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 25  | Direct write to a field of an `atomic object` (`arc.* = ...`, `myarc._inner = ...`)                                     | **Phase O (new structural rule).** Yo today allows aliased object-field writes (share-by-reference semantics) — empirically verified: `arc.* = (arc.* + 1)` compiles and races at runtime. Phase O rejects any assignment whose LHS root is a value of `atomic object` type, in safe code. Forces composition with `AtomicX`/`Mutex`/`RwLock`. Pragma'd code bypasses (that's how `std/sync/mutex.yo` mutates internal Mutex state).                                                                                                      |
| 26  | Passing an atomic-object field as `ref(T)` / `inout` to a function (callee writes through it)                           | **Phase O.** Same lexical rule extended to call sites: an argument expression whose root binding has `atomic object` type cannot be passed to a `ref(T)` / `inout` parameter in safe code. (Inside a `with_lock` closure body, the user's `v` parameter has type `ref(T)` whose root is `v`, not an atomic-object binding — so writes through `v` are allowed. The pragma'd primitive vouches that `v` points into a synchronized location.)                                                                                              |
| 27  | **OPEN (2026-08-25)** — Unsynchronized **read** of an atomic-object's interior field (`mutex._value` racing with `with_lock`'s pragma'd writer). Phase P NEVER LANDED, so this row's "closed" verdict below never took effect; `_`-prefix is convention only and a safe user file can read the interior today. See issues/thread-safety-phase-p-never-landed-but-plan-says-complete.md. Original plan: | **Phase P** (field visibility). Closed by promoting `_`-prefix to enforced file-private: `mutex._value` in user code becomes a compile error because the field is defined in `std/sync/mutex.yo`, not the user's file. Pragma-audited Mutex methods (same file) still access `_value` freely after acquiring the lock. This is Yo's structural equivalent of Rust's private `value: UnsafeCell<T>` field on `Mutex<T>`. Phase O (the write rule) is uniform across all field names; Phase P is what closes the _read_ side of the bypass. |

## What's already in place (audit summary)

✅ **Solid:**

- `Send` marker trait, transitively enforced on `atomic object` fields at struct-def time (`src/evaluator/types/struct.ts:128–145`).
- `object` types non-Send by construction (`src/evaluator/trait-checking.ts:61–62, 91–93`).
- `Arc(V)` requires `V <: (Send, Acyclic)` (`std/prelude.yo:7576`).
- `Iso(T)` uniqueness via compile-time RC introspection (`Var.is_owning_the_rc_value`, `Var.has_other_aliases`) + runtime `can_isolate`.
- Atomic RC ops: `__yo_incr_rc_atomic` (relaxed), `__yo_decr_rc_atomic` (acq_rel).
- `Thread.spawn` / `Worker.spawn` / `Channel(T)` all carry `Send` bounds.
- `Mutex`, `RwLock`, `Once`, `Cond`, `WaitGroup` exist; correctly Send via atomic-object backing.
- C11 atomics surface available via `std/libc/stdatomic.yo`.
- `static mut` doesn't exist for user code.
- Per-thread runtime state is `_Thread_local`.
- `*(T) <: Acyclic` is unconditional (`std/prelude.yo:5479`) while `*(T) <: Send` is conditional on `T <: Send` (line 5478). The asymmetry is intentional — raw pointers don't participate in Yo's ARC cycle analysis (verified: `canTypeFormRcCycle` returns false for `Ptr` types), so Acyclic is structurally trivial. Send needs the conditional to avoid sending an `*(NonSendT)` across threads.

⚠️ **Partial** (each entry lists the phase that closes it):

- Manual `impl(T, Send())` in any file passes today with no gate — load-bearing hole. → **Phase A**.
- Mutex/RwLock/Once expose manual `unlock()` — no RAII guard. → **Phase D**.
- Closure-capture Send check is aggregate-only, not per-variable. → **Phase E**.
- `Once` has a missing happens-before edge on its fast-path `_done` read — plain `bool` read without acquire semantics. → **Phase D** (`_done` becomes `atomic_bool` with Acquire-load on fast path, Release-store on write).
- Channel `is_closed()`, `len()`, `is_empty()` read shared mutable state (`_closed`, `_len`) without the mutex. → Fix in Phase D (these are pragma-internal; need explicit synchronization or removal from public API).
- WaitGroup `count()` reads shared mutable state (`_count`) without the mutex. → Same fix as Channel.
- `std/libc/stdatomic.yo` exports C11 atomic types but provides **zero** `impl(atomic_bool, Send())` / `impl(atomic_bool, Acyclic())` declarations. Without these, the `Atomic*` wrappers (Phase C) and the `Once` fast-path fix (`atomic_bool` field, Phase D) cannot compile — `atomic object` auto-derive rejects non-Send fields. → **Phase C** prerequisite sub-task.
- `Arc(T)` / `MyArc(T)` allow `arc.* = value` and `arc.field = value` writes from safe code — empirically verified race vector. → **Phase O**.
- Synchronized-interior fields (`mutex._value`, `arraylist._capacity`, etc.) are accessible from any file by convention only. → **Phase P**.
- `JoinHandle(T)` and `Io` auto-derive `Send` structurally — load-bearing for soundness. → **Phase N** (`!(Send)` syntax) + **Phase L** (apply to both types).

❌ **Gaps** (each entry lists the phase that closes it):

- No high-level `Atomic*` wrappers (raw C11 types only). → **Phase C**.
- `Iso(Arc(T))` / `Arc(Iso(T))` semantics undefined (`plans/ARC_TYPE.md:272`). → **Phase H** (ban both direct compositions).
- `Dyn(Trait)` crossing a thread boundary is unprotected — there's no requirement that the concrete type be Send. → **Phase I** (use existing `Dyn(Trait, Send)` multi-trait form on every cross-thread API surface).
- `Impl(Future(T, E))` Send status undefined; current structural derive would say Send when T, E are. → **Phase L** (`Impl(Trait)` is non-Send unless `, Send` is listed in the bound; document this).
- Self-referential `atomic object` immutability is documented, not enforced. → **Phase A2** audit boundary (manual `impl(T, Acyclic())` requires pragma + `// SAFETY:` comment).
- No formal data-race-freedom statement in user-facing docs. → **Phase M** (`docs/{en-US,zh-CN}/THREAD_SAFETY.md`).

## Phases

Phase letters (A, B, C, …) are stable identifiers, assigned in the order each phase was first sketched during plan iteration — **they do not indicate execution order.** Implementation order, dependencies, and milestones are below.

### Implementation order (execute in this sequence)

| #   | Phase | Title                                                      | Effort   | Prerequisites | Tier             |
| --- | ----- | ---------------------------------------------------------- | -------- | ------------- | ---------------- |
| 1   | **A** | Gate manual `Send`/`Acyclic` impls behind pragma           | 2–3 days | —             | Foundation       |
| 2   | **F** | `atomic object` field re-verification (safety net for A)   | 1 day    | A             | Foundation       |
| 3   | **N** | Negative trait impls (`impl(T, !(Trait))`)                 | 2 days   | —             | Language feature |
| 4   | **L** | `JoinHandle`/`Io` get `!(Send)` impl; Future docs + audit  | 1 day    | N             | Language feature |
| 5   | **P** | `_`-prefix enforced as file-private field visibility       | 1–2 days | —             | Language feature |
| 6   | **O** | Forbid `atomic object` field writes in safe code           | 1–2 days | —             | Language feature |
| 7   | **E** | Per-variable closure-capture Send check                    | 2 days   | —             | Analysis         |
| 8   | **I** | `Dyn(Trait, Send)` cross-thread audit + diagnostic         | 1 day    | —             | Analysis         |
| 9   | **C** | High-level `Atomic*` wrappers (`std/sync/atomic.yo`)       | 3–4 days | P, O          | Library          |
| 10  | **H** | `Iso(T)` runtime tightening + API lockdown + ban Iso/Arc   | 2 days   | A, E          | Library          |
| 11  | **D** | Closure-scoped lock APIs (`with_lock`) + Once fast-path    | 5–7 days | P, O, C       | API rewrite      |
| 12  | **G** | Codegen pin tests + memory ordering audit + TSan CI        | 2–3 days | C, D          | Validation       |
| 13  | **B** | No-op (`ref(T)` stays second-class, no `Sync`)             | 0        | —             | Decision-only    |
| 14  | **M** | Diagnostics + user-facing docs                             | 3–4 days | All prior     | Docs             |
| —   | ~~J~~ | Dropped — drop is safe by design under current rules       | 0        | —             | —                |
| —   | ~~K~~ | Dropped — no `immutable` modifier; audit boundary suffices | 0        | —             | —                |

**Milestone checkpoints** (incremental safety after each):

- **After step 4 (A, F, N, L)**: manual Send claims gated and audit-verified. `JoinHandle`/`Io` properly non-Send. Existing Mutex/RwLock APIs untouched — backwards-compatible improvement.
- **After step 8 (… P, O, E, I)**: all structural / analysis rules in place. User code can no longer construct the obvious data-race vectors (direct atomic-object writes, non-Send captures, Dyn-without-Send across threads). Library still uses the old `Mutex.lock()/unlock()` API.
- **After step 11 (… C, H, D)**: full v1 thread-safety surface. New `Atomic*` wrappers, tightened `Iso`, and `with_lock`-style lock APIs. **Breaking change at this step** — every `mutex.lock(); …; mutex.unlock()` site rewrites.
- **After step 12 (G)**: validated end-to-end with codegen pin tests and TSan on a curated Linux/Clang matrix.
- **After step 14 (M)**: documented and shipped.

**Why this ordering, in short:**

- Foundation first (A, F) — A is the keystone; without it every later rule has an escape hatch. F is the cheap safety belt that catches A2's lies on `atomic object` types.
- Quick structural wins next (N, L, P, O) — each is a small, mostly-independent rule that immediately closes a specific hole. N must precede L (L uses `!(Send)` syntax). P and O are independent of each other and of N/L.
- Analyses (E, I) — extend the closure-capture and Dyn-trait pipelines. Independent of other phases but Phase H later wants E's machinery.
- Library work (C, H) — C builds the `Atomic*` wrappers (consumed by D's `Once` fast-path); H tightens `Iso` and depends on E's per-variable capture walk.
- Major API rewrite (D) — the biggest single chunk. Depends on P (private Mutex fields), O (no direct atomic-object writes), and C (`atomic_bool` for `Once`).
- Validation (G) — runs after the primitives stabilize so the codegen pin tests and TSan matrix have something to pin against.
- Docs (M, B) — final, after the implementation surface stops moving.

Each phase below carries a **Prerequisites:** line restating its dependencies. Letters remain alphabetical in the doc for predictable lookup, but the table above is the order of work.

### Phase A — Gate manual `Send` / `Acyclic` impls behind pragma

**Prerequisites:** none. This is the keystone — start here.

**The keystone change.** Without this, every later phase has an escape hatch.

Rules added to the evaluator:

- `impl(T, Send())` in a non-pragma'd file → compile error: `Manual 'impl(T, Send())' requires pragma(Pragma.AllowUnsafe). Add a '// SAFETY:' comment explaining why T is safe to send across threads.`
- Same for `impl(T, Acyclic())` and (when added) `impl(T, Sync())`.
- Audit-tool integration: `yo unsafe-report` lists every such impl alongside the explanation comment.

**Migration audit (performed during plan finalization):** `grep -rn "impl.*Send()\|impl.*Acyclic()" std/` finds 6 distinct files with manual impls (the rest are primitive integer rows in `std/prelude.yo`). 5 of 6 already have `pragma(Pragma.AllowUnsafe)`:

| File                     | Has pragma?   | Action                                                                                            |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------- |
| `std/prelude.yo`         | Yes (line 70) | Add `// SAFETY:` comments to existing Send/Acyclic impls                                          |
| `std/imm/sorted_map.yo`  | Yes (line 20) | Add `// SAFETY:` comment                                                                          |
| `std/imm/list.yo`        | Yes (line 18) | Add `// SAFETY:` comment                                                                          |
| `std/sync/cond.yo`       | Yes (line 2)  | Add `// SAFETY:` comment                                                                          |
| `std/sync/mutex.yo`      | Yes (line 2)  | Add `// SAFETY:` comment                                                                          |
| **`std/string/rune.yo`** | **No**        | **Add `pragma(Pragma.AllowUnsafe);` + `// SAFETY:` comment for `impl(rune, Send());` at line 96** |

Only one file needs the pragma added. The remaining work is purely the per-impl `// SAFETY:` comment annotations.

Tests: `comptime_expect_error` for every form in `tests/safe_code_structural_gates.test.yo`.

### Phase B — `ref(T)` stays second-class. No `Sync`. No-op for this pass.

**Prerequisites:** none. Decision-only; no code change. Documentation is folded into Phase M.

Documented in `docs/{en-US,zh-CN}/THREAD_SAFETY.md` so users understand the model: cross-thread sharing always goes through Arc + Mutex / Atomic / Channel.

### Phase C — High-level `Atomic*` wrappers (`std/sync/atomic.yo`)

**Prerequisites:** P (so `std/libc/stdatomic.yo`'s `_`-prefixed internals are file-private), O (so user code can't directly write the atomic-object's interior). Library-only; no compiler change.

**Pure library work — no compiler change.** This phase uses two existing pieces only:

1. The existing `atomic object` form (heap cell, atomically-Rc'd handle).
2. The existing libc atomic typedefs (`atomic_int`, `atomic_bool`, `atomic_uint`, `atomic_long`, `atomic_intptr_t`, etc.) re-exported through `std/libc/stdatomic.yo`.

There is **no new `atomic T` field modifier**. We don't extend the type system; we wrap the existing pieces.

The user reaches for an atomic type when they want to share a counter (or flag, or pointer) across threads — that need _requires_ a stable memory address that both threads can reach, which only an atomic-Rc'd heap cell provides. There are two distinct atomic ops at two distinct times:

| Op                                                                                        | When it fires                                                  | Frequency                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------ |
| Atomic Rc inc / dec (the `atomic object` layer)                                           | On capture / alias of the handle and on the last handle's drop | Rare — once per thread handoff |
| Atomic value op (load / store / CAS / fetch*add — operates on the libc `atomic*\*` field) | On every read or write of the counter                          | Frequent — every operation     |

They serve different purposes (one provides shared addressing, the other serializes value access) and you'd need both layers no matter how you spelled the wrapping. The single user-visible wrap level is the `atomic object` itself; the inner `atomic_int` (etc.) does the value-level atomicity.

```rust
MemoryOrder :: enum(Relaxed, Acquire, Release, AcqRel, SeqCst);

// `atomic object` gives the heap-allocated, atomically-Rc'd cell. The
// atomic-object layer is what makes the counter shareable across threads
// (both handles point at the SAME heap cell). The inner field's type is
// libc's `atomic_int` (which is `_Atomic int` at the C ABI) — that's what
// makes load/store/CAS race-free on the inner integer at that one address.
//
// The `(*)` field name is Yo's "deref" notation (same as `Box`, `Arc`,
// `Iso`) — it lets the type constructor take a positional argument of
// the field type.
//
// Send and Acyclic are auto-derived: `atomic_int` is Send (its C-typedef
// surface is Send via the libc binding's manual impls in std/libc/), and
// `atomic object` is Send when all its fields are Send, so
// `atomic object((*) : atomic_int)` inherits both transitively through
// the usual auto-derive path. NO manual `impl(AtomicI32, Send())` — the
// auto-derive already covers it.
AtomicI32 :: atomic object((*) : atomic_int);

impl(
  AtomicI32,
  load : (fn(ref(self) : Self, order : MemoryOrder) -> i32)(...),
  store : (fn(ref(self) : Self, value : i32, order : MemoryOrder) -> unit)(...),
  fetch_add : (fn(ref(self) : Self, value : i32, order : MemoryOrder) -> i32)(...),
  fetch_sub : (fn(ref(self) : Self, value : i32, order : MemoryOrder) -> i32)(...),
  compare_exchange : (
    fn(
      ref(self) : Self,
      expected : i32,
      new_value : i32,
      success_order : MemoryOrder,
      failure_order : MemoryOrder
    ) -> Result(i32, i32)
  )(...),
  swap : (fn(ref(self) : Self, value : i32, order : MemoryOrder) -> i32)(...),
);
```

**Direct construction, no `Arc` wrap, no top-level builder, no `.new(...)`, no explicit `.clone()`:**

```rust
counter := AtomicI32(i32(0));

Thread.spawn((io : Io) => {
  // Capturing `counter` here triggers the compile-time RC analysis to
  // emit an atomic dup of the handle into the closure's capture struct.
  // Both threads end up with handles to the SAME heap atomic_int.
  counter.fetch_add(i32(1), MemoryOrder.Relaxed);
});
counter.fetch_add(i32(2), MemoryOrder.Relaxed);
// Final value: 3 (synchronized via the inner _Atomic int).
```

The constructor's positional `i32(0)` is admitted via the `(*)`-field convention (same as `Box(i32)(i32(0))`, `arc(value)`, `iso(value)`). The bridging from a plain `i32` to the C `atomic_int` field happens at the `AtomicI32` constructor (the body initializes `_Atomic int` via `atomic_init`); the load/store/CAS APIs unwrap back to `i32` for ergonomics. Yo's compile-time Rc analysis auto-inserts the atomic dup on every alias point — explicit `.clone()` is only needed when you want to fork the handle into a _separately named_ variable (e.g. one to retain locally and one to consume into a builder).

The `Arc(AtomicI32)` wrap that the earlier draft showed was redundant — `atomic object` IS the addressing layer. Whichever handle you alias gets you another Rc'd reference to the same `atomic_int`; no extra wrap needed.

**Why not `newtype`:** a value-typed newtype (`newtype(_inner : atomic_int)`) is stack-local by default, which means `b := a` memcpy's the bytes into a fresh atomic at a different address. The two copies don't synchronize. To make them share you'd have to wrap in `Arc(newtype)` — and then you have the same two layers (atomic Rc + atomic value), just with two named types instead of one. The `atomic object` form rolls them into a single user-visible type and removes the footgun of accidentally copying the value-type atomic.

**Why not manual `impl(AtomicI32, Send())`:** auto-derive already grants Send because `atomic_int` (the libc typedef) carries a Send impl from `std/libc/stdatomic.yo` (which lives under `pragma(Pragma.AllowUnsafe)`), and `atomic object` is Send when all its fields are Send. Manual impl would just trip the Phase A2 audit-comment gate for no soundness benefit — auto-derive is the authoritative path here.

**MemoryOrder defaulting:** per your earlier direction, **explicit `MemoryOrder` at every call site, Rust-style**, no SeqCst default. The runtime enum tag inlines to a C `memory_order_*` constant when the order is statically known (a small codegen specialization in `src/codegen/exprs/other-fn-call.ts`).

**Types covered:** `AtomicBool` (over `atomic_bool`), `AtomicI8/16/32/64` (over `atomic_int_least8_t`/`16_t`/`32_t`/`64_t` — or the libc binding's closest typedef), `AtomicU8/16/32/64` (over `atomic_uint_least*_t`), `AtomicUsize` (over `atomic_size_t`), `AtomicIsize` (over `atomic_ptrdiff_t`), `AtomicPtr(T)` (over `atomic_intptr_t` + a transparent cast — the pointer value round-trips through `intptr_t` for storage in the `_Atomic` cell; the C11 `atomic_load`/`atomic_store` semantics on `atomic_intptr_t` are equivalent to those on `_Atomic(void*)` since `intptr_t` is defined to be the integer type capable of holding any `void*` with no data loss). Each lives in `std/sync/atomic.yo` under `pragma(Pragma.AllowUnsafe)`; bodies are thin wrappers over the C11 `atomic_*_explicit` calls. Construction is direct via the type name (`AtomicI32(i32(0))`, `AtomicBool(true)`, etc.) — no top-level builder, no `.new(...)` static.

**Pre-requisite audit:** confirm `std/libc/stdatomic.yo` (a) exposes all the C11 atomic typedefs we need and (b) declares manual `impl(<typedef>, Send())` / `Acyclic` for each under its pragma. If it doesn't, add those impls as the first concrete sub-task of Phase C.

Tests: race-free counter, MPSC ring buffer using AtomicPtr + AtomicUsize, lock-free Treiber stack, fence operations.

### Phase D — Closure-scoped lock APIs (no user-visible guard)

**Prerequisites:** P (Mutex's `_handle`/`_value` interior must be file-private so user code can't bypass the lock), O (user code can't write to the atomic-object's fields directly), C (`atomic_bool` from the new wrapper set is used for `Once`'s fast-path).

The big API rewrite. Mutex _owns_ T (matches Rust; safer than the pthread-style decoupled approach). Access is granted by a closure that receives the inner value by `ref(T)` — Yo's existing second-class `ref` already prevents the borrow from escaping the closure, so no Rust-style guard type / lifetime is needed.

```rust
Mutex :: (fn(comptime(T) : Type) -> comptime(Type))(
  atomic object(_handle : __YO_THREAD_SYNC_TYPE, _value : T)
);

impl(
  forall(T : Type),
  Mutex(T),
  new : (fn(value : T) -> Self)(...),
  with_lock : (
    fn(
      forall(R : Type),
      ref(self) : Self,
      body : Impl(Fn(ref(v) : T) -> R)
    ) -> R
  )({
    self._raw_lock();
    // __MutexUnlocker is a private object held in a local; its Drop
    // calls self._raw_unlock(). Whether the body returns normally or
    // unwinds, the local goes out of scope and the unlocker fires.
    _guard := __MutexUnlocker(self);
    body(self._value)
  }),
  // No public lock()/unlock(). The closure boundary is the only way in.
);
```

Use site:

```rust
mutex := Mutex(Counter).new(Counter(0));
mutex.with_lock((v) => {
  v.count = (v.count + 1);
});

// With a return value:
new_count := mutex.with_lock((v) => {
  v.count = (v.count + 1);
  v.count
});
```

Why this fits Yo:

- `ref(v) : T` is second-class — the closure body can read and write through `v`, but cannot store it in a struct, return it from the closure, or send it across a thread. The borrow stays scope-local to the closure invocation.
- The private `__MutexUnlocker` is a plain `object` with `Drop` that calls `_raw_unlock`. It's allocated locally inside `with_lock`'s frame; Yo's existing drop-on-scope-exit and drop-on-unwind machinery (from the algebraic-effects pass) guarantees unlock under both normal return and `unwind(...)`.
- Zero per-call allocation visible to the user. The `__MutexUnlocker` is stack-local in practice (one Rc field copy).

Same shape for the other primitives:

```rust
impl(
  forall(T : Type),
  RwLock(T),
  with_read : (
    fn(forall(R), ref(self) : Self, body : Impl(Fn(ref(v) : T) -> R)) -> R
  )(...),
  with_write : (
    fn(forall(R), ref(self) : Self, body : Impl(Fn(ref(v) : T) -> R)) -> R
  )(...),
);
```

`Once` keeps its existing API shape (init function, idempotent); two changes inside it:

- The internal manual `_mutex.unlock()` is replaced by the closure-scoped form against the embedded Mutex.
- **The acknowledged non-atomic fast-path read of `_done` is closed.** Switch `_done` from a plain `bool` field to an `atomic_bool` field (libc atomic typedef), and read it with `atomic_load_explicit(..., MemoryOrder.Acquire)` on the fast path. Acquire-load + release-store on completion gives the standard "publication" happens-before edge: any thread observing `_done == true` is guaranteed to also observe everything the initializer wrote. This closes the partial gap listed in the audit summary.

**Breaking change** — every existing `mutex.lock(); ...; mutex.unlock()` site rewrites to `mutex.with_lock((v) => { ... })`. Acceptable per your direction.

**Migration sites (audited, 2026-05-26):** four `std/sync/*.yo` files use `_mutex.lock()`/`_mutex.unlock()` directly — 29 call sites total. They split into two patterns:

| File                    | Sites                                                               | Pattern                                                                        | Migrates to                                                                          |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `std/sync/waitgroup.yo` | 4 (lines 45/54 in `add`, 62/66 in `wait`)                           | Closure-fits; mutex held only over a small block                               | `self._mutex.with_lock((v) => { ... })`                                              |
| `std/sync/once.yo`      | 3 (slow-path inside `call`)                                         | Closure-fits; mutex held only over init                                        | `self._mutex.with_lock((v) => { ... })`                                              |
| `std/sync/channel.yo`   | 14 (across `send`, `recv`, `try_send`, `try_recv`, `close`)         | Holds mutex across `Cond.wait` — closure scope can't model the cv-wait pattern | `self._mutex._raw_lock()` / `self._mutex._raw_unlock()` (pragma-only API, see below) |
| `std/sync/rwlock.yo`    | 8 (across `read_lock`, `write_lock`, `read_unlock`, `write_unlock`) | Holds mutex while updating reader-count / writer-state across cv-waits         | Same — `_raw_lock`/`_raw_unlock`                                                     |

For the cv-wait pattern, the closure-scoped `with_lock` doesn't fit (you need to release the mutex inside `Cond.wait` and reacquire on wake — that interleaves with the closure's stack frame). Phase D exposes `Mutex._raw_lock()` / `Mutex._raw_unlock()` as **pragma-only methods**: they're declared in `std/sync/mutex.yo` and callable only from files that have `pragma(Pragma.AllowUnsafe)`. (The method names start with `_` per Phase P's convention; under Phase P, the field-name rule applies only to fields, but the method-naming convention signals "internal API" — and to enforce pragma-only invocation, Phase D adds a per-method pragma gate analogous to Phase A's manual-Send gate.)

**Cond × Mutex cross-file access (finding 4 resolution):** `std/sync/cond.yo` currently calls `__yo_cond_wait(&(self.cv), &(mutex.mutex))` — it reads the `mutex` field of `Mutex` directly. Under Phase D's rewrite, this field is renamed to `_handle`; under Phase P, `_handle` is file-private to `mutex.yo`. To restore the call, Phase D adds `Mutex._raw_handle_ptr() -> *(__YO_THREAD_SYNC_TYPE)` as a pragma-only method (the `*(T)` return type means safe code cannot call it — the memory-safety pass auto-rejects expressions of pointer type — while `cond.yo` (pragma'd) can). `Cond.wait` rewrites to `__yo_cond_wait(&(self.cv), mutex._raw_handle_ptr())`.

**Channel / WaitGroup query-method races (findings 1 + 2 resolution, decided):** four query methods currently read shared mutable state without acquiring the mutex — `Channel.is_closed()`, `Channel.len()`, `Channel.is_empty()`, `WaitGroup.count()`. These are **active C11 data races today**, not future concerns. Phase D's fix:

- Change `Channel._closed : bool` → `_closed : atomic_bool`. Writers (`close()`) do `atomic_store_explicit(_closed, true, Release)`. Readers (`is_closed()`) do `atomic_load_explicit(_closed, Acquire)`. Lock-free, no mutex on the fast path.
- Change `Channel._len : usize` → `_len : atomic_usize` (or `atomic_size_t`). Same pattern: writers (`send`/`recv`) atomic-fetch-add/sub under the mutex (the mutex still orders multi-field updates); readers (`len()`, `is_empty()`) do atomic-load on the fast path.
- Change `WaitGroup._count : i32` → `_count : atomic_int`. `add()`/`done()` writers under the mutex; `count()` reader is atomic-load.

This matches Rust's idiomatic mpsc/channels (atomic length + lock for multi-field updates) and gives query methods snapshot semantics — the value may be stale by the time the caller acts on it, which is the same as Rust and is the only honest semantic for a lock-free read against a mutating channel/group. Atomic load is roughly free on modern CPUs; the cost is acceptable.

User tests / examples calling `mutex.lock()` / `mutex.unlock()` directly: deprecated. Rewrite at the same time.

**Tests:**

- **Add `tests/sync/mutex.test.yo`** — does not exist today. Phase D adds it, covering: concurrent mutation (2+ threads contending), unwind safety (does `_raw_unlock` fire on `unwind(...)` escape via the `__MutexUnlocker.Drop`?), re-entrant deadlock behavior (documented footgun), return-value propagation through `with_lock`.
- Existing `tests/sync/once.test.yo`, `tests/sync/channel.test.yo`, etc. — verify they still pass after Phase D's API rewrite.

**Why not a Rust-style `MutexGuard`?** Rust needs an explicit guard type because Rust _has_ `&'a T` lifetimes the borrow checker tracks. Yo's `ref(T)` is already scope-bound by being second-class — it can't appear in a struct field, return type slot (other than the labeled-return shape), or be captured by a Send closure. The closure boundary in `with_lock` gives the user exactly what Rust's `MutexGuard` gives Rust users, minus the type and minus an allocation. The earlier draft tried to write `object(_owner : ref(Mutex(T)))` — that's not even valid Yo syntax; `ref(T)` isn't a type.

### Phase E — Per-variable closure-capture Send check

**Prerequisites:** none. Independent analysis improvement. Phase H later reuses the closure-capture walk this phase touches.

Today's check at `src/evaluator/values/anonymous-function.ts:1192–1200` collapses to the aggregate capture struct's Send. The fix walks each captured name before the collapse:

For every closure whose required impl bound includes `Send` (i.e., the closure type is `Impl(Fn(...) -> R, Send)`):

- Enumerate captured variables (`capturedVariables` map already exists in context).
- For each, check `typeImplementsSend(variable.type)`.
- On failure, emit one error per offending capture pointing at the _capture site_, not the closure site: `Captured variable '<name>' (type <Type>) is not Send. To move it across threads, wrap in Arc/Iso, or extract a Send projection.`

Also confirm via comprehensive tests:

- Capture a `Box(i32)` in a `Thread.spawn` closure → reject (Box is not Send).
- Capture a `*(SomeObject)` → reject (pointee not Send).
- Capture an `object`-typed local → reject.
- Capture an `Arc(SomeType)` → accept (closure capture dups the atomic Rc; both sender and receiver have handles to the same heap cell).
- Capture an `Iso(SomeType)` → accept. The closure capture dups the Iso wrapper (Iso is `atomic object` — atomic Rc inc on capture); the sender still holds its local Iso ref until end of its scope. Uniqueness is enforced at the _receiver_'s `extract()` via the runtime `rc == 1` check, NOT by sender-side consumption.

### Phase F — `atomic object` field re-verification

**Prerequisites:** A. F is the cheap safety belt that catches A2's lies on `atomic object` types — do this right after A.

Even with Phase A gating manual Send impls, the _post-impl-registration_ check needs to verify reality matches claim. The user's concern was specifically `atomic object { inner : NonAtomicObject }` slipping through if someone writes `impl(MyAtomic, Send())`.

After all impls are evaluated, walk each `atomic object` type:

- For each field, call `typeImplementsSend` _transitively_ — walk through `Box(SomeObject)`, `Option(SomeObject)`, struct fields, etc.
- If any field is not Send, error at the struct definition with the offending field path: `atomic object 'MyAtomic' has non-Send field 'inner._handle' (type SomeObject). atomic objects shared across threads require all fields to be deeply Send. Either wrap '_handle' in Arc, or remove the manual 'impl(MyAtomic, Send())'.`

This is the safety belt that catches A2's lie.

### Phase G — Codegen pin tests + memory ordering audit

**Prerequisites:** C, D. G validates the primitives end-to-end, so it runs after they stabilize.

Pin tests for the codegen guarantees the soundness argument depends on:

- `__yo_incr_rc_atomic` emits `atomic_fetch_add_explicit(..., relaxed)`.
- `__yo_decr_rc_atomic` emits `atomic_fetch_sub_explicit(..., acq_rel)`.
- Drop on last-release runs _after_ the `acq_rel` decrement (happens-before edge).
- Worker pool init is idempotent.

Also: enable `--sanitize thread` on a curated CI matrix (Linux/Clang). The matrix runs the channel/mutex/atomic/spawn tests under TSan; the goal is zero diagnostics in the curated suite.

### Phase H — `Iso(T)` runtime tightening + API-surface lock-down + ban Iso/Arc direct composition

**Prerequisites:** A (pragma gate for the SAFETY-comment block on `Iso(T) <: Send`), E (the closure-capture analysis machinery is reused for the sender-side last-use diagnostic).

Four tightenings. The first three close the runtime/discipline risks listed in "Iso(T) design notes — precedent and known risks" above; the fourth closes the composition redundancy.

**1. `Iso(T).extract()` failure mode.** Today it returns `Option(T)` based on a runtime `rc == 1` check, returning `.None` on failure. Replace with a panic. The runtime check stays — defense in depth — but if the compile-time RC analysis is sound, this path is unreachable. If the panic ever fires, that's a soundness bug to fix in the compiler, not a runtime control-flow choice for the user. Signature becomes `extract : (fn(self : Self) -> T)`.

**2. API-surface lock-down (closes Risk #1: hidden API-surface precondition).** The "unconditionally Send" rule depends on Iso's public API exposing nothing that touches the inner `T` except `extract()`. Make this invariant explicit so future contributors cannot violate it accidentally:

- Add an audit-gate comment block immediately above `impl(forall(T : Type), Iso(T), Send())` in `std/prelude.yo`:
  ```
  // SAFETY: Iso(T) is unconditionally Send (no `T <: Send` bound) because
  // Iso's public API exposes no operation on the inner T except extract(),
  // which atomically verifies rc == 1 before returning. If you add any new
  // method to Iso(T) that touches the inner T (map, peek, read, &self
  // borrow, etc.), this Send claim becomes unsound and must be revoked.
  // See plans/THREAD_SAFETY.md "Iso(T) design notes — precedent and known
  // risks" for the full argument.
  ```
- Add a `tests/iso_api_surface.test.yo` pin test that uses `comptime_assert` to verify the exact set of `Iso(T)` public methods (constructor, `extract`, plus any others currently public). Any future PR that adds a method to Iso will fail this test, forcing the author to read the SAFETY block and consciously decide whether the addition preserves the invariant.
- Document in `docs/{en-US,zh-CN}/THREAD_SAFETY.md` that `Iso(T)` is intentionally minimal.

**3. Sender-side "last-use after spawn" diagnostic (closes Risk #3: implicit drop-before-extract).** Today, a sender that holds an `Iso(T)` in an outer scope and tries to `extract()` from a spawned thread will see the spawn fail at runtime (rc != 1). The compile-time RC analysis can often see this statically: if the sender's last lexical use of an `Iso(T)` local follows a `Thread.spawn` / `Worker.spawn` / `Channel.send` call that captures/sends the same Iso, that's almost certainly a bug. Emit a compile-time warning (not error — there may be advanced patterns we don't want to forbid) pointing at the sender's later use:

```
Warning: 'iso_val' is held after being sent to Thread.spawn at line 42.
The receiver's Iso(T).extract() will fail (rc != 1) until 'iso_val'
goes out of scope here. Consider re-scoping or shadowing the binding.
```

Implementation: extend the closure-capture analysis (Phase E touches the same machinery) to walk forward from spawn/send sites and check for further uses of any captured Iso-typed locals. Low risk — purely additive warning.

**4. Ban direct `Iso(Arc(T))` and `Arc(Iso(T))` composition.** Both are meaningless or contradictory:

- **`Iso(Arc(T))` is redundant.** Iso's uniqueness invariant is about the _Iso wrapper_'s rc, not the inner Arc cell. After `extract()` you get the Arc back; the Arc's own rc is unaffected by the Iso layer. So `Iso(Arc(T))` adds nothing over a naked `Arc(T)` sent through a closure capture with move semantics — the sender drops their Arc local after spawning, the receiver has the Arc, that's it.
- **`Arc(Iso(T))` is internally contradictory.** Arc lets you clone the handle freely; Iso claims uniqueness. The only charitable reading — "single-shot rendezvous: multiple handles race to `extract()`, one wins, others get `.None`" — is a real pattern but it's a _Oneshot_, not an Arc. If we want that pattern, add an explicit `Oneshot(T)` primitive to `std/sync/`; don't dress it up as Arc.

Implementation: detect at type construction. Reject `Iso(Arc(...))` and `Arc(Iso(...))` with the actionable diagnostic:

```
Error: Iso(Arc(T)) is not allowed.
  - To send an Arc handle across a thread, send the Arc directly — the
    spawn closure already consumes it. Iso adds nothing.
  - If you want unique-owned heap data, use Iso(Box(T)) or Iso(...your struct...).
```

```
Error: Arc(Iso(T)) is not allowed.
  - Arc is for shared ownership; Iso is for unique ownership. The composition
    is contradictory.
  - If you want a "one of many threads races to claim a value" pattern, build
    a Oneshot(T) primitive on top of Mutex + Option (or wait for std/sync to
    expose one).
```

**Transitive nesting stays legal.** `Arc(MyStruct(_inner : Iso(T)))` and `Iso(MyStruct(_inner : Arc(T)))` are user-domain-meaningful structures and aren't banned. The rule only fires on directly-adjacent composition because that's the case that's redundant or contradictory.

### Phase I — `Dyn(Trait, Send)` for cross-thread trait objects

**Prerequisites:** none. Audit + one-line additions to existing `Dyn(...)` sites; independent of other phases.

Yo already supports comma-separated trait lists in `Dyn` (e.g. `Dyn(Speak, Run)` in `tests/dyn.test.yo:130`). Add `Send` to the list for cross-thread use:

```rust
worker :: (fn(work : Dyn(Job, Send)) -> unit)(...);
```

No new syntax. The evaluator already verifies that `dyn(value)` against `Dyn(T1, T2, ...)` requires the concrete type to implement every listed trait; once `Send` is in the list, that requirement applies. Vtable construction is unchanged — Send is a marker with no methods, so no vtable slot.

Sending a `Dyn(Trait)` (without `Send` in the list) to `Thread.spawn` or via `Channel(Dyn(Trait))` is rejected by the spawn API's Send bound — no special case needed.

**Audit task:** scan every `Dyn(...)` in `std/sync/`, `std/thread.yo`, `std/worker.yo`, channel/atomic APIs, and any cross-thread API surface. Add `Send` to the trait list anywhere the dyn-typed value can cross a thread boundary. Document the rule in `docs/{en-US,zh-CN}/THREAD_SAFETY.md`.

### Phase J — Dropped

`Drop` thread-portability is safe by design:

- A non-atomic `object` is only ever dropped on its owning thread — it can't be sent in the first place, so its `Drop` body always runs on the same thread that allocated it.
- An `atomic object` is Send only if all its fields are Send (Phase F re-verifies this even when the impl is manual). The `Drop` body therefore operates only on Send data; whichever thread brings rc to 0 can safely run it. Per-thread services that the body happens to use (allocator, stdout buffer, etc.) are addressed via that thread's own thread-local state — no cross-thread sharing.

No phase needed.

### Phase K — Dropped

No `immutable` modifier in the type system. The motivation was to compile-check the immutability claim that `std/imm/list.yo`'s self-referential `atomic object` makes when manually implementing `Acyclic`. But the same audit boundary that Phase A2 already establishes is sufficient:

- Manual `impl(T, Acyclic())` requires `pragma(Pragma.AllowUnsafe)`.
- The std/imm/ data structures live in pragma'd files and audit-establish their immutability claim through implementation review — exactly the trust model `unsafe(...)` already uses elsewhere.
- A future contributor accidentally adding a mutation method to `ListNode` would land in a pragma'd file, where the `// SAFETY:` comment on the Acyclic impl serves as a reviewer prompt.

If a user wants to write their own immutable data structure with self-referential `atomic object`, they put it in a pragma'd file and follow the same convention. The type system doesn't enforce immutability directly; the data structure's implementation does.

### Phase N — Negative trait impls (`impl(T, !(Trait))`)

**Prerequisites:** none. Small standalone language feature that enables Phase L.

> Phase letter is a fresh bookmark; document order places it before Phase L because Phase L depends on this feature.

**Motivation.** Send (and Acyclic) are auto-derived structurally: a struct is Send iff all its fields are Send. Today there is **no way to declare a type as explicitly not-Send when its fields would otherwise auto-derive Send.** That gap blocks Phase L: `JoinHandle(T)` is `struct(__future : *(T))` and `*(T) <: Send` when `T <: Send`, so `JoinHandle(T)` auto-derives Send when `T` is Send — but it shouldn't, because the inner future state lives on the spawner's event-loop thread. Same for `Io` (a struct of Send function refs, but the runtime it represents is thread-local).

The structural-auto-derive workarounds (make it an `object`, add a phantom non-Send field) all introduce a real cost: an extra heap allocation per handle / Io / etc. Negative impls give us a zero-overhead, explicit opt-out.

**Syntax:**

```rust
impl(forall(T : Type), JoinHandle(T), !(Send));
impl(Io, !(Send));
```

`!(Trait)` in the trait position of an `impl(...)` declaration declares that the type explicitly does **not** implement Trait. Reads naturally as "not Send".

**Semantics:**

- If a type T has a negative impl `impl(T, !(Trait))` in scope, then `T <: Trait` is **false**, regardless of any structural auto-derive that would otherwise fire.
- The negative impl is checked _first_, before auto-derive. It is authoritative.
- Contradiction is a compile error: `impl(T, Trait())` and `impl(T, !(Trait))` cannot coexist for the same T (and for the same instantiation of generic T). Error message: `Conflicting impls for T: impl(T, Trait()) at <loc> and impl(T, !(Trait)) at <loc>.`
- Only meaningful for **marker traits** (no methods): Send, Acyclic, Sync (when added). Negative-impl'ing a trait with methods is a compile error (`!(Trait)` makes no sense — there are no methods to "not have").
- Negative impls participate in generic resolution the same way positive impls do: `impl(forall(T : Type), JoinHandle(T), !(Send))` makes every `JoinHandle(T)` non-Send regardless of T.

**Audit boundary — no pragma required.**

Unlike `impl(T, Send())` which under Phase A2 requires `pragma(Pragma.AllowUnsafe)`, **`impl(T, !(Send))` requires neither pragma nor `// SAFETY:` comment.** The asymmetry is intentional:

- `impl(T, Send())` _adds_ a permission (T may cross thread boundaries). A wrong claim makes user code unsound. Hence the audit gate.
- `impl(T, !(Send))` _removes_ a permission (T must not cross). A wrong claim makes user code over-restrictive (spawn sites refuse to compile), never unsound. No audit gate needed.

Anyone may declare `impl(MyType, !(Send))` freely.

**Implementation:**

- Parser: extend the impl-declaration grammar to recognize `!(IDENT)` in the trait-name slot, lowering to a `NegativeImplDecl` AST node.
- Evaluator: maintain a per-type negative-impl set alongside the existing per-type impl set. Resolution order in `typeImplementsTraitBool`: check negative-impl set first; if hit, return false; otherwise fall through to the existing positive-impl + auto-derive logic.
- Evaluator: at impl-registration time, error on contradictory `impl(T, Trait())` + `impl(T, !(Trait))` pairs.
- Evaluator: error on `impl(T, !(Trait))` when `Trait` has methods.

**Scope (this pass):** the feature is general, but the only uses in std/ for v1 are:

- `impl(forall(T : Type), JoinHandle(T), !(Send));`
- `impl(Io, !(Send));`

If audit of other concrete async-runtime types surfaces more candidates (e.g., a concrete Future implementor type that holds thread-local state directly), they get the same impl.

**Tests:**

- Positive: `JoinHandle(i32)` rejected when captured by a `Thread.spawn` closure.
- Positive: `Io` rejected at any cross-thread send/spawn site.
- Negative: `comptime_expect_error` for `impl(MyTrait, !(Send))` when `MyTrait` has methods.
- Negative: `comptime_expect_error` for the contradictory `impl(T, Send())` + `impl(T, !(Send))` pair.
- Acceptance: a user struct `impl(MyHandle, !(Send));` works and compiles errors propagate when sent.

### Phase L — Future / async cross-thread bound

**Prerequisites:** N. L is the consumer of negative impls — it adds `impl(JoinHandle(T), !(Send))` and `impl(Io, !(Send))` to `std/prelude.yo`.

Yo's async runtime is per-thread (per AGENTS.md). A `Future(T, E)` value carries a state machine that references the per-thread scheduler. Moving it to another thread is undefined.

**Concrete changes:**

- `Impl(Future(T, E))` is **NOT Send** today — `Impl(Trait)` types are Send only when `Send` is in the impl-bound list (e.g., `Impl(Future(T, E), Send)`), which Yo's async runtime never produces. No change needed; document this in `docs/{en-US,zh-CN}/THREAD_SAFETY.md`.
- `JoinHandle(T)` (the async-task handle returned by `io.spawn`, defined in `std/prelude.yo:8343`) is **today auto-derived Send when T is Send** because its single field `__future : *(T)` propagates Send structurally. **Fix:** add `impl(forall(T : Type), JoinHandle(T), !(Send));` immediately after the `JoinHandle` type definition. This is zero overhead — the struct stays a struct, the raw pointer field stays a raw pointer, only the Send claim is removed.
- `Io` (`std/prelude.yo:8354`) is **today auto-derived Send** because all its fields are function refs (which are Send). **Fix:** add `impl(Io, !(Send));`. Same zero-overhead rationale.
- Cross-thread result delivery uses `Channel(T)` — that has always been the model for OS-thread `Thread.spawn`; this phase just clarifies that the async-side `JoinHandle` follows the same rule (await on the spawning thread; if another thread needs the result, send it through a Channel).

**Why this matters even though no user is currently sending `JoinHandle` cross-thread:** the Send claim is load-bearing in the soundness theorem. Every cross-thread API takes `Impl(... , Send)` bounds, and the type system uses transitive Send-ness to decide what's safe to capture. A bogus structural Send on `JoinHandle` means a user closure that captures a JoinHandle is reported Send when it isn't — and the closure can then be passed to `Thread.spawn`. Closing the hole costs nothing now and removes a class of future "how did this ever compile" surprises.

**Migration audit (performed during plan finalization):** grepping std/ and tests/ for `JoinHandle` and `io.spawn` confirms expected count: zero cross-thread JoinHandle usage. All current `io.spawn` sites are inside a single async runtime (single-threaded by construction). `tests/async_await.test.yo:1363-1364` and others spawn-and-await within the same thread, which Phase L preserves. No rewrites needed; only the two `impl(..., !(Send));` lines in `std/prelude.yo`.

**Worker.spawn note:** `std/worker.yo:14` defines `spawn : (fn(cb : Impl(Fn(io : Io) -> unit, Send)) -> unit)` — returns `unit`, not a handle. Workers are fire-and-forget; no `JoinHandle` for the OS-thread side. Phase L only affects the async `JoinHandle` returned by `io.spawn`, not anything in `std/worker.yo` or `std/thread.yo`. `Thread.spawn` returns `Thread` (an `object` per `std/thread.yo:23` — already non-Send by construction). No further changes for those.

**Pin test (regression-guard):** add `comptime_assert(!typeImplementsSend(Impl(Future(i32, unit))))` to the test suite. This locks in the invariant that bare `Impl(Trait)` types are non-Send unless `, Send` is explicitly listed in the trait bound. Future evaluator changes that accidentally auto-grant Send to `DynType` would trip this assertion.

### Phase O — Forbid mutation of `atomic object` fields in safe code

**Prerequisites:** none. Independent structural rule. Consumed by Phase C (so user code can't write to `AtomicI32`'s `(*)` field directly) and Phase D (so user code can't write to Mutex's interior bypassing the lock).

**A new structural rule, not an extension of any existing memory-safety guarantee.** Yo today has _no_ rule restricting writes through aliased objects — Box, Arc, and user-defined atomic-object wrappers all permit `b.* = value` and `b.field = value` in safe code, and aliases share storage. This is the deliberate share-by-reference semantics for `object` types. For non-atomic `object` it's intra-thread shared mutation (no race, by virtue of non-Send). For `atomic object` it's a cross-thread data-race vector — verified empirically: `arc.* = (arc.* + i32(1))` compiles and runs today with the inner i32 read/written non-atomically.

Phase O closes this for the atomic-object case only, leaving non-atomic `object` semantics untouched.

**The rule (lexical, applied at type-checking):**

> In safe (non-pragma'd) code, the following are rejected:
>
> 1. **Assignment** whose LHS is a field-access expression whose _root sub-expression's resolved type_ is `atomic object`. The "root" is the leftmost sub-expression after stripping field accesses (`.foo`) and the deref `.*`.
>    - `arc.* = ...` (root `arc : Arc(T)`) → rejected.
>    - `arc.field = ...` → rejected.
>    - `arc.field.subfield = ...` → rejected (root is still `arc`).
>    - `myarc._inner = ...` where `MyArc` is user-defined `atomic object` → rejected.
>    - `someFn().field = ...` where `someFn()` returns an atomic object → rejected (the root is a call expression of atomic-object type).
>    - `(cond ? arc1 : arc2).* = ...` where both branches are atomic-object-typed → rejected (root is a conditional expression of atomic-object type).
> 2. **Compound assignment** (`+=`, `-=`, etc.) on the same forms — desugars to a write.
> 3. **Passing such an expression as a `ref(T)` or `inout` argument** — the callee would write through the ref, same race.
>
> Reads through atomic-object fields remain allowed (no writer can exist in safe code → no race).
> Construction via the type's constructor (`Arc(value)`, `MyArc(initial)`) remains allowed — initialization is a separate code path, not a field write.
> Pragma'd code bypasses the rule, consistent with the rest of the trust model.

The rule is **type-based on the LHS root sub-expression**, not "is the root a named binding?" — this is more general and covers all expression forms (named locals, call results, conditional expressions, lambda calls, pointer deref). For pointer-deref forms `(*(ptr_to_atomic)).field = ...`, the memory-safety pass already rejects `*(T)` expressions in safe code earlier in the pipeline; in pragma'd code, Phase O bypasses, so the case never reaches a conflict.

**Why this is the right shape — the lexical-root check.**

The rule looks at the _textual root_ of the LHS / ref-argument expression and asks "is that binding's type an atomic object?" — not "does this write ultimately land inside an atomic-object's heap cell?" The latter would be infeasible (it'd have to chase through method calls and aliases) and also wrong, because the audit boundary is exactly about "pragma'd code is trusted to hand out interior refs after synchronizing."

This is what makes `Arc(Mutex(T))` + `with_lock` work cleanly:

```rust
arc_mutex.with_lock((v) => {
  v.field = i32(5);   // LHS root is `v` (type ref(T)), NOT an atomic object → ALLOWED
});
```

Method dispatch resolves `arc_mutex.with_lock(...)` to `Mutex.with_lock` via Arc's `(*)` deref (a read, not a write). Inside `Mutex.with_lock` (in pragma'd `std/sync/mutex.yo`), the implementation does `body(self._value)` — a `ref(T)` arg rooted at `self : Mutex(T)` (atomic object). That call would be rejected in safe code by clause (3), but the file is pragma'd, so it's allowed. The pragma is the audit assertion: "I have acquired the lock before handing out this ref."

From user code's perspective, the closure body receives `v : ref(T)`. `v`'s root type is `ref(T)`, not atomic object. Writes through `v.field` pass Phase O cleanly. The user never names a path beginning at an atomic-object binding.

This is exactly Rust's `MutexGuard` story: user code writes `*guard = ...` through `&mut T`; the borrow checker doesn't see "this mutates the Mutex's interior"; the trust is that `lock()` synchronized correctly. Yo's version is cleaner because `ref(T)` is second-class — the closure body can't store, return, or capture `v`, so the lock window is structurally bounded.

**Compositional consequences.**

- `Arc(i32)` — usable only as shared _immutable_ value (set at construction, read concurrently). Useful for shared config, lookup tables.
- `Arc(AtomicI32)` — atomic mutation via `.fetch_add` / `.store` / etc. (methods on the inner AtomicI32, dispatched through Arc's deref).
- `Arc(Mutex(T))` — locked mutation via `arc.with_lock((v) => ...)`.
- `Arc(RwLock(T))` — many-readers / one-writer via `arc.with_read` / `arc.with_write`.

Same model as Rust. User-defined `MyArc(V) :: atomic(object(_inner : V))` falls into the same category — Phase O treats it identically to the std-provided Arc.

**Implementation:**

- One predicate added to the evaluator: `isAtomicObjectFieldWrite(expr) → bool` — given an LHS expression, walk to its root (skipping field accesses and method-deref `(*)`), check whether the root sub-expression's resolved type is `atomic object`.
- Two call sites for the predicate:
  - Assignment evaluation (`x.y = ...`, `x.y op= ...`): reject if the predicate is true on the LHS.
  - Function call evaluation, for each argument bound to a `ref(T)` / `inout` parameter: reject if the predicate is true on the argument expression.
- Pragma bypass: if the file has `pragma(Pragma.AllowUnsafe)`, skip the check (same gate the rest of memory-safety uses).
- Diagnostic includes the "use one of: Arc(AtomicX) / Arc(Mutex(T)) / Arc(RwLock(T))" hint.

**Tests:**

- Reject: `arc := arc(i32(0)); arc.* = i32(5);` in safe code.
- Reject: user-defined `MyArc(i32)` with custom field — `m._inner = i32(5);` in safe code.
- Reject: nested-path write `arc.struct_field.subfield = ...` rooted at atomic object.
- Reject: `swap(arc.field, ...)` passing atomic-object-rooted expression to `ref(T)`.
- Accept: read forms `x := arc.*`, `y := myarc._inner` — no write, no rejection.
- Accept: construction `arc(i32(0))`, `MyArc(i32)(i32(0))`.
- Accept: `arc_mutex.with_lock((v) => { v.field = i32(5); })` — user-facing pattern.
- Accept: any write inside a pragma'd file (regression-pin existing `std/sync/mutex.yo` mutation patterns).

**Test-migration impact:** `tests/sync/once.test.yo:9` declares `SharedCounter :: atomic(object(value : i32))` and increments `counter.value = (counter.value + i32(1))` from inside `Once.call(...)` closures (lines 94, 99, 104, 109). The increments are serialized at runtime by `Once`, but Phase O rejects them statically — the type system doesn't know `Once.call` is the synchronization barrier. Migration: rewrite the test to use `AtomicI32` (post-Phase C) for the counter, or move the counter into a plain non-atomic local inside the `Once.call` closure. Phase O's test-migration sub-task includes auditing every existing `tests/sync/*.test.yo` for this pattern.

### Phase P — Field visibility (`_`-prefix enforced as file-private)

**Prerequisites:** none. Independent general language feature. Consumed by Phase C (libc-binding internals stay private), Phase D (Mutex/RwLock/Once's `_handle`/`_value`/`_done` interiors become inaccessible to user code), and closes vector 27.

**Goal.** A general field-visibility mechanism — not specific to thread safety, but load-bearing for closing the synchronized-interior read hole that Phase O leaves open (`mutex._value` reads racing with `with_lock` writes), and for tightening encapsulation across std/ generally.

**The rule.**

> A struct/object field whose name starts with `_` is accessible **only** within the file that defines the containing type. From any other file, reading or writing the field is a compile error.
>
> Methods declared in the same file as the type can touch the field freely (that's how `std/sync/mutex.yo` keeps working).
> Auto-generated code (`auto-generated://` URIs from macros and derives) inherits the privilege of its expansion site, consistent with the rest of the trust model.
> The rule applies whether or not the type is an atomic object — it's a universal field-visibility mechanism.

**Why `_`-prefix, not a `pub`/`priv` keyword.**

- Yo already uses `_`-prefix pervasively as a privacy convention. `std/prelude.yo` and `std/sync/*` are full of `_handle`, `_value`, `_inner`, `_ptr`, `_capacity`, `_len`, etc. Promoting the convention to enforced privacy is zero migration cost in std/.
- No new parser surface — `_foo` already parses as a normal identifier.
- Familiar to Python/JS/Swift users; intuitive default for anyone else.
- Doesn't fight the existing community-convention layer; reinforces it.

**Why this is the long-term solution rather than `*(T)`-wrapping discipline.**

- `*(T)`-wrapping works today (the memory-safety pass auto-rejects `*(T)` expressions in safe code), but it requires every std-lib contributor to remember to wrap synchronized interiors in `*(T)`. A naïve `_value : T` reopens the hole silently.
- Field visibility is enforced by the language, not by convention plus code-review. A future contributor cannot accidentally break it.
- Generalizes beyond thread safety to encapsulation everywhere — `string._ptr`, `arraylist._capacity`, etc. become structurally inaccessible from user code, closing latent abstraction-leak gaps.

**Closes (from Phase O's perspective).**

- Vector 27 (synchronized-interior reads): `mutex._value`, `rwlock._value`, `once._done` etc. are file-private to their defining `std/sync/*.yo` files. User safe code cannot name them.
- A new class of incidental holes that Phase O doesn't even mention: `string._ptr`, `arraylist._buf`, `hashmap._capacity`, etc. — fields that were "private by convention" become private by language.

**What stays accessible in safe code (the public surface).**

- Fields without `_`-prefix: full access subject to Phase O's write rule.
- The `(*)` field convention used by `Box`, `Arc`, `Iso`, `AtomicX`: still readable in safe code (`arc.*`, `box.*`). Phase O still forbids writes. There's no longer a special case in Phase O — `(*)` is just "not underscore-prefixed."

**Migration impact.**

- **std/**: zero. Existing `_`-prefixed fields are already private by convention; promoting to enforcement is a no-op for std-internal code (same-file access still works) and removes the latent ability of user code to peek.
- **User code that violates the new rule**: any user code that names a `_`-prefixed field on a type defined elsewhere starts failing to compile. That code was always relying on undocumented internals; the language now makes it explicit. Diagnostic: `Cannot access private field '_foo' on type 'Bar'. The field is defined in 'std/.../bar.yo' and is private to that file.`
- **User-defined types**: users get the same convention available to them. `MyType :: struct(public_field : i32, _internal : i32)` — `_internal` is private to the defining file.

**Implementation.**

- Zero parser change.
- Evaluator change in the field-access resolver: when resolving `expr.foo`, if `foo` starts with `_`, check whether the current expression's module URI matches the URI of the file where the containing type was declared. If not, reject with the diagnostic above.
- Auto-generated expansion sites (URI prefix `auto-generated://`) inherit the privilege of the user-facing call site, same exemption that `isAutoGeneratedExpansion` already provides for pointer-op gates.
- Pragma'd code (`pragma(Pragma.AllowUnsafe)`) **does not** auto-bypass the visibility rule. Privacy is orthogonal to the unsafe-pragma — a pragma'd file can still only see its own private fields, not another file's. This is a design choice (encapsulation is a separate concern from unsafe-capability) and matches Rust (`unsafe` doesn't grant visibility).

**Tests.**

- Reject: user code in `user.yo` writing `mutex._value` where `Mutex` is defined in `std/sync/mutex.yo`.
- Reject: user code reading `arraylist._capacity` where `ArrayList` is defined in `std/collections/array_list.yo`.
- Accept: same-file methods on `Mutex` accessing `self._value`.
- Accept: user-defined `MyType` in `user.yo` accessing its own `_field` from another method declared in `user.yo`.
- Reject: another file accessing `MyType._field`.
- Accept: auto-derived `clone()` accessing `_field` — the derive expansion inherits the user's privilege.

**Effort.** ~1–2 days. The check is localized to field-access resolution; no broad refactor.

### Phase M — Diagnostics & documentation

**Prerequisites:** all prior phases. Runs last; consolidates docs and diagnostic-message polish after the implementation surface stops moving.

- `yo unsafe-report --thread-safety` mode: lists every `impl(T, Send/Acyclic/Sync())`, every raw-pointer-bearing field of a Send type, every `Dyn(...)` without `Send` in its trait list that crosses the API boundary.
- `docs/{en-US,zh-CN}/THREAD_SAFETY.md`: user-facing explainer with the data-race-freedom theorem, the vector inventory, and the trust boundary. Include:
  - The Phase O / Phase P story for atomic-object types and field visibility.
  - The `Slice(T) <: Send when T <: Send` argument: slices are value-typed views (pointer + length) over a backing array. Sending a slice across threads copies the header; both threads read the backing array (no writes through a slice). The implicit assumption — somebody must keep the backing array alive across both threads — is upheld by Yo's RC analysis at the backing-array owner. Document this explicitly so users understand why slices appear in the Send vector inventory.
  - The Mutex deadlock-on-recursive-lock footgun (matches Rust's `std::sync::Mutex`).
- Error messages: every gate (manual Send impl, non-Send capture, Future-as-Send, etc.) emits a "Fixes:" section pointing at the right primitive (Arc/Iso/Channel/Mutex/Atomic).

#### Channel error model

Channel error reporting matches the rest of Yo's std: only logical/communication errors flow through the return `Result`; OOM is a panic, same as `ArrayList.push`, `HashMap.set`, and every other allocation site in std/.

```rust
ChannelError :: enum(
  Closed,        // both forms
  Full           // try_send on a bounded channel only
);

impl(
  Channel(T),
  // Bounded: blocks until space; surfaces Closed only.
  send : (fn(ref(self) : Self, value : T) -> Result(unit, ChannelError))(...),
  // Bounded, non-blocking: surfaces Closed or Full.
  try_send : (fn(ref(self) : Self, value : T) -> Result(unit, ChannelError))(...),
  // ...
);
```

For an unbounded channel, `send` returns `Err(.Closed)` only — buffer-full is impossible by construction. OOM during the internal slot allocation panics via the existing allocator contract (`malloc(size).unwrap()`).

Why panic-on-OOM rather than `Result(unit, OutOfMemory)`:

- Rust (`std::sync::mpsc`, `crossbeam-channel`, `tokio::mpsc`), C# `Channels`, Java's unbounded `ConcurrentLinkedQueue`, Erlang mailboxes, Haskell `Chan` — all panic / throw / abort on alloc failure. None thread OOM through the channel API.
- Yo's std is internally consistent: `ArrayList`, `HashMap`, `String`, and every other heap-using primitive `.unwrap()` allocations and panic on NULL. Channel matches.
- Threading OOM through `Result` would be ergonomic tax on a path that almost never fires in practice — every `send()` call site would have to `match` or `.unwrap()` an OOM variant that's never reachable in normal operation. Past the OOM point the process is unrecoverable anyway.
- If Yo ever targets embedded / kernel / no-OS environments, the right answer is a Zig-style end-to-end fallible-allocator pass across _all_ of std/ (every `push`, `insert`, `concat`, etc.), not a channel-specific workaround. That's a separate language-wide decision.

Document this contract clearly in the user-facing `docs/.../THREAD_SAFETY.md` and in `Channel(T)`'s rustdoc-equivalent comment block so users don't reach for try/recover around `send`.

## Trust boundary

| Layer                       | What's trusted                                                                                                                   | What's enforced                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User code (no pragma)       | Nothing                                                                                                                          | All cross-thread sharing goes through std/sync primitives. Manual `impl(T, Send())` rejected. Non-Send captures rejected. `Future(T, E)` not Send. `JoinHandle(T)` not Send. `Dyn(...)` requires `Send` in its trait list for cross-thread use. `Channel(T)` / `Arc(T)` / `Mutex(T)` / `RwLock(T)` require `T <: Send` at construction. |
| Stdlib `std/sync/` (pragma) | Primitive bodies implement their Mutex/Atomic/Channel/Arc contracts correctly. C11 atomic memory orderings are used as intended. | Manual Send impls require `// SAFETY:` comments. Phase F re-verifies `atomic object` field Send-ness even when impl is manual.                                                                                                                                                                                                          |
| Codegen runtime (TS)        | Atomic RC ops use correct memory ordering. Per-thread state is `_Thread_local`. Worker pool is correctly synchronized.           | Phase G pin tests guard against regressions. CI runs TSan on a curated suite.                                                                                                                                                                                                                                                           |
| `extern("c", ...)`          | C functions are reentrant-safe if called from multiple threads.                                                                  | Out of scope; same audit boundary as memory-safety pass.                                                                                                                                                                                                                                                                                |

## Audit findings (2026-05-26 code review) — resolution log

A reviewing agent ran a thorough audit against the TypeScript evaluator, C codegen, `std/sync/`, and test files. All 12 findings have been integrated into the relevant phases above. This log records each finding and where it now lives.

| #   | Severity | Finding                                                                                          | Where resolved                                                                                                                                                                                                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 🔴       | Channel `is_closed()`/`len()`/`is_empty()` unsynchronized reads — **active C11 race today**      | ✅ Resolved — migrated `_closed` to `AtomicBool` and `_len` to `AtomicUsize` (commit `20b6c7e9`). Query methods are lock-free `Acquire` loads with snapshot semantics. Used the AtomicX wrapper types instead of raw `_Atomic` C fields after the original raw-field attempt hit a C struct-initializer codegen issue (commit `3f15256f`). |
| 2   | 🔴       | WaitGroup `count()` unsynchronized read — **active C11 race today**                              | ✅ Resolved — migrated `_count` to `AtomicI32` (commit `20b6c7e9`). `count()` is a lock-free `Acquire` atomic load.                                                                                                                                                                                                                        |
| 3   | 🔴       | Phase D migration scope undercounted — 29 lock/unlock sites across channel/rwlock/waitgroup/once | Phase D "Migration sites (audited)" table — split into `with_lock` pattern (waitgroup/once) and `_raw_lock`/`_raw_unlock` pattern (channel/rwlock)                                                                                                                                                                                         |
| 4   | 🟡       | `Cond.wait` reads `mutex.mutex` cross-file — Phase D × Phase P conflict                          | Phase D "Cond × Mutex cross-file access" — adds `Mutex._raw_handle_ptr() -> *(__YO_THREAD_SYNC_TYPE)` pragma-only method                                                                                                                                                                                                                   |
| 5   | 🟡       | Once fast-path is a missing happens-before edge, not just "not atomic"                           | "Decided so far" Once bullet rewritten; Partial summary updated                                                                                                                                                                                                                                                                            |
| 6   | 🟡       | `std/libc/stdatomic.yo` lacks `Send`/`Acyclic` impls for atomic types — blocks Phase C and D     | Added to Partial summary as a Phase C prerequisite sub-task                                                                                                                                                                                                                                                                                |
| 7   | 🟡       | Phase O "root binding" rule doesn't cover unnamed roots, conditionals, lambda calls, deref       | Phase O rule generalized: "root sub-expression's resolved type" (type-based, not binding-based)                                                                                                                                                                                                                                            |
| 8   | 🟢       | `tests/sync/once.test.yo` exercises the Phase O race vector — needs migration                    | Phase O "Test-migration impact" subsection added                                                                                                                                                                                                                                                                                           |
| 9   | 🟢       | `*(T) <: Acyclic` is unconditional — intentional asymmetry with `*(T) <: Send`                   | Added to "What's already in place ✅ Solid" with the rationale                                                                                                                                                                                                                                                                             |
| 10  | 🟢       | No dedicated `tests/sync/mutex.test.yo`                                                          | Phase D "Tests" subsection — adds the file with concurrent-mutation, unwind-safety, re-entrant-deadlock, return-value coverage                                                                                                                                                                                                             |
| 11  | 🟢       | `Slice(T)` cross-thread safety argument is non-obvious (immutable view over a backing array)     | Phase M's `docs/{en-US,zh-CN}/THREAD_SAFETY.md` content list updated                                                                                                                                                                                                                                                                       |
| 12  | 🟢       | `Impl(Trait)` Send auto-derive verified correct (closure captures, DynType resolution)           | Phase L "Pin test" subsection — adds `comptime_assert(!typeImplementsSend(Impl(Future(i32, unit))))`                                                                                                                                                                                                                                       |

**Three findings (1, 2, 4) involved design choices — all resolved:**

- **Findings 1 & 2 (Channel/WaitGroup unsync reads):** migrated the affected fields to the Yo-level `AtomicBool` / `AtomicUsize` / `AtomicI32` wrapper types (not raw `_Atomic` C fields). Query methods are lock-free `Acquire` atomic loads with snapshot semantics (matches Rust's `mpsc` idiom). The wrapper approach pays one extra heap allocation per Channel/WaitGroup but sidesteps the C struct-initializer codegen obstacle the raw-`_Atomic`-field path hit. Direct raw-field embedding remains a v2.x perf-optimization item for hot-path lock-free data structures.
- **Finding 4 (Cond × Mutex cross-file):** `Mutex._raw_handle_ptr()` as a pragma-only method (the `*(T)` return type means safe code can't even name the result, while pragma'd `cond.yo` can).

## Open Questions (still need your input)

All currently raised questions are resolved. New questions will be added here as the design evolves.

1. ~~`Dyn(Trait + Send)` syntax~~ — **resolved:** use existing `Dyn(Trait, Send)` multi-trait form.
2. ~~Phase J approach~~ — **resolved:** drop is safe by design under current rules; phase removed.
3. ~~Phase K `immutable` modifier~~ — **resolved:** not adding it. Immutable data structures audit-establish their Acyclic claim through implementation review in pragma'd files.
4. ~~MutexGuard projection~~ — **resolved:** no user-visible guard. `with_lock((v) => ...)` closure-scoped API; the closure receives `ref(v) : T` directly.
5. ~~Channel.send on unbounded OOM~~ — **resolved:** panic via the existing allocator contract, same as every other heap-using primitive in std/. The `Result` return type signals "channel closed" only. See Phase M's "Channel error model" subsection.
6. ~~`Iso(Arc(T))` / `Arc(Iso(T))`~~ — **resolved:** ban both direct compositions. Iso(Arc) is redundant; Arc(Iso) is contradictory (the "single-shot rendezvous" reading belongs to a dedicated `Oneshot(T)` primitive, not Arc). Transitive nesting through a user struct stays legal. See Phase H.
7. ~~Phase C atomic wrapping~~ — **resolved:** use libc's existing `atomic_int` (and friends) as the field type inside `atomic object`, i.e. `AtomicI32 :: atomic object((*) : atomic_int)`. No new `atomic T` field modifier; no compiler change. Phase C is pure library work. See Phase C.
8. ~~Mutex re-entrant lock semantics~~ — **resolved:** deadlock + doc warning, matching Rust's `std::sync::Mutex`. No thread-id check, no recursion counter. Document the footgun in `docs/{en-US,zh-CN}/THREAD_SAFETY.md`.
9. ~~`JoinHandle(T)` Send~~ — **resolved:** `JoinHandle(T)` is NOT Send. Yo's async/await is single-threaded; `JoinHandle` is the OS-thread analogue and stays thread-pinned for symmetry with `Future`. Cross-thread result delivery uses `Channel(T)`. See Phase L.
10. ~~Phase A migration audit~~ — **resolved (audit performed):** 6 files in std/ carry manual `impl(T, Send/Acyclic())` impls. 5 of 6 already have `pragma(Pragma.AllowUnsafe)` at the top (`std/prelude.yo`, `std/imm/sorted_map.yo`, `std/imm/list.yo`, `std/sync/cond.yo`, `std/sync/mutex.yo`). **1 file is missing the pragma:** `std/string/rune.yo:96` has `impl(rune, Send());` with no pragma. Phase A's first sub-task is to add the pragma + `// SAFETY:` comment to `std/string/rune.yo`. No widespread migration needed.
11. ~~`Once` non-atomic fast-path~~ — **resolved:** closed in Phase D. Switch `_done` to `atomic_bool` with Acquire-load on the fast path and Release-store on completion.
12. ~~`Iso(T)` unconditional Send rationale~~ — **resolved:** rationale paragraph added to the soundness section above ("Why `Iso(T)` is unconditionally `Send`").
13. ~~`Channel(T)`'s `T <: Send` bound in trust boundary table~~ — **resolved:** added to the User code row of the trust boundary table.

## Rough effort estimate

| Phase                                                                               | Effort   | Risk                                    |
| ----------------------------------------------------------------------------------- | -------- | --------------------------------------- |
| A — gate manual Send/Acyclic + 1-file migration                                     | 2–3 days | Low; mechanical                         |
| B — no-op (B1)                                                                      | 0        | None                                    |
| C — typed Atomic wrappers (pure library, no compiler change)                        | 3–4 days | Low; thin wrappers over libc atomics    |
| D — closure-scoped lock APIs + Once fast-path closure                               | 5–7 days | Medium — biggest API rewrite            |
| E — per-variable closure Send check                                                 | 2 days   | Low                                     |
| F — atomic-object re-verification                                                   | 1 day    | Low                                     |
| G — codegen pin tests + TSan CI                                                     | 2–3 days | Low                                     |
| H — Iso runtime tightening + API-surface lock-down + ban Iso/Arc direct composition | 2 days   | Low                                     |
| I — audit `Dyn(...)` cross-thread sites, add `, Send`                               | 1 day    | Low; no new syntax                      |
| ~~J — Drop thread-portability~~                                                     | 0        | dropped — safe by design                |
| ~~K — `immutable` modifier~~                                                        | 0        | dropped — audit boundary suffices       |
| N — Negative trait impls (`impl(T, !(Trait))`)                                      | 2 days   | Low; small parser/evaluator change      |
| L — JoinHandle/Io get `!(Send)` impl; Future docs + audit migration                 | 1 day    | Low; depends on Phase N                 |
| O — Forbid atomic-object field writes in safe code                                  | 1–2 days | Low; one predicate, two call sites      |
| P — `_`-prefix enforced as file-private field visibility                            | 1–2 days | Low; localized to field-access resolver |
| M — diagnostics + docs                                                              | 3–4 days | Low                                     |

Total: **~3 working weeks** for v1 (after dropping J, K). Phases N and P are the two new language features in this plan; everything else is library, codegen, or analysis work. Phase A and Phase D remain the architecturally important ones. Phase F is the belt-and-suspenders that closes the `atomic object`-wraps-`object` concern. Phase N + L together close the load-bearing `JoinHandle`/`Io` auto-derive hole at zero runtime overhead. Phase O + P together close the direct-field-mutation and synchronized-interior-read holes — O for the cross-thread write side, P for the synchronized-interior read side and universal encapsulation.
