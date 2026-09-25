# Parallelism soundness: make data-race freedom true for safe code

**Status:** ACTIVE, proposed 2026-09-25. Phases 0, 1, 3 and 5 LANDED 2026-09-26 (the per-phase "Landed" notes below); Phases 2, 4, 6, 7, 8 open. Source: a full audit of Yo's
parallelism surface — the `Send`/`Acyclic` marker rules, `Iso(T)`, atomic objects and the
Phase O write gate, `std/thread`, every `std/sync` and `std/async` primitive, `std/imm`, the
module-global inventory of `std`, the spawn lowering, the atomic-RC/GC runtime and the
cross-thread wake path — measured with the v0.2.41 seed against the develop tree's `std`
(`--std-path`) on macOS arm64, develop `e9b159709`. Every finding is filed under `issues/`; this
document is the roadmap for fixing them. It supersedes the soundness claims of
`plans/archive/THREAD_SAFETY.md` (a correction banner there points here) and owns Phase 5 items
3 and 4 of [`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md) by agreement with that
session (2026-09-25).

**Goal.** The user-facing guarantee in `docs/en-US/THREAD_SAFETY.md` —

> For every program that compiles without `pragma(Pragma.AllowUnsafe)` and uses only primitives
> from `std/`, every shared cross-thread mutable access is mediated by a synchronization
> primitive. The program is data-race-free under the C11 memory model.

— is today false in eleven distinct ways, four of them memory-unsafe from safe code. The goal is
that it becomes true, that the compiler is the gate (not a C compiler error or a runtime
accident), and that a ThreadSanitizer run over the thread corpus is the standing proof.

---

## 1. The surface that was audited

| Layer | What | Where |
| --- | --- | --- |
| Marker traits | `Send`, `Acyclic`, negative impls, structural auto-derive, the pragma gate on manual impls | `std/prelude.yo` (~234-260, ~6774-6866, ~9455-9550, ~11990-12034), `src/evaluator/trait_checking.yo` (~330-400, ~800-910), `src/evaluator/types/struct.yo` |
| Spawn boundary | per-capture `Send` check, declared-bound exemption, captured closures | `src/evaluator/utils/closure.yo` (`validate_capture_trait_requirements`, `_capture_judgement_type`, `_declared_bound_requires`) |
| Atomic objects | Phase O write gate, `Arc`, `atomic(ref(...))` field rules | `src/evaluator/exprs/assignment.yo` (`get_atomic_object_root_type`), `std/prelude.yo` `Arc` |
| `Iso(T)` | the `^` macro, `Isolation`, the constructor, `extract`, the emitted wrapper | `std/prelude.yo` (~9449-9530), `src/evaluator/builtins/rc_fns.yo` (~240), `src/codegen/exprs/iso.yo`, `src/codegen/types/generation.yo` (~1529-1690) |
| Threads | `Thread(T)`, `ThreadPool`, `spawn`, `spawn_blocking`, the spawn lowering, the thread/worker C runtime | `std/thread.yo`, `src/codegen/exprs/parallelism.yo`, `src/codegen/parallelism/runtime.yo` |
| Sync primitives | `Mutex`, `RawMutex`, `RwLock`, `Cond`, `Once`/`OnceCell`, `Semaphore`, `Barrier`, `WaitGroup`, `Atomic*`, `Channel`/`Sender`/`Receiver` | `std/sync/*.yo`, the C macros in `src/codegen/types/generation.yo` (~600-950) |
| Async | `std/async/{channel,mutex,waker,stream}`, `Park`/`Waker`, the cross-thread wake inbox | `src/codegen/async/runtime_core.yo` (~100-200, ~460-500, ~600-800) |
| Immutable sharing | `std/imm/*` `Send`/`Acyclic` claims, unique-owner in-place mutation | `std/imm/*.yo` |
| Globals | every module-level runtime binding in `std`, `thread_local` | `std/log.yo`, `std/rand.yo`, `std/encoding/html.yo`; `plans/reference/THREAD_LOCAL_STORAGE.md` |
| Runtime | atomic vs non-atomic RC dispatch, per-thread GC and atomic objects, thread entry/exit, allocator thread-safety | `src/codegen/functions/gc_runtime.yo`, `src/codegen/exprs/drop_dup.yo`, `src/codegen/c/allocator_fixed.yo` (see §3, P-13 onward) |
| Docs and tests | the claims in `docs/{en-US,zh-CN}/{THREAD_SAFETY,ISOLATED,PARALLELISM,ARC}.md`; `tests/thread_safety.test.yo`, `tests/thread*.test.yo`, `tests/sync/*`, `tests/iso*.test.yo`, `tests/cross_thread_wake.test.yo`, `tests/imm_threading.test.yo` | |

Probe programs (all standalone, all under `issues/repros/` where a finding came out of them)
were checked with `yo check <file> --std-path ./std` and run with
`yo compile --optimize 2 [--allocator system]` and `MallocScribble=1`.

## 2. The documented model, and which parts hold

`plans/archive/THREAD_SAFETY.md` reduces soundness to three trusted bases. Their status:

1. **`std/sync` primitives are correctly implemented.** Mostly true: every plain field of every
   atomic object is touched only under its lock or through an atomic (the sub-audit's coverage
   list is reproduced in §4), orderings are right, `Channel`'s ownership transfer is exact,
   `imm`'s in-place mutation is guarded by `rc == 1` on an `own(self)`. FALSE at the API edge:
   `RawMutex` and `Cond.wait_with` let a pragma-free file reach C-level undefined behaviour
   (P-5, P-6), `Once` re-entrancy diverges by platform into a race (P-8), and `ThreadPool`'s
   barrier is defeated by a second pool (P-7).
2. **The compile-time RC analysis is sound, so a capture is one of (a) plain value, (b) shared
   synchronized primitive, (c) `Iso`.** The capture-site check is right (every direct shape
   tried — ref struct, `ArrayList`, `Io`, `JoinHandle`, `Dyn` without `Send`, a struct or a
   closure holding any of them — is rejected). But the "no fourth path" claim has four fourth
   paths: writes through an `Arc` via `inout` (P-1), the `Iso` constructor (P-2), module
   globals (P-3 of the type-system audit; P-10 here for `std`'s own), and a closure TYPE
   satisfying a `where(T <: Send)` (P-4, check-only today).
3. **Codegen's atomic-RC ops use the right orderings.** True for `__yo_incr_rc_atomic`
   (relaxed) / `__yo_decr_rc_atomic` (acq_rel). The runtime layer beneath it has two ordering
   holes in the cross-thread wake path (P-11, P-12) and — see §3 — the items the runtime
   sub-audit adds.

The `Iso(T)` argument deserves its own line because every doc repeats it: *"extract()
atomically verifies rc == 1"*. The emitted `extract` checks a one-shot flag and nothing else;
the only refcount check in the design is `Isolation.can_isolate` at construction, and only `Box`
implements `Isolation`. The unconditional-`Send` claim for `Iso(T)` therefore rests on nothing
today.

## 3. Findings

Severity: **U** = memory-unsafe / UB reachable from safe code, **R** = data race in safe code
(defined-behaviour-wise a race, no proven crash), **C** = `yo check` accepts what the model
forbids but codegen or the C compiler happens to reject, **L** = liveness / leak, **D** = docs
or diagnostics only.

| # | Sev | Finding | Issue | Phase |
| --- | --- | --- | --- | --- |
| P-1 | R | `a.*.bump()` (`inout(self)`), `bump2(a.*)` (`inout` arg) and `a.*(0) = v` all write through an `Arc` in safe code; only `a.*.f = v` is rejected. Printed `n=11`. Vector 26 of the old plan never landed. | `phase-o-atomic-write-gate-misses-inout-receivers-arguments-and-index-assignment` | 1 |
| P-2 | U | `Iso(T)(v)` is a public unchecked constructor; `extract()` checks only a one-shot flag; `Isolation` exists only for `Box`. Aliased interior across threads: SIGSEGV 5/5. `Iso(i32)(5)`: SIGSEGV with no threads. Docs describe the TypeScript-era model. | `iso-constructor-is-unchecked-and-extract-verifies-no-uniqueness`, `iso-checks-only-the-wrapper-refcount-not-the-interior` | 2 |
| P-3 | R | A module-level `:=` binding is a mutable static reachable from every spawned closure; `fill()` pushing to a global `ArrayList` from two threads is green. | `module-globals-bypass-send-so-safe-code-can-data-race` (type-system audit) | 3 |
| P-4 | C | `arc(f)` and `Channel(typeof(f))` accept a closure whose capture is an `ArrayList`; the `where(V <: Send)` is discharged on the closure TYPE (`.Func` answers `Send` unconditionally in `trait_checking.yo`). clang rejects the emitted C by accident. | `a-capturing-closure-type-satisfies-a-send-bound-so-arc-and-channel-accept-it-at-check` | 4 |
| P-5 | U | `Cond.wait_with(m)` / `wait_timeout_with` never check that the caller holds `m`: `pthread_cond_wait` on an un-owned mutex, `SleepConditionVariableCS` on a twice-entered CS. | `cond-wait-with-does-not-check-that-the-caller-holds-the-mutex` | 5 |
| P-6 | U | `RawMutex` is exported; `unlock` without `lock`, or from another thread, is UB; self-relock is a POSIX hang and a Windows re-entry. | `rawmutex-is-exported-with-an-unbalanced-unlock` | 5 |
| P-7 | L | `ThreadPool.join_all`'s sentinel barrier relies on a process-global round-robin serialized only per pool; a second pool's `spawn` interleaves and a worker gets no sentinel. `shutdown` checks `_closed` outside the lock. | `threadpool-join-all-barrier-is-defeated-by-a-second-pool-and-shutdown-races-spawn` | 5 |
| P-8 | R | `Once.call` / `OnceCell.get_or_init` re-entered from `f`: POSIX deadlock, Windows runs `f` twice and overwrites `_value` after `_done` is published. | `once-re-entered-from-its-own-closure-deadlocks-on-posix-and-double-runs-on-windows` | 5 |
| P-9 | D→U | A safe file can `import("std/sys/externs.yo")` and call raw `__yo_*` runtime entry points (`__yo_async_blocking_begin()` is green). | `safe-code-reaches-pragmad-runtime-externs-through-std-sys-externs` | 4 |
| P-10 | R | `std/encoding/html`'s `_entity_map` / `_legacy_set` are non-atomic RC globals; `HashMap.get` dups/drops the bucket key, so two threads calling `html_decode` race on a `String` refcount. Verified in emitted C; not observed in 3 × 300k runs. | `std-html-entity-tables-are-non-atomic-globals-read-from-every-thread` | 3 |
| P-11 | U | A foreign `Waker` release decrements `live_wakers` BEFORE it posts; a loop on a spawned thread can see nothing pending, exit `wait_all`, tear down and let its thread die while the post is in flight into its `_Thread_local` loop struct. | `a-foreign-waker-release-can-post-into-a-loop-whose-thread-has-exited` | 6 |
| P-12 | L | Drain loads `release_pending` before clearing `queued`; a release that lands between sees a failed CAS, both sides unref, the token is freed and the park future's reference is never dropped. | `a-foreign-waker-release-racing-the-owners-drain-leaks-the-park-future` | 6 |
| P-13 | C | A closure capturing the `inout(v)` parameter of a `with_lock` body passes check (the closure is then stored past the unlock); codegen emits an undeclared call. The lock-escape argument (vector 15) rests on this rule and the evaluator does not enforce it. | `a-closure-capturing-an-inout-lock-body-parameter-passes-check` | 4 |
| P-14 | D | `Waker.is_woken` reads `t->future` (owner-written plain pointer) from any thread; documented as diagnostics-only, still a race. | folded into P-11's issue text; fix in Phase 6 | 6 |
| P-15 | D | `std/async/mutex.with_lock` has no unlock guard for an `unwind` out of `body`; moot today because a closure cannot capture a control-bound value (`issues/with-lock-and-with-permit-cannot-see-an-unwind.md`), listed so the guard is added when that changes. | existing issue | 6 |
| P-16 | D | Doc drift: `THREAD_SAFETY.md` §Iso ("rc == 1 at extract"), `ISOLATED.md` (TypeScript-era: `Option(T)` results, `isOwningTheSameRcValueAs`, `printf`), `PARALLELISM.md` "Sendable types" (`Dyn` — `Dyn(Trait, Send)` IS sendable), `mutex.yo` `is_unlocked` on Windows, `once.yo` re-entrancy, `semaphore`/`waitgroup` counter wrap (traps, by design), copying a `pthread_mutex_t` by value (works on the three platforms; not portable in principle). | no separate issue; Phase 0 and Phase 8 | 0, 8 |
| P-17 | R | `Iso(T)(Wrap(items : shared))` — a NON-variable constructor argument — runs none of the evaluator's three ownership checks; the checks in `src/evaluator/calls/iso.yo` fire only for a named variable. | folded into P-2's issue | 2 |
| P-18 | R | `__yo_borrow_acquire`/`release` are emitted for an ATOMIC container and do a plain `borrow_count++/--`; and a user `Index` impl with `inout(self)` panics on its own caller's borrow with one thread (rc 134, measured). | `borrow-count-on-an-atomic-object-is-non-atomic-and-a-user-index-impl-panics-on-it` | 1, 6 |
| P-19 | R | `rc(x)` on an `Iso` or `atomic(ref(enum))` handle is a plain load of a word other threads update with `__yo_decr_rc_atomic`. | `rc-of-an-iso-or-atomic-enum-handle-is-a-plain-load` | 6 |
| P-20 | R | Windows: the worker pool mutex is lazily initialized with `if (!flag) { InitializeCriticalSection; flag = 1; }`; two first submissions race into a double init. | `windows-worker-pool-mutex-lazy-init-is-a-check-then-init-race` | 6 |
| P-21 | R | Windows: the socket-fd registry is an unlocked process-global list, touched by every thread's event loop. | `windows-socket-fd-registry-is-an-unlocked-process-global-list` | 6 |
| P-22 | R | macOS: `__yo_io_notify` reads `notify_ready`/`notify_handle` unsynchronized against `__yo_io_cleanup` clearing them (Linux holds `loop->lock`). | `macos-io-notify-races-io-cleanup-on-the-notify-handle` | 6 |
| P-23 | L | The pool's `atexit` shutdown joins every worker; a task blocked forever hangs `exit()`; `exit()` from inside a task joins itself. The "free queued closures" loop is dead code that would leak captures. | `worker-pool-atexit-shutdown-joins-workers-blocked-in-a-task` | 6 |
| P-24 | L | Windows: `TlsAlloc` has no destructor, so a thread's GC state is never released at thread exit. | `windows-thread-gc-state-is-never-released-at-thread-exit` | 6 |
| P-26 | C | `arc(f)` / `Channel(typeof(f))` of ANY closure, `Send` or not, emits two capture-struct typedefs for the one closure and fails in clang — the accident behind P-4's "rejected today", and a blocker for D4's legal shape. Found writing the Phase 0 corpus. | `arc-of-a-send-closure-emits-two-capture-struct-typedefs` | 4 |
| P-25 | D | `__yo_async_strict_cached` is a plain `static int` written by whichever thread first reads the env var (idempotent; TSan will report it). | Phase 6, no issue | 6 |

## 4. What is sound today (so the plan does not re-audit it)

- **Direct capture rejection** at `Thread.spawn` / `spawn(pool, …)` / `spawn_blocking` for a
  `ref(struct)`, `ArrayList`, `String`, `Io`, `JoinHandle`, `Dyn(Trait)` without `Send`, a value
  struct or a captured closure holding any of those; acceptance of scalars, `Arc`, atomics,
  `Dyn(Trait, Send)`, closures over atomics, and a parameter DECLARED `Impl(Fn, Send)`.
- **Structural `Send` derivation**: value structs/enums/tuples need every field `Send`; a
  non-atomic object never derives it; an atomic object needs every field `Send` at definition;
  `Option`/`Result`/`Array`/enum payloads of a non-Send type are non-Send (measured);
  `Pair(i32)` vs `Pair(ArrayList)` are answered independently (no memo poisoning across
  instantiations, measured); negative impls (`JoinHandle`, `Io`) win over derivation; a manual
  `impl(X, Send())` or `impl(X, Acyclic())` needs the pragma (both measured); `dyn(v)` for
  `Dyn(Trait, Send)` checks the concrete type; `where(T <: Send)` is discharged at the call for
  nominal types.
- **Closure captures are by value** (`n = 5` inside a spawned closure leaves the parent's `n`
  at 0, measured), so a captured local is never a shared location.
- **`Mutex(T)`/`RwLock`/`Semaphore`/`Barrier`/`WaitGroup`/`Once` bodies**: every plain field
  only under the lock or through an atomic; guards created after the lock is held and
  released on every reachable path; `with_read` binds by value; predicates re-checked around
  every condvar wait; `Dispose` cannot run while a guard or a blocked waiter holds a handle.
  `ThreadPool`'s `_held`/`_owner` re-entrancy protocol is correct for a single pool.
- **`Atomic*`**: every op is the right C11 op with the caller's order; illegal orders trap;
  wide-type RMWs use CAS loops with `wrapping_*`; a copy of an `AtomicI32` is a shared handle
  and no `Clone` exists to make two counters silently.
- **`Channel`**: all queue state under the mutex; `send` moves in, `recv` moves out, `Dispose`
  drops queued values and frees the buffer on the last handle's thread (sound because `T` is
  `Send`); `Sender` counting is Arc-shaped (relaxed add, acq_rel sub, the thread reading 1
  closes).
- **`std/async`** primitives and `Thread(T)` are non-atomic `ref` objects and therefore
  non-Send: misuse across threads is a compile error. `Waker` is atomic and Send; the token
  refcount fix (`issues/fixed/a-waker-token-is-freed-while-back-on-the-inbox.md`) holds for
  the handle/inbox pair (P-11/P-12 are the two orderings around it).
- **`std/imm`**: no manual `Send`; every `Acyclic` claim backed by no post-construction
  writes; unique-owner mutation gated by `rc(self) == 1` on `own(self)`.
- **Globals in std**: `std/rand` (thread-local), `std/log` (all reads and writes under
  `_log_mutex`) are fine; `std/encoding/html` is P-10.
- **Spawn lowering**: the capture struct is heap-copied and field-dup'd, not a shared RC
  object, so nothing about the wrapper itself is a shared refcount; captured atomics are
  dup'd/dropped atomically; the `Thread(T)` relay releases the wrapped `cb`.
- **Atomic objects never enter the cycle collector**: constructors gate `__yo_gc_register` on
  `!is_atomic`, never set a `traverse_fn` for them, the field-traversal emitter does not
  descend an atomic edge, every collector visitor early-returns on an untracked header, and
  `__yo_cleanup_thread_gc`'s force-dispose walks the tracked list only — so thread A's GC can
  neither read, mutate nor free an atomic object thread B holds (verified at the cited emitter
  lines; `src/codegen/functions/constructors.yo` ~131-199, ~515-620; `gc_runtime.yo` ~753-1054).
- **Atomic-vs-non-atomic RC dispatch is by static type and holds across every erased shape
  tried**: a generic `own(x) : T` at `T = Arc`, `Option(Arc)`, `Array(Arc, 2)`, a tuple, a value
  struct field, a value enum payload, `ArrayList(Arc)` element drops, `Box(Arc)` and
  `Arc(struct(a : Arc))` disposes all emit `__yo_*_atomic`; the `Iso` wrapper's own RC is
  atomic on both threads; the spawn wrapper's field drops are atomic; `Dyn` boxes are
  non-atomic RC but cannot cross a thread (a `Dyn(Trait)` capture is rejected and
  `Dyn(Trait, Send)` cannot be formed from a non-Send concrete type).
- **The `--allocator fixed` TLSF heap is locked** (`atomic_flag` acquire/release around
  malloc/calloc/realloc/free, `src/codegen/c/allocator_fixed.yo` ~117-536); the system and
  mimalloc paths are thread-safe by contract, so a final release on a foreign thread is fine.
- **Plain-`static` census of the emitted runtime**: everything per-loop is `_Thread_local`;
  `__yo_threads_ever_spawned` is `_Atomic`; the GC thread list is under its mutex; the pool
  array/counter/initialized flag are written under the pool mutex or at exit; the exceptions
  are P-20, P-21 and P-25.
- **`thread_local(...)` bindings** carry `_Thread_local` storage AND a `_Thread_local` init
  flag; the accessor touches only the calling thread's pair.
- **Cross-thread hand-off of a non-atomic graph built on the child** (an
  `ArrayList(String)` of 1000 entries returned through `Iso`, read after the child exited)
  works and shows no scribbled memory — the feature the `Iso` redesign must keep.

## 5. Decisions to record in `plans/reference/` (one file, `PARALLELISM_RULES.md`, written by Phase 0)

- **D1 — Module-level runtime bindings must be thread-safe.** A module-level `:=` / `(x : T) =`
  binding is a static shared by every thread. In safe code its type must be `Send`, and a
  binding of a NON-atomic type that contains a reference (any `ref(struct)`, `String`,
  `ArrayList`, a closure with captures) is a compile error with the hint "use
  `thread_local(name)` for per-thread state, an atomic object (`Mutex(T)`, `Arc(T)`, `Atomic*`)
  for shared state, or a value with no reference inside". A `Send` value type is allowed; the
  Phase O rule already forbids writing its fields through an atomic root, and a plain scalar
  global ASSIGNED anywhere (`counter = counter + 1`) is a mutable static: also an error unless
  `thread_local`. Rationale: Rust's `static: Sync` rule; the READ-side RC traffic of P-10 is
  why "immutable after init" is not enough for non-atomic objects. Pragma'd files keep today's
  behaviour (std's `_log_mutex` globals are atomic; `std/encoding/html` is fixed to comply).
- **D2 — `Iso(T)` is constructible only through `^v` / `iso(v)`, `T` must contain a reference
  type, and uniqueness is DEEP and checked at construction.** The emitted
  `__yo_iso_unique_<T>` walk visits every reachable non-atomic object (the same field list the
  tracer functions use; an atomic object or a scalar leaf stops the walk) and fails if any has
  `ref_count != 1`; on failure `^v` is `.None`. `extract()` keeps the one-shot flag and gains
  the wrapper `ref_count == 1` check the docs promise. Cost O(graph) once per hand-off, on the
  sending thread, where every reachable non-atomic refcount is stable. `Isolation` becomes an
  optional FAST PATH (a type may declare `can_isolate` to skip the walk), never the whole check.
  Rejected alternative: `Iso(T)` bounded on an interior-`Send` `T` — that removes the feature.
- **D3 — "No writes through an atomic object in safe code" is a rule about ROOTS, applied at
  every mutation site.** An expression whose root binding is an atomic object may not be the
  target of `=` (field or index), an `inout(...)` argument, or an `inout(self)` receiver.
  `Mutex.with_lock`'s `inout(v)` is a parameter root, not an atomic root, so it stays legal.
- **D4 — A closure type is `Send`/`Acyclic` iff its capture struct is, wherever the question is
  asked**, not only at the capture site. A bare fn pointer with no capture info stays `Send`.
- **D5 — `std/sync` primitives trap, never UB.** Every lock records its owner thread
  (`__yo_thread_self()`); unlock-by-non-owner, self-relock, `wait_with` without holding the
  mutex (or holding it twice), and `Once` re-entrancy panic with a message naming the API, on
  every platform. Recursion on Windows `CRITICAL_SECTION` is masked by the owner check so the
  observable behaviour is identical across platforms.
- **D6 — Calling an `extern`-bound function is a safe-mode violation unless the CALLING file has
  the pragma.** Naming/importing stays legal (types flow), calling does not. Same gate as
  `unsafe(...)`.
- **D7 — A loop never observes `live_wakers == 0` while a post it will receive is in flight.**
  The foreign release's decrement moves to the owner's drain.
- **D8 — Closures may not capture second-class bindings** (`inout`/`ref` parameters, control-
  bound values) — the MEMORY_SAFETY Phase B rule restated as an evaluator check at the capture
  token.

## 6. Phases

Each phase is one PR (or a short stack), lands with its tests, and moves its issues to
`issues/fixed/`. Files named are the ones the audit read; line numbers are as of develop
`e9b159709`.

### Phase 0: truth in docs, the corpus, and the decisions file (S)

1. Write `plans/reference/PARALLELISM_RULES.md` with D1–D8 as they will land (each later phase
   edits its own paragraph to "landed").
2. `docs/{en-US,zh-CN}/THREAD_SAFETY.md`: replace the `Iso` paragraph with the honest current
   state ("uniqueness is checked at construction for `Box`; the constructor is unchecked;
   redesign in progress"), add a "Known holes" list mirroring §3 with the issue paths, and
   correct the trust-boundary table row "Atomic-object writes rejected" to "field assignment
   rejected; `inout` and index writes are P-1". `docs/{en-US,zh-CN}/ISOLATED.md`: rewrite to
   the self-hosted model (`extract` returns `T`, panics on a second call; no `Option`; no TS
   field names). `PARALLELISM.md` "Sendable types": `Dyn(Trait, Send)` is sendable.
3. Create `tests/parallelism_soundness.test.yo`: one `comptime_expect_error` block per
   rejection the later phases add (P-1 ×3, P-2 ×2, P-3 ×2, P-4 ×2, P-9, P-13) and one
   over-rejection canary per rule (`with_lock` body mutating `v`, a local copy `c := a.*;
   c.bump()`, `arc` of a closure over an atomic, a `thread_local` global, a `Send` value-type
   global read from two threads). Land it with the blocks for unfixed rules wrapped in the
   file's TODO convention so the file is green, and each phase un-wraps its blocks. Because
   `check` on a `.test.yo` is hollow without `--test-bodies`
   (`issues/fixed/…` / memory), the CI invocation is `yo test` on that one file.
4. Exit: docs make no claim the code does not keep; the corpus file exists and is green.

**Landed 2026-09-26** (PR: the `ps/phase0-docs-corpus` branch). `plans/reference/PARALLELISM_RULES.md`
holds D1–D8 with per-rule status; `THREAD_SAFETY.md`, `ISOLATED.md` and `PARALLELISM.md`
rewritten in both languages (the "Known Holes" section is the list each phase shrinks);
`tests/parallelism_soundness.test.yo` lands with the two rejections that already hold and one
canary per rule — no wrapped/skipped blocks: each phase ADDS its rejection blocks. One deviation
from the plan text: the D4 canary is a `where(T <: Send)` call, not `arc(bump)`, because
`arc` of any closure fails in clang today (P-26, filed during this phase).

### Phase 1: complete the atomic-write gate (P-1) (S–M, evaluator only)

- `src/evaluator/exprs/assignment.yo`: `get_atomic_object_root_type` takes the root atom of a
  field chain; factor the "walk any field/index/deref chain to its root and ask this" step
  into a helper both the property arm (today) and the index-assignment arm (new) call.
- `src/evaluator/calls/` (the site that binds arguments to `inout(...)` parameters and the
  implicit `self` of a method call — the same site the type-system plan's Phase 5.2 `inout`
  exclusivity rule will use; coordinate on the helper name): reject an argument whose root is
  an atomic object in a pragma-free file with the existing Phase O diagnostic text.
- Tests: the three `comptime_expect_error` blocks and two canaries in the corpus file;
  `tests/thread_safety.test.yo` keeps its existing read/construct tests.
- Exit: `issues/repros/phase-o-*.yo` both fail `check`; `yo check ./std` and `yo check ./src`
  unchanged (std is pragma'd; the compiler tree uses no `Arc` receivers — verify with the
  fresh binary, since the seed cannot see a new evaluator gate).

**Landed 2026-09-26** (branch `ps/phase1-atomic-write-gate`, stacked on Phase 0). NOT the shape
above: "every `inout` binding is a write" rejected `${a.*.id}` (`ToString` takes `inout(self)`),
`Sender.clone` and every read-only `inout(self)` method — `inout` is Yo's by-reference receiver,
not a mutation marker. What landed: the binding is recorded at the two argument-binding sites and
decided after the (specialized) callee is known, against the per-parameter mutation mask of
`effects/mutation_summary.yo` (extended so value-field stores and inout pass-through rooted in an
`inout` parameter count); a pragma'd callee is trusted. Field/index assignment stays
unconditional. The receiver case needed no separate site because a method's `self` reaches the
parameter loop as an ordinary argument. D3's text in `PARALLELISM_RULES.md` was corrected to
match. Verified with the
tree-built compiler: the three repros rejected, the corpus (7 tests + 6 rejection blocks),
`tests/thread_safety`, `arc`, `atomic_object`, `imm_threading`, `thread`, `thread_pool`,
`sync/{mutex,rwlock,once,channel}`, `iso`, `spawn_blocking`, `cross_thread_wake`, `async_mutex`
green, `check ./src` and `check ./std` clean.

### Phase 2: `Iso(T)` (P-2) (M; codegen + evaluator + prelude + docs; seed-gated in one place)

1. **Evaluator.** `src/evaluator/calls/iso.yo` (`evaluate_iso_value_call` already holds the
   three named-variable checks): a value call outside a pragma'd file is E-coded ("construct
   with `^v`"); `evaluate_iso_type_call` rejects a `T` that does not contain a reference type
   (moves the macro's first check into the evaluator, so `Iso(i32)` fails at `check`) and keeps
   the `Arc`/`Iso` composition ban; the no-variable arm (a literal argument, P-17) is no longer
   reachable from safe code because only `^v` constructs.
2. **Codegen.** `src/codegen/types/generation.yo` pass 6: `extract` loads the wrapper's
   `ref_count` (acquire) and aborts with `Iso::extract(): the sending thread still holds a
   reference` when it is not 1. New pass: `__yo_iso_unique_<T>(value)` — a boolean walk over
   the runtime fields of `T` generated from the same per-type field list `generate_trace_*`
   uses (`src/codegen/functions/gc_runtime.yo`'s tracer emitters are the model), returning
   false on the first non-atomic object with `ref_count != 1`, not descending into atomic
   objects, scalars, `str`, raw pointers. The `^` macro's runtime arm calls it after
   `can_isolate` (or instead of it when `T` has no `Isolation` impl). This is the ONE new
   `__yo_*` builtin and therefore seed-gated: the prelude may reference it only after the seed
   that emits it ships (`plans/backlog/SEED_VERSION_AUTOMATION.md`); land codegen + evaluator
   first, flip the macro one release later.
3. **Prelude.** `^` no longer requires `Isolation` (it becomes the optional fast path); the
   SAFETY comment on `impl(generic(T), Iso(T), Send())` is rewritten to cite D2. Consider
   `iso(v)` as the function spelling for readability; keep `^`.
4. **Tests.** `tests/iso.test.yo`: scalar rejection, raw-constructor rejection,
   interior-aliased `.None`, second `extract` panics, sender-still-holds panic (a copied `Iso`
   kept alive across the spawn), and the 1000-`String` cross-thread hand-off that must stay
   green. `tests/iso_api_surface.test.yo` keeps the unconditional-Send assertion.
5. Exit: both `issues/repros/iso-*.yo` are rejected at `check`; the type-system audit's
   interior repro returns `.None`; the deep walk's cost is measured on a 1e6-node list and
   recorded here.

### Phase 3: module-level globals (P-3, P-10) (M; evaluator + one std fix)

1. **std first** (no seed dependency): `std/encoding/html.yo`'s tables become RC-free
   (`str` keys and values in an `imm.Map` or a sorted static `Array` with binary search).
   Test: the two-thread `html_decode` loop from the issue in `tests/encoding/html*.test.yo`,
   run under the TSan job.
2. **Evaluator.** At the two module-level binding sites
   (`src/evaluator/exprs/assignment.yo` typed form, `initialization_assignment.yo` inferred
   form — the same two places `thread_local` hooks, `plans/reference/THREAD_LOCAL_STORAGE.md`),
   in a pragma-free file: the binding's type must be `Send` and must not be a non-atomic
   object or contain one (reuse `type_contains_rc_type` + the atomic check); otherwise E-code
   with the D1 hint. Assignment to a module-level scalar global from any function body is
   the second rule (the `counter = counter + 1` form), keyed on `is_module_level_global`.
3. **Sweep** `tests/` and `docs/` for `.test.yo` files that keep a mutable global by
   convenience and convert them to `thread_local` or a local — count and list in the PR.
4. Tests: corpus blocks (ArrayList global with a spawn, scalar global assigned from a spawn)
   and canaries (`thread_local` ArrayList; `Mutex(i32)` global; `Arc` global; a scalar constant
   read from two threads).
5. Exit: the type-system audit's `module-globals-…` repro is rejected; `yo check ./src`,
   `./std`, the docs corpus and the full fast suite stay green with the fresh binary.

**Landed 2026-09-26** (branch `ps/phase3-globals`, stacked on Phase 5). NOT the rule as
written above: "every module-level global must be `Send`" rejected the compiler's own tree (a
dozen non-pragma'd `src/` files hold `ArrayList`/`HashMap` state) and every single-threaded
program with a global cache, since an Rc collection is never `Send`. What landed is the type-
system audit's option (c): a `Send`-bounded closure may not REACH a non-Send global, directly or
through statically resolved callees (`function_reaches_non_send_global`, called from both
closure-creation sites via `validate_send_closure_global_reach` — separate from the capture check,
because a capture-free closure has no capture struct; pragma'd bodies trusted), plus the `static mut`
rule for VALUE-typed globals (assignment, field/index store, writing `inout` binding) with
`*.test.yo` exempt from that one. Pinned by three check-level cli-cases and the corpus.
Rejecting unresolvable callees (a MAY-analysis) was measured and dropped: it turned 8 of 22
parallelism suites red (every spawn body calling a captured helper closure, and operators the
evaluator does not stamp with a callee). Calls through closure values and dyn methods are the
residual, `issues/d1-reach-walk-does-not-follow-closure-values-or-dyn-calls.md`, closed with D4
in Phase 4 once closures carry identity on `Func` types.
`std/encoding/html` keeps its `HashMap` tables under a `RawMutex` with copy-out lookups. The
docs corpus gate is parse-only (`scripts/check-doc-blocks.py`), so fragment examples are
unaffected.

### Phase 4: closure types, second-class captures, extern calls (P-4, P-13, P-9) (M, evaluator)

0. Prerequisite: fix P-26 (`arc(f)` / `Channel(typeof(f))` emit two capture-struct typedefs) so
   the legal `arc(closure_over_atomic)` shape compiles; then switch the D4 canary in the corpus
   to that form.
1. `src/evaluator/trait_checking.yo` `.Func` arm: when the target came from a closure VALUE
   (the on-demand marker check receives the type; thread the value or its `func_id` through
   from the where-clause discharge in `calls/` so `get_closure_capture_info` can be consulted),
   judge the capture struct; a bare fn pointer stays `direct_true`. Where the value is not
   available (a pure type-level `Type.impls(typeof(f), Send)`), answer from the registered
   capture struct keyed by the closure's func_id, which `typeof` of a closure-bound variable
   resolves to today.
2. `src/evaluator/utils/closure.yo` `enrich_captured_variables`: a captured binding that is an
   `inout`/`ref` parameter or control-bound is an error at the capture token (D8).
3. `src/evaluator/calls/function.yo`: calling an extern-bound `FuncVal` from a pragma-free file
   is a safe-mode error (D6); `std/sys/externs.yo` importers inside std are all pragma'd, so
   `yo check ./std` is the regression gate.
4. Tests: corpus blocks for `arc(f)`, `Channel(typeof(f))`, the `with_lock` capture, the extern
   call; canaries for `arc` of a closure over an atomic, a plain-fn-pointer `Send`, a closure
   inside `with_lock` capturing a local COPY.
5. Exit: all four repros rejected at `check`; `tests/spawn_blocking.test.yo` and
   `tests/sync/once.test.yo` (the two closure-forwarding shapes) still pass.

### Phase 5: primitives trap, never UB; pool barrier (P-5, P-6, P-7, P-8) (M, std only)

1. `std/sync/mutex.yo`: `Mutex(T)` and `RawMutex` gain `_owner : AtomicUsize` (0 = unheld) and
   `_depth : AtomicI32`; `_raw_lock`/`lock` panic on self-relock, set owner after the OS lock
   returns; `_raw_unlock`/`unlock` panic unless owner; `try_lock` answers false for the owner.
   `__yo_thread_self()` moves from `std/thread.yo`'s extern block to a shared
   `std/sys/externs.yo` entry (it is a preamble macro, always linked).
2. `std/sync/cond.yo`: `wait_with` / `wait_timeout_with` assert `m._owner == me && _depth == 1`
   before parking, and re-assert ownership on return.
3. `std/sync/once.yo`: `_owner` set before `f` runs; a re-entrant `call` panics.
4. `std/thread.yo`: one module-level `_submissions := RawMutex.new()` (pragma'd file, atomic
   object — allowed under D1) replaces the per-pool `_mutex`, `_held`, `_owner`; `spawn` checks
   `_closed` after taking it; `shutdown` stores `_closed` under it. The per-pool completion
   counter (the real fix) is scheduled after
   `issues/spawn-wrapper-forwarded-io-crosses-specializations.md` is fixed in codegen (a
   Phase 6 item).
5. Tests: `tests/sync/mutex.test.yo` — unlock-without-lock traps (rc 134 + message), lock
   twice traps; `cond.test.yo` — `wait_with` outside `with_lock` traps; `once.test.yo` —
   re-entrant `get_or_init` traps; `thread_pool.test.yo` — two pools, one spamming from a
   helper thread while the other drains slow tasks; `shutdown` racing `spawn`.
6. Exit: the TSan job (`tests/sync`) green; every trap tested on the three desktop targets.

**Landed 2026-09-26** (branch `ps/phase5-primitives-trap`, stacked on Phase 1). As above, with
two details: the owner is an `AtomicUsize` field (the `atomic_size_t` C type has no typed
load/store extern in `std/libc/stdatomic.yo`; an inline field is a later diet), and the `Once`
re-entry check runs BEFORE the mutex so the message names `Once`, not `Mutex`. The traps are
pinned as four `tests/cli-cases/*-panics` cases (rc 1 + the message), the portable
`try_with_lock`/`is_unlocked`/`RawMutex` answers and the post-wait holder record in
`tests/sync/mutex.test.yo`, and the two-pool barrier in `tests/thread_pool.test.yo`.

### Phase 6: the runtime (P-11, P-12, P-14, and the runtime sub-audit's items) (M, codegen)

1. `src/codegen/async/runtime_core.yo`: move the foreign release's `live_wakers` decrement to
   the owner's drain (D7); in the drain, re-load `release_pending` after clearing `queued` (or
   do both under `owner->lock`); make `t->future` `_Atomic` for `is_woken` or document it
   owner-only and assert.
2. `src/codegen/exprs/parallelism.yo` + `closures.yo`: fix the forwarded-`io` specialization
   crossing (`issues/spawn-wrapper-forwarded-io-crosses-specializations.md`) so `ThreadPool`
   can wrap task closures; then the completion counter of Phase 5.4.
3. `src/codegen/exprs/rc_fns.yo`: key `rc()`'s atomic-load arm on the same "is this RC atomic"
   predicate `drop_dup.yo` uses (P-19). `src/codegen/exprs/other_fn_call.yo` +
   `functions/generation.yo`: no borrow pair for an atomic container (or an atomic counter for
   pragma'd code), and the `Index` entry's `inout(self)` prologue must not assert against its
   caller's own borrow (P-18).
4. `src/codegen/parallelism/runtime.yo`: Windows once-init for the pool mutex via
   `InterlockedCompareExchange` as the GC does (P-20); `atexit` shutdown signals and returns
   without joining, dead free loop removed (P-23); `__yo_cleanup_thread_gc()` called at the end
   of both thread entry points on every platform (P-24). `src/codegen/async/runtime_io_windows.yo`:
   per-loop socket registry (P-21). `runtime_io_macos.yo`: notify/cleanup under `loop->lock`
   (P-22). `runtime_core.yo`: `__yo_async_strict_cached` becomes `_Atomic` (P-25).
5. Tests: `tests/cross_thread_wake.test.yo` — `spawn_blocking` inside a spawned thread, a few
   thousand iterations, under the Linux ASan leg; a live-future counter behind a debug knob for
   the leak; the two borrow repros; `rc(i1)` across a spawn; a pool task blocked forever while
   `main` returns (the process must exit); Windows legs: the two-thread pool submission test and
   a socket-per-thread test.

### Phase 7: the standing proof — TSan over the whole thread corpus (S–M, CI)

- Today the Linux/Clang TSan job runs `tests/sync` only. Extend it to `tests/thread*.test.yo`,
  `tests/arc.test.yo`, `tests/atomic_object.test.yo`, `tests/iso*.test.yo`,
  `tests/cross_thread_wake.test.yo`, `tests/spawn_blocking.test.yo`,
  `tests/imm_threading.test.yo`, `tests/parallelism_soundness.test.yo` and the new
  `html` test, with a `scripts/bootstrap/known-failing.tsv`-style ratchet so pre-existing
  reports fail both ways (memory: "ratchet instead of red gate"). Measure before enabling:
  a TSan run that reports nothing on a corpus that never spawns is hollow (memory:
  "hollow-green gate hygiene") — the job prints the number of threads created per test.
- Add the job to the branch-protection required list by hand (ruleset 13548862).

### Phase 8: documentation sync and closure (S)

- `docs/{en-US,zh-CN}/THREAD_SAFETY.md` "Known holes" list emptied; `ISOLATED.md`, `ARC.md`,
  `PARALLELISM.md` reflect D1–D8; `.github/instructions/yo-design.instructions.md` gains a
  "Parallelism rules" paragraph (D1, D3, D8 are the ones a std author hits).
- `plans/archive/THREAD_SAFETY.md` correction banner updated to "closed by
  PARALLELISM_SOUNDNESS"; this document moves to `plans/archive/` with the measured numbers.

## 7. Order and sizing

| Phase | Depends on | Size | Seed-gated? | Why this position |
| --- | --- | --- | --- | --- |
| 0 | – | S | no | stops the docs lying; gives every phase its test slot |
| 1 | 0 | S–M | evaluator only — the fresh-binary gate, not the seed | the most common safe-code race spelling |
| 5 | 0 | M | no (std only; `__yo_thread_self` exists) | UB from safe code, std-only change, can run in parallel with 1 |
| 3 | 0 | M | evaluator + std | the other race spelling; the std part (P-10) first |
| 4 | 0 | M | evaluator | closes the check-level holes before codegen changes turn them real |
| 2 | 0 | M | YES (one builtin) — land codegen first, flip the prelude a release later | the memory-unsafe one, but it needs the seed cycle |
| 6 | 0 | M | no | runtime races; independent of 1–5 |
| 7 | 1–6 | S–M | no | the proof; enable per-file as phases land |
| 8 | all | S | no | closure |

Coordination with `TYPE_SYSTEM_SOUNDNESS.md`: Phase 1 here and its Phase 5.2 (`inout`
exclusivity) touch the same argument-binding site — whichever lands second rebases onto the
helper the first introduced. Its Phase 3 (type identity) does not block anything here; the
`Pair(i32)`/`Pair(ArrayList)` probe shows the marker memo is already keyed per instantiation.
`EVALUATOR_MEMORY_REDUCTION.md`'s CI memory ratchet (±10 % on `check src/main.yo`) applies to
Phases 1, 3 and 4; none of them adds per-expression state, but each PR reports the number.

## 8. Provenance

- Compiler: `yo 0.2.41` (the newest seed at audit time) with `--std-path` at the develop tree
  `e9b159709`; macOS 26 arm64; `--optimize 2`; `--allocator system` + `MallocScribble=1` for
  the runtime probes. No develop-built compiler was used: every finding is a `std`, `docs` or
  evaluator/codegen READ finding, and the two runtime crashes reproduce with the seed's codegen
  because the relevant emitters (`generation.yo` Iso passes, `parallelism.yo`) are unchanged
  between 0.2.41 and develop (`git log v0.2.41..HEAD -- src/codegen/types/generation.yo
  src/codegen/exprs/parallelism.yo src/codegen/async/runtime_core.yo`).
- Three parallel sub-audits (lock primitives; atomics/channels/async/imm/globals; the emitted
  runtime) fed §3 and §4; every finding they raised was re-read at the cited lines before it
  was filed, and their "correct" lists are what §4 condenses.
- Probe sources: `issues/repros/*` for the filed ones.
