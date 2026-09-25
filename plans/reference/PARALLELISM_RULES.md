# Parallelism rules

**Status:** DECIDED 2026-09-25 by the parallelism-soundness audit
(`plans/PARALLELISM_SOUNDNESS.md`); each rule below says whether it has LANDED. A rule that has
not landed is the contract the code is being brought to, not a description of the code — the
audit measured every one of them as violated on develop `e9b159709`. When a phase lands, edit
that rule's status line and nothing else here.

These rules are what makes the user-facing guarantee in `docs/en-US/THREAD_SAFETY.md` true:

> For every program that compiles without `pragma(Pragma.AllowUnsafe)` and uses only primitives
> from `std/`, every shared cross-thread mutable access is mediated by a synchronization
> primitive. The program is data-race-free under the C11 memory model.

## D1 — Module-level runtime bindings must be thread-safe

**Status:** PLANNED (Phase 3).

A module-level `name := value` or `(name : T) = value` binding is one static shared by every
thread of the process. In a file without the pragma:

- its type must be `Send`, and a type that is or contains a NON-atomic reference-counted value
  (any `ref(struct)` / `ref(enum)`, `String`, `ArrayList`, `HashMap`, a closure with captures)
  is a compile error — "immutable after init" is not enough, because READING a field through a
  non-atomic handle performs reference-count traffic
  (`issues/std-html-entity-tables-are-non-atomic-globals-read-from-every-thread.md`);
- a scalar or value-type global that is ASSIGNED anywhere in the module is a mutable static and
  is a compile error too.

The diagnostic points at the alternatives: `thread_local(name)` for per-thread state
(`plans/reference/THREAD_LOCAL_STORAGE.md`), an atomic object (`Mutex(T)`, `Arc(T)`, `Atomic*`)
for shared state, or a value with no reference inside for a constant. Pragma'd files keep
today's behaviour and carry the audit burden (std's `std/log.yo` globals are under a mutex;
`std/encoding/html.yo` is rewritten to comply). Rationale: Rust's `static: Sync` rule.

## D2 — `Iso(T)` is constructed only through `^`, `T` must contain a reference, uniqueness is deep

**Status:** PLANNED (Phase 2; the deep walk is seed-gated).

- In a file without the pragma, `Iso(T)(v)` is not callable; `^v` is the constructor.
- `Iso(T)` requires a `T` that contains a reference-counted type (so `Iso(i32)` is a type
  error) and may not contain an `Arc` or another `Iso`.
- Uniqueness is checked at CONSTRUCTION and it is DEEP: the emitted `__yo_iso_unique_<T>` walks
  every reachable non-atomic object (the same field list the tracer functions use; an atomic
  object, a scalar or a `str` leaf stops the walk) and fails if any has `ref_count != 1`. On
  failure `^v` is `.None`. The walk runs on the sending thread, where every reachable non-atomic
  refcount is stable, so the check is race-free. `Isolation.can_isolate` becomes an optional
  fast path a type may provide, never the whole check.
- `extract()` keeps its one-shot flag and ALSO checks the wrapper's own `ref_count == 1`
  (acquire load), so a copied `Iso` that the sending thread still holds panics instead of
  handing out a second owner.

Rejected alternative: bounding `Iso(T)` on an interior-`Send` `T` — that removes the feature,
whose whole point is moving a non-`Send` graph to one other thread.

## D3 — No writes through an atomic object, at every mutation site

**Status:** LANDED 2026-09-26 (Phase 1): `throw_if_write_through_atomic_root` in
`src/evaluator/exprs/assignment.yo`, called from the assignment arm and both argument-binding
sites in `src/evaluator/calls/`.

An expression whose ROOT binding is an atomic object (an `Arc`, a `Mutex`, any
`atomic(ref(...))`) may not, in a file without the pragma, be:

- the target of `=`, whether a field (`a.*.n = v`) or an index (`a.*(0) = v`) — always;
- an argument bound to an `inout(...)` parameter (`bump2(a.*)`), or the receiver of a method
  whose `self` is `inout(self)` (`a.*.bump()`), **when the callee may write through that
  parameter**. `inout` is also Yo's plain by-reference receiver (`ToString`, `Hash`,
  `Sender.clone`), so the decision comes from the callee's per-parameter mutation mask
  (`src/evaluator/effects/mutation_summary.yo`: a field/index store, an RC decrement, a
  mutating callee, or anything unresolvable — a MAY-analysis), taken after the specialized
  callee is known. A callee defined in a pragma'd file is the audited base and is trusted.

`Mutex.with_lock`'s `inout(v)` is a PARAMETER root, not an atomic root, so writes through `v`
stay legal; a local copy `c := a.*` is a value, so `c.bump()` stays legal; `${a.*.n}` and a
read-only `inout(self)` method through an `Arc` stay legal. The diagnostic is the Phase O one,
with "the callee may write through that inout parameter" on the call forms.

## D4 — A closure type is `Send` iff its capture struct is, wherever the question is asked

**Status:** PLANNED (Phase 4).

Rust's auto-trait rule, applied uniformly: at the spawn boundary (already), and when a
`where(T <: Send)` / `where(T <: Acyclic)` is discharged with `T` instantiated from a closure
type (`arc(f)`, `Channel(typeof(f))`, a generic `g(f)`). A bare `fn` pointer with no capture
info stays `Send` and `Acyclic`.

## D5 — `std/sync` primitives trap, never UB

**Status:** LANDED 2026-09-26 (Phase 5): owner records in `Mutex(T)`, `RawMutex` and `Once`
(`std/sync/{mutex,cond,once}.yo`); the pool's submission lock is process-wide (`std/thread.yo`).

Every lock records its owner thread (`__yo_thread_self()`). In every primitive, on every
platform, the following are a panic with a message naming the API, never undefined behaviour
and never a platform-dependent difference:

- `unlock` by a thread that does not hold the lock;
- `lock` by the thread that already holds it (self-relock);
- `Cond.wait_with(m)` / `wait_timeout_with(m)` without holding `m`, or holding it more than
  once;
- `Once.call` / `OnceCell.get_or_init` re-entered from its own initializer.

Recursion on a Windows `CRITICAL_SECTION` is masked by the owner check so that observable
behaviour is identical to POSIX.

## D6 — Calling an `extern`-bound function is a safe-mode violation unless the calling file has the pragma

**Status:** PLANNED (Phase 4).

Naming or importing an extern (its type flows through `std`'s wrappers) stays legal; CALLING it
from a file without `pragma(Pragma.AllowUnsafe)` is the same violation as `unsafe(...)`.
Declaring one already requires the pragma; this closes the re-export route
(`issues/safe-code-reaches-pragmad-runtime-externs-through-std-sys-externs.md`).

## D7 — A loop never observes `live_wakers == 0` while a post it will receive is in flight

**Status:** PLANNED (Phase 6).

The foreign `Waker` release decrements the owner's `live_wakers` in the OWNER's drain, after the
post has been consumed, never on the releasing thread before the post. The same ordering applies
to `__yo_async_blocking_end`: notify, then decrement. This is what keeps a spawned thread's loop
alive until every cross-thread message addressed to it has been processed.

## D8 — Closures may not capture second-class bindings

**Status:** PLANNED (Phase 4).

A closure that captures an `inout(...)` or `ref(...)` parameter, or any control-bound value, is
a compile error at the capture token. This is `plans/reference/MEMORY_SAFETY.md` Phase B's rule
restated as an evaluator check; it is what makes `Mutex.with_lock`'s `inout(v)` unable to
escape the critical section.
