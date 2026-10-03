# Async I/O API audit: `io.async` / `io.await` / `io.spawn`, `Future`, `JoinHandle`, `IoFuture`

**Status: APPROVED 2026-10-03, phases A0–A5 in order; A0 landed, A1 in
review (Generation A: the primitive, `JoinHandle.join`, the future-shaped
combinators; Generation B, the three std/src loops, is parked in
`backlog/SEED_VERSION_AUTOMATION.md`); four bugs filed (two S1, two S2, §4).** The four questions in §6 were decided by
the user on 2026-10-03, taking the recommendation in each: aborts propagate,
`IoFuture` stays a raw `i32`, the combinators take handles only,
`FutureState.Pending` becomes `Cold`. Measured on develop `bcb57bfe7` with a compiler built from
that tree by the v0.2.49 seed. Related plans:
`ASYNC_STATE_MACHINE_GENERATION.md` (the lowering),
`ASYNC_PERFORMANCE_HANDOVER.md` (throughput),
`backlog/ASYNC_DEADLINE_COMBINATOR.md` (the HTTP server keep-alive this
unblocks), `reference/ASYNC_ITERATION_STREAM.md` (streams, not re-audited).

---

## 1. Scope and method

The audit covers the user-facing async surface and the one type under it:

| Surface | Where |
| --- | --- |
| `Io` (`async`, `await`, `state`, `spawn`), `FutureState`, `JoinHandle(T)` (`await`, `state`, `is_finished`, `abort`, `Dispose`) | `std/prelude.yo` 12045–12190 |
| `Future(T)` / `Future(T, E)` and `Impl(Future(…))` | `src/evaluator/types/future_trait.yo`, `src/evaluator/builtins/impl_constraint.yo`, `src/types/compatibility.yo` |
| `IoFuture :: Impl(Concrete(__yo_io_future_t), Future(i32))` | `std/sys/future.yo`, the 90 `-> IoFuture` externs under `std/sys/` |
| `std/async`: `yield`, `join_all`, `race`, `race_first`, `any`, `any_first`, `timeout`; `waker`, `channel`, `mutex` | `std/async/*.yo` |
| The lowering of each operation | `src/codegen/exprs/await.yo`, `src/codegen/exprs/generation.yo` (`_generate_io_spawn`), `src/codegen/async/state_machine.yo`, `runtime_core.yo` |

Method: read the definitions, the lowering and the runtime; cross-read every
document that states a contract (`docs/*/ASYNC_AWAIT.md`, the design and
codegen instruction files, the std docstrings, the stability notes); inventory
the open `issues/` and plan items; inventory the tests; then run five probe
programs against a tree-built compiler for the claims that code reading alone
could not settle (§4).

## 2. What is in good shape

These are the decisions the audit confirms and that no phase below changes.

- **Lazy, explicit futures.** `io.async` builds a cold state machine;
  `io.await` and `io.spawn` start it; nothing runs without an `Io` in hand.
  This is simpler than Rust's poll model and avoids C#'s hot-start surprises.
- **One effect bundle per future.** `Future(T, E)` takes a single struct
  `E`; the body receives it as its one parameter; the await site names it.
  The codegen injects the bundle once, at the cold start, and the evaluator
  checks the bundle at the await (`src/evaluator/calls/helper.yo` 7409–7470).
  The rule is stated consistently in ALGEBRAIC_EFFECTS.md, the design
  instructions, the recipes and the skill.
- **Multi-await and multi-waiter futures.** Awaiting a completed future again
  re-reads its result with a fresh dup; several tasks may await one pending
  future and all resume in registration order
  (`tests/async/sm_protocol.test.yo:32`, `tests/async_await.test.yo:1703`).
- **Reference-counted lifetime; the handle owns a reference.** `JoinHandle`
  is a `ref` struct holding one reference to the task's future, with a
  `Dispose`; dropping the last copy detaches the task (Tokio's semantics), so
  a statement-level `io.spawn(…)` leaks nothing
  (`tests/async/sm_protocol.test.yo:213`); awaiting it twice reads the same
  result (`:233`). Both facts are implemented as documented in the prelude.
- **Structured cancellation.** `abort` marks the task, cancels the I/O it is
  suspended in where the backend has a cancel path (Linux: timers and the
  epoll/io_uring descriptor and datagram operations; macOS: timers and
  kqueue-parked descriptors; Windows and WASM: timers), aborts an awaited
  child recursively, and wakes every waiter; parked `Mutex`/`Channel` waiters
  leave their queues. Aborted-but-unobserved tasks are reported once.
- **Thread rules.** `Io` and `JoinHandle` are `!Send`; the loop is
  per-thread; `Waker` is atomic and `Send` so `spawn_blocking` can wake a
  task from a worker.
- **`Waker`/`Park`** is the right primitive, the lost-wake ordering is
  argued correctly in `std/async/waker.yo`, and `Channel` and `Mutex` are
  built on it (FIFO, cancellation-aware through `is_woken`).
- **`Stream`** (`for_await`, `Item = Result(T, E)` for fallible sources, `Io`
  bundle only) — landed, not re-audited here.
- **`timeout` returns `Result(T, TimeoutError)`** with `Elapsed` and
  `Aborted` distinguished (D18), and `race_first`/`any_first` do the loser
  cleanup the index-returning forms leave to the caller.

## 3. Findings

Ranked by what a user hits first. "F" numbers are referenced from §5.

### F1 — There is no suspending join. `JoinHandle.await` always nests the loop

`JoinHandle.await` (`generate_join_handle_await`, `src/codegen/exprs/await.yo`
633–747) is a blocking poll loop in every context, and the `std/async`
combinators are built on the same loop (`__yo_async_poll_step` in a `while`).
Inside an `io.async` body that nests the event loop: the waiting task sits on
the C stack while the inner loop runs the others, and if the awaited work
needs a task under it, the program deadlocks. `YO_ASYNC_STRICT=1` turns the
first such wait into a panic, and `yo test` sets it.

The consequence is that the documented way to collect spawned work from
inside a task is a hand-rolled busy loop
(`docs/en-US/ASYNC_AWAIT.md` 654–744):

```rust
while(!all_finished(handles), { io.await(yield(io), io); });
```

std and the compiler carry the same loop three times
(`std/http/client.yo:922`, `std/process/command.yo:604`,
`src/build_runner.yo:222`), and `backlog/ASYNC_DEADLINE_COMBINATOR.md` records
the HTTP server's keep-alive as blocked on exactly this. The `std/async`
stability note already says the mechanism "is expected to change".

`io.await(fut, e)` does not have this problem: inside a state machine it is a
real suspension (`_emit_await_suspension_core`, joins the future's waiter
list), and only in a plain `fn` is it a poll loop. The asymmetry between
`io.await` and `handle.await` is the whole defect. Note also that
`JoinHandle.await`'s `io` argument is never read by the lowering.

### F2 — Awaiting an aborted future: the outcome depends on timing

Three different things happen for the same program state "the future is
aborted", depending on where and when the await ran:

| Await site | Future aborted BEFORE the await starts | Future aborted WHILE the await waits |
| --- | --- | --- |
| Inside a state machine (`state_machine.yo` 1648–1658) | takes over the unwind: the awaiter is aborted in turn | the same |
| Plain `fn`, static type carries a bundle (`await.yo` 448–451, 513–528) | **panic** "attempted to await an aborted Future" | the enclosing function returns `(T){0}` with `__yo_effect_escaped = 1` (silent) |
| Plain `fn`, static type has no bundle (`await.yo` 530–531) | **panic** | **panic** |
| `io.spawn` of the future (`generation.yo` 382–386) | **panic** "attempted to spawn an aborted Future" | n/a |
| `JoinHandle.await` | `.None` | `.None` |

The design rule in the instructions ("any read of the Aborted state observes it
silently; the escape propagates") is the state-machine row. The panics are the
exception, they are documented as such in ASYNC_AWAIT.md (rules 6 and 10), and
no test covers either (§3.6). A `JoinHandle.abort()` of a task that another
plain-`fn` await is waiting on makes that function return a zero `T` with the
escaped flag set, which the caller cannot distinguish from an unwind. §6 Q1.

### F3 — `io.spawn` twice injects a second bundle over a running task

`_generate_io_spawn` injects the bundle (`__yo_future_set_bundle`, a
`memcpy` of `bundle_size` bytes into the future) BEFORE it checks whether the
future is cold (`generation.yo` 390 vs 392–397). A second `io.spawn` of a
running future therefore overwrites the bundle slot the task is executing
against; the second spawn then takes another reference and returns a second
handle. With `E = Io` the bytes are identical and nothing is observable; with
a bundle of handlers, the task continues with the second caller's handlers.
Probe 4 in §4 measures it. The copy is also a raw `memcpy` with no dup
(`await.yo` 256–284), so a bundle with a reference-counted field is held
without a count; today's bundles are handler records and `Io`, so this is a
latent rule, not a live bug — it should become a check (`E`'s fields must be
`Io`, handler types or value types) or a dup.

### F4 — `IoFuture`: a raw `i32` with two deviant families, and a wrong `Pending`

`IoFuture` resolves to a non-negative syscall result or a negative errno, and
its own docstring names the two families that break that (`sys/dns` resolves a
`getaddrinfo` code; the Windows socket paths resolve negated WSA codes) and
the typed result channel as its freeze condition. Two more facts from the
audit:

- An in-flight raw future has `state == 0`, which `io.state` reports as
  `FutureState.Pending` — the enum's "created but not yet started" — never
  `Running`. The raw future is eager (submitted at construction), so this is
  the opposite of the truth for every `std/sys` operation. No test asserts
  `Running` for anything.
- std consumes the raw convention 115 times as `e.io.await(IO_x.y(…), e.io)`
  followed by a hand-rolled check: 29 copies of
  `(r < i32(0)) => e.exn.throw(dyn(IoError.from_errno(i32(0) - r)))`, 19 of
  `_throw_io(i32(0) - r, …)`, 25 of `IoError.check` (the tidy form) and 0 of
  `IoError.from_result` (unused, untested). `sleep` discards the `i32`
  entirely (`std/time/sleep.yo:58`).

### F5 — `abort` has two cancellation gaps, and one of them can resurrect a task

- **A raw `IoFuture` spawned directly has no abort hook** (`vt == NULL`), so
  `abort()` on its handle marks it `-2` and cancels nothing; on macOS the
  completion then writes `-1` unconditionally (`runtime_io_macos.yo:1335`),
  turning an Aborted task back into Completed. Probe 1 in §4.
- **A NAMED awaited child is never cancelled.** The generated cancel hook acts
  only on the future in `__yo_await_slot`, i.e. an anonymous `io.await(expr)`
  (`state_machine.yo` 1863–1909). `f := child(io); io.await(f, io)` is outside
  structured cancellation. The fix record
  `issues/fixed/abort-does-not-cancel-a-nested-future-the-orphan-keeps-running.md:36`
  already names this case.

The prelude's `abort` docstring says the backend cancels "timers today",
which understates Linux and macOS (§2) and is one of the inconsistencies in
F7.

### F6 — Two soundness holes at the type level

- **A bundle-less view disables both the check and the injection.**
  `Future(T)` has empty effect lists, and compatibility says "empty on either
  side → compatible" (`src/types/compatibility.yo` 1577–1580). A
  `Future(i32, Ctx)` therefore passes where `Impl(Future(i32))` is expected;
  at that await the bundle check does not run (it needs exactly one effect on
  the static type) and the bundle is never injected (`await.yo:293` returns
  early), so the body runs against a zeroed bundle slot. Probe 5 in §4 runs
  that body up to its first handler call.
- **The bundle check compares shape, not types.** It compares the struct id
  or the field-label list only (`helper.yo` 7409–7470); two bundles with the
  same labels and different handler types pass.

### F7 — The contract is written in six places and they disagree

| Claim | Says the current model | Says the old model (stale) |
| --- | --- | --- |
| `JoinHandle` owns a reference, has `Dispose`, is re-awaitable | `std/prelude.yo` 12069–12087; `docs/*/ASYNC_AWAIT.md` "Future Lifetime Management"; `c-codegen.instructions.md:718`; `testing.instructions.md:34` | `std/async/index.yo` 88, 100–102, 124, 163–167, 234, 273 ("bare copyable struct … cannot carry `Dispose`", "must be awaited exactly once", "consumed"); `.github/instructions/yo-design.instructions.md` 388–397 ("non-owning view", `struct(__future : *(T))`, "no RC overhead"); `plans/archive/STD_API_STABILIZATION.md` 673, 1547–1550; `tests/async/join_handle.test.yo:88` |
| `yield` has no timer (since v0.2.32) | `std/async/index.yo` 57–68 | `docs/*/ASYNC_AWAIT.md` "`yield_now`" section ("pays a 1 ms sleep", "one release from now"); `tests/async/join_handle.test.yo:89`; `backlog/ASYNC_DEADLINE_COMBINATOR.md` cost 2 |
| The combinators poll `__yo_async_poll_step` directly | the code | `std/async/index.yo` 31–35 ("re-checking on a 1 ms timer tick") |
| `abort` cancels on Linux/macOS descriptor ops too | `runtime_io_linux.yo`, `runtime_io_macos.yo` | `std/prelude.yo` 12171–12179 ("timers today"); `backlog/ASYNC_DEADLINE_COMBINATOR.md` ("the backend has no cancel") |
| `Send` exists | everywhere | `docs/en-US/ASYNC_AWAIT.md` Key Principles 8 ("no Send trait") |
| `io.state` is `generic(T, E : Type)` | prelude, en-US | `docs/zh-CN/ASYNC_AWAIT.md:315` (`E : Type.Struct`) |
| Async placement rules are checked in the evaluator (since 2026-09-25) | `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4 | `AGENTS.md` 109, 180; `pack/context.md:32`; `src/codegen/constants.yo` 255–266 (a "splitter" and `validate_await_placement` that do not exist) |
| `Mutex.with_lock` takes a synchronous `body` | its signature | its docstring ("awaits inside `body` are allowed", `std/async/mutex.yo` 87–95) |
| `await_analysis.yo` detects only `io.await` as a suspension | `await_analysis.yo:283` | its module doc (`:7`, "io.await/io.spawn") |

Two smaller ones: `ASYNC_AWAIT.md` Known Limitation 2 describes an "async
unwind RC double-decrement" whose status is "unverified" against an issue
that never existed, and `impl_constraint.yo:5` still calls `Concrete(T)` "a
stub".

### F8 — Smaller surface warts

- **`io.state` is `generic(T : Type, E : Type)` while the other three say
  `E : Type.Struct`.** The lowering never reads `E`; the difference only lets
  `io.state` accept a future whose `E` is not a struct. Unify.
- **`JoinHandle.await` is routed syntactically.** `is_join_handle_await_call`
  matches any `x.await(…)` whose receiver is not spelled `io`
  (`src/evaluator/async/await_analysis.yo` 180–217), ignoring the
  `__yo_join_handle_await` marker, and `_is_dot_access(expr, "io", "await")`
  treats any receiver NAMED `io` as the builtin. A user method named `await`
  is mis-lowered (probe 2), and a receiver named `io` of another type is
  treated as the effect.
- **The effect-row spread `...(E)` still parses** in `Future(T, ...(E))`
  (`future_trait.yo` 55–245) and can produce several effects, but codegen
  reads effect index 0 only (`_first_future_effect`). Dead syntax with a
  wrong-on-use path; its comments call the spread "`E : Type.Struct`".
- **`Io` is 32 bytes of function pointers**, captured by value into every
  state machine and copied into every bundle. The four functions are
  compiler builtins; a zero-sized `Io` token would shrink each task by 32
  bytes and each bundle copy to nothing. Performance item, not an API change
  (`ASYNC_PERFORMANCE_HANDOVER.md` territory).
- **An owning `JoinHandle` costs a second allocation per spawn** —
  `issues/an-owning-join-handle-costs-an-allocation-per-spawn.md` (S3), fix
  designed (a value struct over the counted `Impl(Future)`), seed-gated.
- **`io.spawn` is not a suspension point and runs the task inline to its
  first suspension**, which is a fine design but is stated nowhere a user
  reads; the ASYNC_AWAIT.md execution-model sketch implies it.

### 3.6 Test gaps

Behaviours with NO test today (from the inventory over `tests/`, `std/`,
`tests/cli-cases/`):

- the two panics in F2 (await / spawn of an already-aborted future);
- `abort` of a task suspended in an operation with no cancel path;
- `abort` of a directly spawned raw `IoFuture` (F5);
- a named awaited child under `abort` (F5);
- `FutureState.Running` asserted anywhere;
- a `Future(T)`-typed view of a bundled future (F6);
- a second `io.spawn` of a running future (F3);
- `IoError.from_result` (no callers, no tests) and `IoError.check` (no unit
  test);
- a `JoinHandle` captured into a `Thread.spawn` closure being rejected (only
  the type-level `impls(…, Send) == false` is asserted);
- the "captured outer `io` instead of the closure's `e`" shape has no
  diagnostic and std does it (`std/process/command.yo:591`).

Leak verdicts: CI runs the async corpus with `YO_TEST_LEAK_VERDICT=0`;
`issues/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md` (S2) is the
open record.

## 4. Probe results

Five programs under `tmp/` (gitignored), compiled with the tree binary
(`yo-out/aarch64-apple-darwin/bin/yo`) at `--optimize 2`.

| # | Probe | Result | Record |
| --- | --- | --- | --- |
| 1 | `io.spawn(IO_timer.sleep(30))`, `abort()`, sleep 80 ms, read state and await | `Aborted` right after the abort; `Completed` once the timer fired; `await` returns `.Some` | `issues/fixed/abort-of-a-directly-spawned-raw-io-future-is-undone-by-its-completion.md` (S2) |
| 2 | A user struct with a method named `await`, called as `t.await(io)` | `check` OK; `compile`: ICE "JoinHandle.await return type must be Option(T)" | `issues/a-user-method-named-await-is-lowered-as-join-handle-await-and-ices.md` (S1) |
| 3 | `JoinHandle.await` of an unwound task, then `io.await` of the same future in `main` | `.None`, then `panic: attempted to await an aborted Future` (rc 134) — as documented | §6 Q1, no issue |
| 4 | Two `io.spawn` of one task with bundles `{ io, tell : tell_a }` then `{ io, tell : tell_b }`; the body yields twice then calls `ctx.tell` | `r1=2 r2=2`: the task ran under the second bundle | `issues/fixed/a-second-io-spawn-of-a-running-task-overwrites-its-effect-bundle.md` (S2) |
| 5 | A `Future(i32, Ctx)` passed as `Impl(Future(i32))` and awaited with `io`; the body calls `ctx.raise` | `check` OK; the binary dies with rc 139, `lldb`: `EXC_BAD_ACCESS address=0x0`, frame #0 at `0x0` (a call through the zeroed handler slot) | `issues/fixed/a-bundled-future-viewed-as-future-t-runs-with-a-zeroed-bundle-and-segfaults.md` (S1) |

The reproducers are under `issues/repros/` with the same names.

## 5. Plan

Each phase is one PR with its own gates; A0 and A1 are independent of §6.

### A0 — Repair the contract (docs and docstrings only)

Every row of F7, in both languages, plus the three stale instruction/skill
statements, `tests/async/join_handle.test.yo` 88–90's comments, the
`impl_constraint.yo` and `constants.yo` comments, and ASYNC_AWAIT.md Known
Limitation 2 (drop it, or replace it with a test). Also state the two rules
the docs imply but never say: `io.spawn` runs the task inline to its first
suspension and is not itself a suspension point; the bundle is injected once,
at the cold start. A std docstring edit above a method shifts the
`lsp-member-definition` golden; run `scripts/cli-diff-test.sh` before
merging.

### A1 — `JoinHandle.join` suspends inside a task; the combinators become futures

**As landed (2026-10-03).** Not a new lowering: one runtime primitive and a
std method. `__yo_join_wait_new()` returns a park future and
`__yo_join_wait_add(wait, task)` registers it as one of the task's waiters
(an already-terminal task completes it at once); the task's completion or
abort fires it like any waiter. `JoinHandle.join(io)` (`std/async`) is an
`io.async` body that awaits such a wait and then reads the finished handle
with `await` (which no longer polls), so `io.await(h.join(io), io)` is a real
suspension in a task and the ordinary blocking poll in `main`.
`handle.await(io)` stays the blocking form for plain `fn`s. The combinators
are `io.async` bodies over `join` and the multi-handle wait:

```rust
join_all   : (fn(handles : ArrayList(JoinHandle(T)), io : Io) -> Impl(Future(ArrayList(Option(T)), Io)))
race       : (fn(handles : ArrayList(JoinHandle(T)), io : Io) -> Impl(Future(usize, Io)))
race_first : …  -> Impl(Future(Option(T), Io))
any, any_first, timeout : the same shape; timeout keeps Result(T, TimeoutError)
```

`race` and `timeout` add several handles to one wait ("wake me when ANY of
these finishes"); `any` re-waits over the handles still running, since a wait
with an already-terminal member resolves at once. In `main`,
`io.await(join_all(hs, io), io)` drives the loop exactly as the blocking call
did. The three hand-rolled `is_finished` + `yield` loops
(`std/http/client.yo`, `std/process/command.yo`, `src/build_runner.yo`) are on
the compiler's import path and keep their shape until `SEED_VERSION` carries
the primitive (Generation B in `backlog/SEED_VERSION_AUTOMATION.md`);
`backlog/ASYNC_DEADLINE_COMBINATOR.md` option A is now `timeout` itself. The
`YO_ASYNC_STRICT` panic stays for `handle.await` and any `io.await` in a
plain `fn` called from a task, which remain nested loops.

Signature changes, no shims (AGENTS.md). Gates: `tests/async/combinators.test.yo`
awaits the futures and adds the in-task cases (`join`, `join_all`,
`race_first`, `any`, `timeout` inside `io.async` bodies, under `yo test`'s
`YO_ASYNC_STRICT=1`; aborting a joiner leaves the joined task running), the
two `tests/net/tcp.test.yo` call sites, `fixpoint_only.sh`.

### A2 — One abort semantics (after §6 Q1) — landed 2026-10-03

Recommended: delete both panics. An `io.await` that meets an already-aborted
future takes over the unwind exactly as a waiting await does; `io.spawn` of an
aborted future returns a handle that reads `.None`. The plain-`fn` "silent
zero `T` + escaped flag" row becomes the documented escape rule it already
is for a handler unwind. Tests for every cell of the F2 table.

### A3 — Close the cancellation and injection gaps (F3, F5, F6) — landed 2026-10-03

As landed: the raw-future abort detaches its waiters, calls the backend's
`cancel_fn` and stays Aborted (every backend completion skips -2); `io.spawn`
copies its bundle into a cold future only; a named child is cancelled when the
await that waits on it cold-started it (`__yo_started_child`, non-owning), and
a named future someone else started keeps running; a bundled future is
compatible with `Future(T)` only when the bundle is `Io`, and the await-site
bundle check compares field types. The plan text below is the proposal.


- `_generate_io_spawn`: inject the bundle only on the cold start; a second
  spawn of a running future keeps the running bundle. Add the bundle field
  rule (handler types, `Io`, value types) as an evaluator check, or dup.
- `__yo_future_abort` on a raw `IoFuture` (`vt == NULL`): call
  `__yo_async_io_cancel` directly; every backend completion keeps `-2`.
- Cancel a named awaited child: record the child in the parent's cancel hook
  at the await, not only the anonymous slot.
- `Future(T)` compatibility: a bundle-less static type may not receive a
  bundled future at an await or spawn site (the check must see the dynamic
  bundle), or `Future(T)` is spelled `Future(T, ())` and the empty-list rule
  goes. Recommended: reject at the await (`E0xxx: this future carries a
  bundle the static type does not name`), keep `Future(T)` for raw futures.
- The bundle check compares field TYPES.

### A4 — `IoFuture` hygiene (after §6 Q2) — landed 2026-10-03

As landed: the Windows runtime maps every Winsock code to errno
(`__yo_wsa_to_errno`); resolver failures resolve to one stable `DNS_ERR_*`
code per kind and `NetError.DNSFailed` carries a `DnsError` (fixes
`issues/fixed/stddoc-io-dns-lookup-discards-the-gai-error-code.md`); `io.state`
and `JoinHandle.state` read an in-flight raw future as `Running` (a mapping at
the read, so no backend's state protocol changes); `FutureState.Pending` is
`Cold`; the 16 hand-rolled checks of the exact `cond(r < 0 => throw
from_errno(-r), true => ())` shape in `std/fs` and `std/process` are
`IoError.check`, and the 14 that release resources before throwing keep their
shape; `IoError.check` and `IoError.from_result` have unit tests
(`tests/sys/constants.test.yo`). Not done: `sleep` has no error channel
(`Future(unit)`, no `IoExn`), and its only failures are an allocation failure
and its own cancellation, so it keeps discarding the `i32`. The plan text
below is the proposal.


Keep `IoFuture` a raw `i32` ABI at the `std/sys` layer. Normalise the two
deviant families at the extern boundary so every negative value is an errno
(`sys/dns` maps `EAI_*` to a dedicated `DnsError` at its own wrapper; the
Windows socket paths map WSA codes to errno equivalents in
`runtime_io_windows.yo`). Replace the 48 hand-rolled checks in std with
`IoError.check` / `NetError.check`; give `IoError.check` a unit test; delete
`IoError.from_result` or use it. In-flight raw futures carry `state = 1` so
`io.state` reports `Running` (every backend's submission path sets it; the
await lowering starts a future only when `state == 0 && vt != NULL`, so raw
futures are unaffected). `sleep` checks its result.

### A5 — Representation (seed-gated, already designed) — partly landed 2026-10-03

As landed: the async-builtin matchers consult the call's recorded marker
before the spelling, and evaluation records a "not a builtin" marker for a
user function spelled like one, which fixes two internal compiler errors (a
user method named `await`; a non-`Io` parameter named `io` with an `await`
method — `issues/fixed/a-user-method-named-await-is-lowered-as-join-handle-await-and-ices.md`);
`io.state` takes `E : Type.Struct` like its siblings. Not done here, each for a
reason: the value-struct `JoinHandle` waits for the seed
(`issues/an-owning-join-handle-costs-an-allocation-per-spawn.md`); the
`...(E)` spread was removed on 2026-10-03 (user decision) from `Future`,
function types and the synthesizer, and effect-row polymorphism stays as a
`generic(E : Type.Struct)` parameter
(`issues/fixed/effect-row-spreads-outlived-the-single-bundle-future.md`); a zero-sized `Io` is a measurement
for `ASYNC_PERFORMANCE_HANDOVER.md`, not an API change. The plan text below is
the proposal.


`JoinHandle` as a value struct over the counted `Impl(Future)` (the open
issue), `io.state` to `E : Type.Struct`, drop the `...(E)` spread, the
syntactic `x.await` routing replaced by the `__yo_join_handle_await` marker,
and a zero-sized `Io` measured on the spawn and await rows of
`ASYNC_STATE_MACHINE_GENERATION.md` §3.4.

## 6. Decisions (2026-10-03, the user took each recommendation)

- **Q1 (A2) — propagate.** An `io.await` / `io.spawn` of an already-aborted
  future propagates the abort; the state-machine behaviour becomes the only
  behaviour and both panics go.
- **Q2 (A4) — raw `i32` stays.** std normalises at the wrapper (zero cost, no
  seed gate); the typed `Result(i32, IoError)` channel at the extern boundary
  is not pursued.
- **Q3 (A1) — handles only.** A future has no identity until started, and a
  handle is what "a running task" means; the combinators do not spawn.
- **Q4 (F8) — rename.** `FutureState.Pending` becomes `FutureState.Cold`
  (the word every doc already uses for a not-started future), in A4 with the
  `Running` fix, no compatibility kept.

## 7. Exit criteria

- Every row of F7 points at one statement of the contract, and
  `docs/en-US/ASYNC_AWAIT.md` is that statement.
- `join_all`/`race`/`timeout` run inside an `io.async` body under
  `YO_ASYNC_STRICT=1`; `std/http/client.yo`, `std/process/command.yo` and
  `src/build_runner.yo` contain no `is_finished` + `yield` loop.
- Each cell of the F2 table and each item of §3.6 has a test.
- A spawned raw `IoFuture` aborted before completion reads `Aborted` after
  the operation would have completed, on every backend.
- The 29 + 19 hand-rolled errno checks in std are `IoError.check`.
