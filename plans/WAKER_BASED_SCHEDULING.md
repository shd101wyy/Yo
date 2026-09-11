# Waker-based scheduling

**Status:** IN PROGRESS — steps 1, 3a and 3b landed 2026-09-11, step 2 is
seed-gated, steps 4-5 are open. Written 2026-09-10. This is the largest
remaining item in `plans/STD_API_STABILIZATION.md`'s concurrency group, and four
std modules' `## Stability` markers name it as the thing that will change under
them.

| step | state |
| --- | --- |
| 1. `Waker` + `park` in the runtime | **LANDED** (#561) — `std/async/waker.yo`, `__yo_async_park_start` / `__yo_waker_new` / `__yo_waker_wake` / `__yo_waker_release` in `codegen/async/runtime_core.yo`, plus the live-waker count the loop needs to know a parked task is still wakeable |
| 2. `yield` over `park` | **SEED-GATED.** `yield_now` is the fast form and is landed; `yield` itself cannot point at it until the seed ships `__yo_async_yield_start`, because `yield` is on the compiler's own import path (through `std/fs/watch`) and the seed emits a runtime without that symbol, so the compiler fails to LINK. Moves in the release after the one that ships this runtime |
| 3a. `Mutex` over a waiter queue | **LANDED** (#576) — `std/async/mutex.yo` holds an `ArrayList(Waker)`, `unlock` wakes the FRONT waiter, and `waiter_count()` is the oracle the FIFO test reads |
| 3b. `Channel` over the same queue | **LANDED** (#586) — `send`/`recv` park on a waiter queue instead of re-checking on a 1 ms timer tick. It was blocked for a day by a compiler defect that the rewrite surfaced: the trace collector tried to monomorphize a GENERIC `ArrayList(T)` instance that only this shape put in the codegen type registry, and failed inside `array_list.yo`'s `Trace` body — a file the rewrite never touched (`issues/fixed/a-generic-instance-in-the-type-registry-breaks-trace-monomorphization.md`) |
| 4. The combinators (`race`/`any`/`timeout`) | open |
| 5. Cross-thread wake + `spawn_blocking` | open |

**Two codegen bugs fell out of this campaign, both fixed.**

- **#580** — `Park.wait` awaits `self._future`, a future read out of a FIELD,
  and the state machine's await slot took that reference without a
  `__yo_incr_rc` while `Park`'s own dispose still dropped it. Two releases for
  one reference: a heap-use-after-free that failed every CI `test (…)` leg and
  the hollow sweep
  (`issues/fixed/awaiting-a-future-held-in-a-struct-field-releases-it-twice.md`).
- **#586** — the Trace collector force-specializes every reference-semantics
  type in the codegen type registry, and a GENERIC instance can be in there.
  Monomorphizing one is meaningless and fails in `ArrayList`'s own `Trace` body
  (`issues/fixed/a-generic-instance-in-the-type-registry-breaks-trace-monomorphization.md`).

Both were invisible to the local gates that pass on macOS and surfaced only
under CI's sanitizers or a specific std shape — worth remembering before the
remaining steps.

## The problem: everything that waits, waits on a 1 ms timer

Yo's async runtime can suspend a task on I/O, but it has no way for one task
to be woken by ANOTHER task's progress. So every std primitive that waits on a
peer polls a clock:

| site | what it does |
| --- | --- |
| `std/async/index.yo:62` (`yield`) | `io.await(IO_timer.sleep(u64(1)), io)` |
| `std/async/mutex.yo:62` (contended `lock`) | same 1 ms park, re-check |
| `std/async/channel.yo` (blocked `send`/`recv`) | same |
| `std/async/index.yo:97,129,192` (`race`, `any`, `timeout`) | `__yo_async_poll_step()` in a spin, re-checking each pass |

Three costs, in order of how much they matter:

1. **Latency floor.** A task whose condition becomes true just after a check
   waits out the rest of the tick. Every hand-off through an async `Mutex` or
   `Channel` costs up to 1 ms, so a producer/consumer pair caps at ~1000
   hand-offs per second regardless of how fast the work is.
2. **`spawn_blocking` is not expressible.** The point of `spawn_blocking` is
   to run a blocking call on a worker thread and wake the awaiting task when
   it finishes. "Wake the awaiting task" is exactly the missing primitive.
   The std plan lists it as blocked for this reason.
3. **Wakeups with nothing to do.** Every parked task's timer fires every
   millisecond forever.

## What a waker is, here

A waker is a handle that, when signalled, makes a suspended task runnable
again. Yo's runtime already has the two halves separately:

- **Suspension** — the async state machine parks a task at an await point and
  records where to resume (`src/codegen/async/`).
- **A ready queue** — `__yo_async_poll_step` drives it.

What is missing is a first-class **"resume THIS task"** token that anything —
another task, a completion callback, a worker thread — can hold and fire.

## Design

### The primitive

```rust
/// A token that makes one suspended task runnable again. Cheap to copy,
/// safe to fire more than once (extra wakes are no-ops), and safe to fire
/// from a task that is not the sleeper.
Waker :: ref(struct(_task : *void));

/// Suspend the current task until `park`'s waker is woken. The closure runs
/// BEFORE the task suspends and receives the waker, so it can hand it to
/// whoever will wake it without racing the suspension.
park :: (fn(register : Impl(Fn(w : Waker) -> unit), io : Io) -> Impl(Future(unit, Io)));
```

`park`'s shape is the whole design. The naive spelling — get a waker, store
it, then suspend — races: the waker can fire between the store and the
suspension, and the wake is lost. Registering INSIDE the park, before the
suspension is committed, is how Rust's `Future::poll(cx)` and every correct
condvar API avoid the same race.

### Cross-thread wakes

`spawn_blocking` requires a wake from a DIFFERENT thread, which the async
runtime — deliberately single-threaded
(`AGENTS.md`: "Yo's async/await is single-threaded (like C#). Do not add
mutexes or atomics to async runtime variables") — cannot accept directly.

The resolution keeps that invariant: a cross-thread wake does not touch runtime
state. It pushes the waker onto a small **lock-protected wake queue** owned by
the loop and, on platforms that need it, nudges the loop out of its wait
(`eventfd`/`self-pipe` on Linux, a `kqueue` user event on macOS, an APC or an
IOCP post on Windows). The loop drains the wake queue on its own thread at the
top of each tick. So exactly one new piece of shared state exists, it is
explicitly locked, and every runtime variable stays single-threaded.

### What changes in std

| module | from | to |
| --- | --- | --- |
| `std/async/index.yo` `yield` | 1 ms sleep | enqueue self at the back of the ready queue; no timer |
| `std/async/mutex.yo` | 1 ms re-check | a waiter list; `unlock` wakes one |
| `std/async/channel.yo` | 1 ms re-check | sender/receiver waiter lists; each side wakes the other |
| `std/async/index.yo` `race`/`any`/`timeout` | poll-spin | each handle's completion wakes the combinator |
| `std/thread.yo` | — | `spawn_blocking`, newly expressible |

Every one of these is a strict improvement in latency and in wasted wakeups,
and none of them changes a signature — which is why the four `## Stability`
markers say the NAMES are stable and the MECHANISM is not.

## Implementation order

1. **`Waker` + `park` in the runtime**, single-threaded only. Acceptance: a
   ping-pong between two spawned tasks through a hand-rolled waker pair
   completes in microseconds rather than milliseconds, and a
   `YO_DEBUG`-style counter shows zero timer wakeups.
2. **`yield` over `park`.** Smallest possible adopter, and it is on the
   critical path of every combinator, so the latency win is immediately
   measurable. Note the trap recorded at `std/async/index.yo:53`: an earlier
   `yield` that did NOT reach `__yo_async_poll_step` made a
   poll-until-finished loop spin without ever polling I/O
   (`issues/build-smoke-hangs-registry-perturbation.md`). The new `yield` must
   still guarantee a loop tick.
3. **`Mutex`, then `Channel`.** Both need a waiter LIST, so build the list
   once and share it.
4. **The combinators.** `race`/`any`/`timeout` stop spinning.
5. **Cross-thread wake + `spawn_blocking`.** Last, because it is the only
   piece that adds shared state, and everything above must already be green
   so a regression here is unambiguous.

## Risks, each with the memory that names it

- **A blocking await inside a task nests the event loop and deadlocks**
  ([[yo-blocking-await-inside-a-task-deadlocks]]). Every new primitive must be
  an `io.async` future, and every test must exercise it from inside a SPAWNED
  task, not only from `main`.
- **Async state-machine shapes.** `park`'s await sits inside a closure that
  also runs user code; the cond/match-arm await family
  ([[yo-async-cond-shared-await-point-fixed]]) is exactly where that
  historically broke. Write the shape tests first.
- **A lost wake is a hang, not a failure.** The whole class is invisible to a
  green macOS run and shows up as a Linux-only hang
  ([[yo-linux-loop-stays-alive-on-parked-accept]],
  [[yo-linux-only-hang-debug-via-temp-workflow]]). Every waiter list needs a
  test that wakes N waiters from one signal and asserts all N ran.
- **`timeout`'s known residual.** `std/async/index.yo` documents that a
  completed-before-deadline task leaves its deadline timer armed and its
  future struct unreclaimed (`issues/timeout-deadline-timer-future-leak.md`).
  Waker-based `timeout` should CLOSE that rather than inherit it — the
  deadline becomes a wake to cancel, not a task to outlive.

## Acceptance for the whole change

- The suite green, with `tests/async/*` and `tests/sync/*` unchanged in
  signature (only in speed).
- A measured hand-off benchmark: async `Channel` ping-pong throughput before
  and after, on Linux and macOS. The claim to be proven is a floor removal,
  so the number to report is hand-offs/second, not wall time of the suite.
- `spawn_blocking` with a genuinely blocking callee (a `sleep` in C, a
  synchronous file read) that does NOT stall the loop: a sibling task must
  make progress while it runs, asserted by ordering, not by timing.
- The ThreadSanitizer leg (`test-tsan`) clean over the cross-thread wake
  queue — that job exists for exactly this class.
