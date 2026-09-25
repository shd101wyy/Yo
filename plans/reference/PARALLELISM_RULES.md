# Parallelism rules

**Status:** DECIDED 2026-09-25 by the parallelism-soundness audit
(`plans/archive/PARALLELISM_SOUNDNESS.md`); **ALL LANDED 2026-09-26.** D9 was added while
closing that plan. The audit measured D1–D8 as violated on develop `e9b159709`. Each rule's
status line names where it is enforced. A change to a rule is a new decision: record it here,
with its reason.

These rules are what makes the user-facing guarantee in `docs/en-US/THREAD_SAFETY.md` true:

> For every program that compiles without `pragma(Pragma.AllowUnsafe)` and uses only primitives
> from `std/`, every shared cross-thread mutable access is mediated by a synchronization
> primitive. The program is data-race-free under the C11 memory model.

## D1 — Module-level runtime bindings must be thread-safe

**Status:** LANDED 2026-09-26 (Phase 3): `function_reaches_non_send_global`
(`src/evaluator/effects/mutation_summary.yo`) called from the spawn-boundary capture check, and
the module-global branch of the write/inout rules in `src/evaluator/exprs/assignment.yo`,
joined by two registries (written globals, globals reached from a `Send` closure) so the error
fires on whichever site is evaluated second.

A module-level `name := value` or `(name : T) = value` binding is one static shared by every
thread of the process. In a file without the pragma:

- a closure bound to a `Send` closure type (a `Thread.spawn` body, a pool task, a
  `spawn_blocking` callback — anything coerced to `Impl(Fn(...), Send)`) may not REACH a
  module-level global whose type is not `Send`, directly or through any function it can call:
  a walk over the evaluated closure body and its statically resolved callees (memoized,
  cycle-safe); a body defined in a pragma'd file is the audited base and is not descended into.
  A call through a local closure VALUE is followed into the closure's body (its binding keeps
  the `FuncVal`), and a `Dyn(Trait, Send)` value's vtable methods are walked at `dyn(...)`,
  where the concrete impl is known
  (`issues/fixed/d1-reach-walk-does-not-follow-closure-values-or-dyn-calls.md`). Treating every
  unresolvable call as a violation was measured and rejected: it convicts every spawn body that
  calls a captured helper closure. A non-atomic RC
  global (`ArrayList`, `HashMap`, `String`, any `ref(struct)`) therefore stays legal in a
  single-threaded program and for the main thread, but no other thread can touch it: even
  READING a field through such a handle performs reference-count traffic
  (`issues/fixed/std-html-entity-tables-are-non-atomic-globals-read-from-every-thread.md`);
- a VALUE-typed global (a `Send` scalar or struct — the one kind another thread may read) that
  is WRITTEN anywhere — assigned, the root of a field/index store, or bound to an `inout`
  parameter of a callee that may write through it (the D3 mutation-mask decision) — is a mutable
  static (`static mut`), and a `Send`-bound closure may not reach it by the first rule's walk. A
  write alone is a single-threaded global and a reach alone is a shared constant; the pair is
  the race. Each side records itself in a registry keyed by the global's declaration token and
  consults the other's, so evaluation order does not matter and the diagnostic names both
  sites. Rejected: "a written value global is always an error" — it rejected six flags in the
  compiler's own tree (`g_warnings_enabled`, `g_prof_enabled`, …) that no other thread touches.
  Writes through an atomic-object global are governed by D3.

The diagnostics point at the alternatives: `thread_local(name)` for per-thread state
(`plans/reference/THREAD_LOCAL_STORAGE.md`), an atomic object (`Mutex(T)`, `Arc(T)`, `Atomic*`)
for shared state, or a value with no reference inside for a constant. Pragma'd files keep
today's behaviour and carry the audit burden (std's `std/log.yo` globals are under a mutex;
`std/encoding/html.yo`'s tables are read under a lock). Rejected: "every module-level global
must be `Send`" — it rejects every single-threaded program with a global cache (an Rc-based
collection is never `Send`), the compiler's own tree included. Rationale otherwise: Rust's
`static: Sync` rule.

## D2 — `Iso(T)` is constructed only through `^`, `T` is a reference object, uniqueness is deep

**Status:** LANDED 2026-09-26 (Phase 2): `evaluate_iso_type_call` / `evaluate_iso_value_call`
(`src/evaluator/calls/iso.yo`), `generate_iso_uniqueness_functions`
(`src/codegen/functions/constructors.yo`), the `__yo_iso_unique` builtin and the `^` macro in
`std/prelude.yo`. Not seed-gated after all: the new builtin appears only inside the macro's
`quote`, which nothing the seed compiles expands.

- In a file without the pragma, `Iso(T)(v)` is not callable; `^v` is the constructor.
- `Iso(T)` requires `T` to be a non-atomic reference OBJECT (a `ref(struct)`/`ref(enum)`:
  `ArrayList`, `HashMap`, `Box`, a user `ref(struct)`), because the wrapper holds and releases the
  child's handle. `Iso(i32)`, `Iso(<value struct>)`, `Iso(Arc(T))`, `Iso(<atomic object>)` and
  `Iso(Iso(T))` are compile errors. An atomic object DEEPER in the value is allowed: it is shared
  by design, and the walk stops at it.
- Uniqueness is checked at CONSTRUCTION and it is DEEP: `__yo_iso_unique_<Iso>` walks every
  reachable non-atomic object through the per-type traversal functions (the collector's; the
  visitor receives each child's traverse function) with an explicit worklist, and fails if any
  has `ref_count != 1`. On failure `^v` is `.None`. The walk runs on the sending thread, where
  every reachable non-atomic refcount is stable, so the check is race-free. `Isolation` is no
  longer consulted by `^`.
- `extract()` hands the value out exactly once (its atomic one-shot flag). The originally planned
  extra wrapper `ref_count == 1` check was dropped on analysis: `extract` is the only operation on
  the inner value, so a sending thread holding a copy of the wrapper can never obtain the value
  once the receiver has, and dropping that copy frees nothing — the flag is what makes the owner
  unique, and a count check would depend on how many references the call's own `self` holds.

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

**Status:** LANDED 2026-09-26 (Phase 4, in the Phase 6 PR): every where-clause path
(`validate_where_constraints_for_call`, and `validate_concrete_type_constraints` /
`apply_single_trait_constraint` / `parse_where_clause_constraints` in
`src/evaluator/types/function.yo`) judges a closure-typed bound by its values. Its last sentence
("a bare `fn` pointer stays `Send`") was superseded by D9.

Rust's auto-trait rule, applied uniformly: at the spawn boundary (already), and when a
`where(T <: Send)` / `where(T <: Acyclic)` is discharged with `T` instantiated from a closure
type (`arc(f)`, `Channel(typeof(f))`, a generic `g(f)`). A bare `fn` pointer is `Acyclic`;
whether it is `Send` is D9's question.

## D9 — A function value is `Send` iff what it captures is and what its code reaches is

**Status:** LANDED 2026-09-26 (closing `plans/archive/PARALLELISM_SOUNDNESS.md`):
`function_value_marker` (`src/evaluator/utils/closure.yo`), reached from `trait_checking.yo`
and `types/function.yo` through `call_function_value_marker` (`src/evaluator/context.yo`).

D1 walks the code a closure LITERAL runs when the literal is created in a `Send` slot. Nothing
walked the code of a function that reached another thread any other way. A named function
passed to `Thread.spawn`; a closure bound first to a plain local, then handed to `arc`, a
`where(T <: Send)` binder or an `Impl(Fn, Send)` parameter; a function stored in a struct and
read back on the thread: each of these ran code that raced on a non-`Send` global, with no
diagnostic (`issues/fixed/function-values-bypass-the-d1-reach-walk.md`). A function type
cannot answer the question, because two functions of one signature share the type and a
closure that captures nothing still runs code.

The rule: **a function value holds `Send` iff its captured state does (D4) and its code reaches
no thread-affine module global (D1's walk). `Acyclic` is D4 alone.** The value decides wherever
the value is known:

- **An argument to an `Impl(..., Send)` parameter:** the argument's value, both call paths,
  before the type-level check.
- **A `where(T <: Send)` binder bound to a function type:** the callee's parameters bound to
  that type, then the closures created against a closure's `Impl(Fn...)` SomeT (a registry
  keyed by the SomeT's id, which a specialization's fresh binder aliases).
- **A variable captured by a `Send` closure:** the captured value.
- **A declared `(f : Impl(Fn(...), Send)) = v` binding:** `v`. A declared marker is not
  re-judged later, so the binding is where a value takes on the promise.
- **`dyn(v)` into `Dyn(Fn(...), Send)`:** `v`.
- **An `Iso(T)`:** every function value `T`'s graph can hold (`_iso_function_offense`,
  `src/evaluator/calls/iso.yo`). D2's uniqueness walk proves the graph is uniquely owned, not
  that a function in it runs safely on the receiving thread. A bare `fn` field and a `Dyn`
  without `Send` make the `Iso` an error
  (`issues/fixed/iso-of-a-graph-holding-a-function-value-bypasses-d9.md`).

A closure is walked when it is CREATED, with its defining env, in every slot, not only a `Send`
one. The verdict is memoized by function id, so a later judgement that has only the closure's
type reads the verdict taken where the closure's local callees resolve.

Where no value is known, the type decides: a bare `fn(...)` type is **not `Send`**. That covers
a struct field, a collection element, a `Channel(fn() -> unit)` payload, a parameter of bare
`fn` type forwarded on, and a plain local `f := count`, which records no value for a later
capture to judge. Declare it `(f : Impl(Fn(...), Send)) = count` instead. This is Swift's rule for plain function types, and it is what closes
the struct route: a function inside a struct lost its identity where it was stored. A closure
`Impl(Fn(...))` type with no value found is judged by what it declares, as before.
`Impl(Fn(...), Send)` is the function type that carries the obligation, discharged where the
value was converted into it.

Within a walked body, a function used as a VALUE (passed along, bound to a local, read from a
module field) is walked as if called: whatever receives it may call it, and that call has no
compile-time callee.

Rejected:

- **"Every function value must be reach-free."** It rejects every single-threaded callback over
  a global, a compiler dispatch table included.
- **A runtime affinity trap on thread-affine globals** (Swift's dynamic isolation checks). It
  is sound, but the compiler would no longer be the gate.

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

## D6 — Calling a runtime extern by name is a safe-mode violation unless the calling file has the pragma

**Status:** LANDED 2026-09-26 (Phase 4): the `gate_is_extern_runtime` check in
`evaluate_function_call` (`src/evaluator/calls/function.yo`), beside the extern-"c" `unsafe(...)`
gate.

Naming or importing an extern (its type flows through `std`'s wrappers) stays legal. CALLING a
runtime extern — any `extern` whose language is not `"c"`, i.e. the `__yo_*` entry points
`std/sys/externs.yo` exports — BY NAME (the callee is a bare identifier, as a destructured import
binds it, or a field of a module value) from a file without `pragma(Pragma.AllowUnsafe)` is an error. Declaring one already
requires the pragma; this closes the re-export route
(`issues/fixed/safe-code-reaches-pragmad-runtime-externs-through-std-sys-externs.md`). An
extern `"c"` call already needs `unsafe(...)`, which needs the pragma.

A dot-access callee stays legal: `io.await`, `io.async`, `io.spawn` are extern-bound FIELDS of
the `Io` value, std's sanctioned async surface. Rejected: "every extern call" — it rejects every
async program for exactly that reason. Compiler-synthesized code (`auto-generated://`) is exempt,
as for the `unsafe(...)` gate.

## D7 — A loop never observes `live_wakers == 0` while a post it will receive is in flight

**Status:** LANDED 2026-09-26 (Phase 6): `__yo_waker_consume_release`, the loop's `visitors`
count and `__yo_async_loop_quiesce` in `src/codegen/async/runtime_core.yo`.

The foreign `Waker` release decrements the owner's `live_wakers` in the OWNER's drain, after the
post has been consumed, never on the releasing thread before the post; the drain checks for a
pending release both before and after it marks the token off the inbox, so a release that lost
the `queued` race is still consumed. And because a poster's notify necessarily happens after it
unlocks the owner (the Linux notify takes that lock), every thread that touches a FOREIGN loop —
a poster, a `blocking_end` — registers itself in the loop's `visitors` count while the loop is
provably alive, and the loop's thread waits for that count to drain before tearing the loop
down. Together this keeps a spawned thread's loop alive until every cross-thread message
addressed to it has been processed and every foreign thread is done touching it.

## D8 — Closures may not capture second-class bindings

**Status:** LANDED 2026-09-26 (Phase 4): the rule already existed in
`_check_anon_fn_captures` (`src/evaluator/values/anonymous_function.yo`); what landed is that its
rejection is flagged on the flow-violation channel (`_raise_capture_rejection`), so the enclosing
definition re-raises it instead of its definition-time trial swallowing it.

A closure that captures an `inout(...)` or `ref(...)` parameter, or any control-bound value, is
a compile error at the capture token. This is `plans/reference/MEMORY_SAFETY.md` Phase B's rule
restated as an evaluator check; it is what makes `Mutex.with_lock`'s `inout(v)` unable to
escape the critical section. Before the fix the check fired inside the enclosing closure's
trial evaluation, which swallowed it: `yo check` was green and codegen died on the hollowed
body (`issues/fixed/a-closure-capturing-an-inout-lock-body-parameter-passes-check.md`).
