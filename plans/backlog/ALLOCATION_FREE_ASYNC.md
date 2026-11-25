# Allocation-free async: a future value is cold and movable, a started future is a place that never moves

**Status: BACKLOG — decided 2026-11-25 by VERDICTS-81 (Fable 5.2), adopted in
full by the coordinator on the maintainer's request for the best
allocation-free design with no backward compatibility. Nothing is built.
AFA-0 (this plan, a benchmark, the guard rails) lands in v0.2.81–82; code
starts at v0.2.83 and ends around v0.2.87.** The fact base is `origin/develop`
`1ce232268`. The probes ran on a develop binary carrying the E0614 rider
(VERDICTS-80), with its own std; their sources and logs are the
`v81-probes/` directory of the verdict (`MEASURED.txt`).

This plan answers one question: how does a Yo future stop being a separately
allocated, reference-counted cell, without `Pin`, without immovable types and
without a rule against borrowing a body local across an `await`? It also
answers the open question
[`issues/questions/2026-11-25-finish-or-retract-the-impl-future-slot-as-the-erased-future.md`](../../issues/questions/2026-11-25-finish-or-retract-the-impl-future-slot-as-the-erased-future.md):
**retract** (B). `Impl(Future(T, E))` becomes static dispatch at every slot,
and the erased future gets its own type, `BoxFuture(T, E)`.

Related: [`IO_INTERFACE_AND_STD_RUNTIME`](IO_INTERFACE_AND_STD_RUNTIME.md) (the
executor ABI, §3, and the schedule IO-1a/b/c this plan must not disturb),
[`ASYNC_AWAIT_SITE_FUSION`](../reference/ASYNC_AWAIT_SITE_FUSION.md) (landed
fusion), [`REFERENCES_AND_ORIGINS`](REFERENCES_AND_ORIGINS.md) (O5, no
self-reference), [`ALLOCATOR_PLACEMENT`](../reference/ALLOCATOR_PLACEMENT.md)
(the `alloc` argument's rule), [`NO_LIBC_BY_DEFAULT`](NO_LIBC_BY_DEFAULT.md)
(P4, AFA-9's ordering), [`VALUES_BY_DEFAULT`](../VALUES_BY_DEFAULT.md)
(decision 40).

## 0. What is true today

Every `io.async(...)` block is one C state-machine struct, allocated as a heap
cell when the future is created, with a `__yo_ref_header_t` first. The future
value is a pointer to that cell; creating a future allocates, dropping one
frees or releases it, and `await`, `spawn` and the executor's continuation
slot each hold a reference. Four mechanisms already cut the cost:

- **Per-type pools** recycle the cells, so the steady-state `malloc` count of
  an await chain is zero.
- **Await-site fusion** ([`ASYNC_AWAIT_SITE_FUSION`](../reference/ASYNC_AWAIT_SITE_FUSION.md))
  puts std's I/O at 1.00–1.01 of the raw operation.
- **`sync_fut_t`** replaces the state machine of a block with no `await`.
- **The future prefix** (`__YO_FUTURE_PREFIX`: header, state, vtable,
  continuation pair) is on every future, so the executor treats every future
  alike.

A by-value `Impl(Future(T, E))` parameter is **erased, not monomorphized**:
one state machine serves every argument (`src/types/guards.yo:921`). A struct
field typed `Impl(Future(...))` is the one slot that already erases, through
`_future_field_upcast` (`src/codegen/exprs/other-fn-call.yo`).

### Measured (VERDICTS-81 probes, x86_64 WSL2, 2026-11-25)

| Fact | Result |
| --- | --- |
| `p1`: a body-local `&mut buf` lent to a child future, and a body-local reference live across an await | `check` OK, runs under ASan. Legal today because the frame is a stable heap cell |
| `p2`: 100,000 × (one two-await `mid`, two two-await `leaf`, four no-await blocks), awaited in sequence | **5 mallocs more than N=0** (the per-type pools already remove malloc); **1,412 instructions and ~92 ns per iteration**, about 200 instructions per cold future |
| `m1`: the same shape hand-written in C as the proposed lowering. A model: no abort checks, no drops | **160 instructions, ~8.5 ns per iteration**; the whole task is one 136-byte block (header 40 + `mid` 96, which contains `leaf` 64, which contains `inner` 32) |
| `p7`: `twice(f : Impl(Future(i32, Io)), io)` called with two different futures | one state machine for `twice`: a by-value future parameter is **erased today, not monomorphized** (`src/types/guards.yo:921`) |
| `p8`: who computes a size | the evaluator (`size_of(S)` works as an array length); an unknown size already lowers to C `sizeof` (`src/evaluator/builtins/sizeof.yo`) |
| `p4`: recursive async `fib(15)` | runs; one cell per level |
| `p9`: `impl(My, Future(i32, Io)())` on a user struct, then `io.await(My(...), io)` | E0602 at the await: a future cannot be implemented by hand. The impl itself is accepted silently (filed S3: `issues/2026-11-25-an-impl-of-future-on-a-user-type-is-accepted-and-does-nothing.md`) |
| census (`git grep`, develop `1ce232268`) | struct fields typed `Impl(Future(...))` in `std/` and `src/`: **0** (`tests/async-await.test.yo` only). `IoFuture` outside `std/sys`: `std/async/index.yo` and `waker.yo`. `unsafe(io.spawn(` in std: 3 (`timeout`, `select` ×2). `io.state(` in std and src: 1, in tests: 8. `io.async(` in std: 191 |

"Allocation-free" is therefore **not** about `malloc` on the await path; the
pools already took that. What remains per cold future is a pool take and
give, a reference count, a vtable call, a continuation registration and a
dispose dispatch. The prize is roughly 9× on chains that complete without
parking (`m1`, a model, not compiler output), one block per task whose size
the C compiler knows, and no cell at all for a task driven from a sync
`main`. Syscall-bound I/O will not move: fusion already put std at 1.00–1.01
of the raw operation.

## 1. The invariant

**A value of future type is always cold: it holds its captures and nothing
else, and it moves by memcpy like any value. Starting it (`io.await`,
`io.spawn`) consumes it into a place that never moves. A started future is
not a value, so nothing can move it.** No `Pin`, no immovable types, no
`?Move` bound, no ban on borrows across an `await`. The mechanism is a
typestate the language already has (consume on use, A1); the verdict's
confidence is 0.85.

**The induction.**

1. *A future value is cold.* `io.await` and `io.spawn` consume it (A1, landed
   2026-10-12; a second use is E0901). `io.state(&f)` of a bound future is
   `Cold` (`p7`).
2. *A cold future points only outward.* Its type `Future(T, E, p)` names only
   its captures (O5, O8).
3. *Starting consumes into one of four places*, and none moves once started:
   - a **task block** (what `io.spawn` allocates);
   - the **await slot** of a frame that is itself started;
   - the **stack slot of a blocking await** in a sync context, which returns
     only when the future is terminal;
   - a **`BoxFuture` block**.
4. *A borrow of a body local across an `await`* has its origin inside the
   body and never reaches the future's type, so it cannot outlive the frame.
   This is O5's argument unchanged.

**Amended sentences.** Decision 40's HEAP-STORAGE list, which names "a started
state machine" as a heap cell, becomes: *a started state machine keeps its
address from its start to its release; a cold future is an inline value and
is relocated by a move.* O5's "an async state machine is a heap cell that
never relocates" is restated the same way, "heap cell" replaced by "started
place". The one hot, movable future today is `IoFuture` (the operation is
submitted at the call); it stays a heap cell until AFA-8 makes `std/sys`
operations cold like every other future.

**How the invariant handles each case.**

- **`buf` + `io.await(stream.read(&mut buf, io), io)`.** `buf` is a slot of
  the awaiter's frame. The read's cold future captures `&mut buf`, is moved
  into the await slot of the same frame and started there. No cell. Accepted
  exactly as today (`p1`).
- **Recursion.** A frame that would contain itself is an error at the await,
  found on the evaluator's await graph, so `yo check` reports it (§2).
- **`spawn`.** One block: the task header plus the root frame. The compiler
  allocates it at the `io.spawn` site and then calls
  `io.vtable.spawn(io.ctx, block)`.
- **`JoinHandle(T)`.** One pointer to the task header. Move-only, detaches on
  drop. Unchanged.
- **`select`, `timeout`, `both`.** Each operand runs as a *scoped child*: a
  task header plus frame embedded in the combinator's own frame, started
  through one builtin, `io.spawn_scoped` (§2). Its handle cannot leave the
  frame, which the second-class rules of VALUES_BY_DEFAULT §3.13 A2 already
  express. It replaces std's three `unsafe(io.spawn(...))` and `_Scoped`, so
  a borrowing operand becomes safe by construction instead of by convention.
- **`join_all`, `race`.** A run-time number of tasks: `ArrayList(JoinHandle(T))`,
  one block per task. This is the "where possible" limit of the design.
- **Effect bundles.** `io.await(f, e)` stores `e` into the frame's bundle slot
  with a typed assignment. `vt.bundle_offset` and `set_effect` remain only for
  a `BoxFuture`, whose `E` is in its type.
- **Abort and `unwind`.** A child's resume returns pending, ready or aborted,
  and the parent propagates statically. `JoinHandle.abort()` marks the header
  and runs the root's generated abort walk: a switch on the state that drops
  the live locals in place and descends into the live child, down to the
  operation's cancel.
- **Drop.** Dropping a cold future drops its captures; there is no cell. A
  started child is dropped only through its task.
- **Threads.** A cold future is a plain value, so it is `Send` when its
  captures are. Moving an unstarted task to a pool thread stops needing an
  atomic task kind (IO plan §7's deferred item, prerequisite 2).

## 2. The surface

### `Impl(Future(T, E))` is static dispatch

`Impl(Future(T, E))` means one concrete type per slot, like every other
`Impl(Trait)`. A parameter is generic over it (so a by-value future parameter
is monomorphized, which `p7` shows it is not today). A result is the
function's one future. These are rejected, each with a one-line fix:

1. an **unboxed cycle** in the await graph (recursion);
2. **two different futures at one slot** (two `cond` arms, a reassigned local);
3. an **`Impl(Future(...))` struct field**, like any other `Impl` field (zero
   uses in `std/` and `src/`);
4. a **`Dyn` trait method or a function-pointer type whose result is
   `Impl(Future(...))`**.

That closes four open issues by one rule: the `cond`-arms S2 and the list of
async function values (`issues/2026-10-25-a-list-of-async-function-values-does-not-compile.md`),
plus VERDICTS-80's `j2` and `j3` (the `Box(Dyn(Fn(...)))` future-result pair
filed 2026-11-25).

The diagnostic texts below are drafts; their codes are assigned in AFA-5 and
the cli goldens record the final wording.

```text
error: the future of `fib` awaits itself by value (fib -> fib)
  help: box the recursive call: io.await(BoxFuture.new(fib(n - i32(1), io)), io)

error: two different futures flow into one `Impl(Future(i32, Io))` slot
  help: a slot holds one future; use BoxFuture(i32, Io) to hold either

error: a struct field cannot be typed `Impl(Future(i32, Io))`
  help: store a BoxFuture(i32, Io), or a JoinHandle(i32) for a running task

error: a `Dyn` method or function-pointer type cannot return `Impl(Future(i32, Io))`
  help: return BoxFuture(i32, Io)
```

The recursion repair is explicit and `yo fix` can write it (Q2).
VERDICTS-80's E0614 (`Dyn(Future(...))` is rejected) stands.

### `BoxFuture(T, E)`

`BoxFuture(T, E)` (`BoxFuture(T, E, p)` when it borrows) is one owning pointer
to a block laid out like a task: header, then frame. It is the erased cold
future. VERDICTS-80's reasoning still holds: the table is in the prefix, so
there is no `Dyn` pair. `io.await(b, e)` starts it in its block;
`io.spawn(b, e)` makes that block the task, with no second allocation.

```yo ignore
mut(jobs) := ArrayList(BoxFuture(i32, Io)).new();          // Rust's Vec<Pin<Box<dyn Future<Output = i32>>>>: cold, erased
jobs.push(BoxFuture.new(one(io)));
jobs.push(BoxFuture.new(two(i32(41), io), alloc : .Some(a)));
mut(hs) := ArrayList(JoinHandle(i32)).new();               // the same, already running
hs.push(io.spawn(one(io), io));
```

### `io.spawn(..., alloc)` and `io.spawn_scoped`

- `io.spawn(f, e, alloc : .Some(a))` places the task block, as `Box.new`
  does (ALLOCATOR_PLACEMENT's rule). The default is the global allocator; the
  per-type pools keep working on task blocks. A sync-context await uses the
  caller's stack. Static slots in Embassy's style come first through the
  `alloc` argument with a `FixedBufferAllocator` or `MemoryPool`; a typed
  `TaskPool(F, N)` needs a way to name an async function's future type and
  waits for an embedded target to ask for it (Q7).
- `io.spawn_scoped(f, e)` starts a scoped child in the calling frame and
  returns a handle that cannot leave the frame. `select`, `timeout` and
  `both` stay std functions built on it (Q3).
- `io.state(&f)` on a future always answers `Cold` under this design, so it is
  deleted; `JoinHandle.state()` stays (Q4).

## 3. The lowering

One `io.async` block gets **two C types**: the *value* (its captures; the
evaluator knows the size) and the *frame* (state, locals, one union of its
children's frames; only the C compiler knows the size). The future prefix
moves from every future to every **task**.

```c
struct leaf_frame { int state; captures c; Io bundle; /* locals live across an await */ };
struct mid_frame  { int state; captures c; Io bundle; int32_t a;
                    union { struct leaf_frame leaf; __yo_io_future_t* io; void* boxed; } slot; };
struct mid_task   { __YO_FUTURE_PREFIX struct mid_frame root; int32_t result; };   // what spawn allocates
static int leaf_resume(struct leaf_frame* f, __yo_future_header_t* task);          // direct call from mid_resume
```

- **Sizes.** The value of `Impl(Future(T, E))` is the capture struct, sized
  by the evaluator like a closure, so `size_of`, moves and generic containers
  need nothing new (`p8`). The frame is sized by the C compiler through
  struct nesting; the evaluator never needs it. Codegen needs children
  emitted before parents, and the await graph to be acyclic.
- **Why captures only, not Rust's whole machine.** Rust's future value is the
  full state machine, so moving a large cold future copies all of it. Yo's
  start is already lazy, so the frame can be built in its final place from the
  captures. This is `std::execution`'s sender and operation state.
- **The await-slot union.** A parent frame is its own slots plus the largest
  child, not the sum, because the await slot is a union.
- **Resume protocol.** `resume(frame, task)` returns pending, ready or
  aborted. A parent calls its static child's `resume` directly, which the C
  compiler can inline. Embedded children carry no prefix and no continuation.
- **Wake-up.** An operation's continuation is the task (root resume, header).
  The root re-enters through its state switch with direct calls.
- **Abort walk.** Per frame, a generated switch on the state drops the live
  locals in place and descends into the live child, down to the operation's
  cancel (§1, "Abort and `unwind`").
- **Task header.** The prefix of §4 on the task block only: the executor's
  view of a running task. A `BoxFuture` block is laid out like a task.
- **`--max-frame-size N`** emits `_Static_assert(sizeof(frame) <= N)` under the
  block's `#line`, so the C compiler reports the offender. `BoxFuture.new`
  cuts a chain by hand.
- **ASan.** The test runner builds with ASan, and an embedded child is inside
  a live block. Codegen poisons a finished child's slot under
  `__SANITIZE_ADDRESS__`.
- **Stack frames.** A sync-context await places the frame on the caller's
  stack and drives it to a terminal state.

## 4. The ABI

**IO-1b's interface does not change.** `spawn(ctx, fut : *void)` and
`run_until(ctx, fut : *void)` take a prefix pointer, and under this design
that pointer is a *task header*: the start of a heap block, of a `BoxFuture`
block, of a stack slot, or of a scoped child inside another task's block. The
executor never allocated the task and still does not. `now` is unaffected.
[`IO_INTERFACE_AND_STD_RUNTIME`](IO_INTERFACE_AND_STD_RUNTIME.md) §3 is
restated for task headers when AFA-3 lands.

**The operation entries** (`read`, `sleep`, `park`, … `-> IoFuture`) return a
heap cell. That stays correct through AFA-7. Their final shape starts the
operation in a slot the caller owns,

```yo ignore
read : (fn(ctx : ?*void, op : *IoOp, fd : i32, ...) -> unit)
```

and a fake `Io` then completes `op` inline instead of allocating
`IoFuture.completed(n)`. IO-1b cannot ship that shape: the v0.2.80 seed fills
the native table from `__yo_async_<op>_start`, which return a cell, and no
lowering awaits an in-place operation yet. The later flip (AFA-8) is a
Generation A/B/C triple over a file set that IO-1b keeps small.

**The five guard rails IO-1b and IO-1c must respect:**

1. **No `io.vtable.<op>` call and no `IoFuture` in a signature outside
   `std/sys`** (today: `std/async/index.yo` and `waker.yo` only). Add a grep
   gate. Then the in-place flip rewrites `std/sys` and two files.
2. **Std above `std/sys` awaits an operation only as the direct operand of
   `io.await`.** A bound `IoFuture` relies on the operation being submitted
   at the call, which the cold form ends.
3. **The IO plan's §3 says "every task and every separately allocated future
   starts with the prefix", not "every future".** No new runtime code may
   assume an awaited child has a header (an abort registry walking children,
   a waker holding a child).
4. **The executor releases a task only through its header** (the count and
   the dispose dispatch), never `free(fut)`, and never asks for its size. A
   prefix pointer may point inside another block.
5. **`spawn` and `run_until` in a Yo-written `Io` forward `fut` to another
   `Io`'s entry.** They never read, start, retain or free it (rule 4 of the
   IO plan, said about these two entries). **`std/io/sim`'s operation
   decorators do not ship before AFA-8 decides the operation shape.**

**The lingering rule (written into the IO plan's §3 when AFA-8 lands).** *An
aborted task's block is released when its last in-flight operation retires.*
Today an operation the backend refuses to cancel lives on as its own cell
(`__yo_async_io_cancel`); in a frame, the block must linger instead. The
header's count already expresses it. Q6 (adopted): the rule is confirmed, and
today's io_uring behaviour for a read into a buffer that lives in the frame of
a task aborted mid-read is investigated now, in its own lane, because it is a
potential S1 independent of this plan.

**Wakers.** A waker holds a task header, never a child frame (guard rail 3).

## 5. Stages and gates

**Why not now.** IO-1a/b/c change the `spawn` and sync-context `await`
lowerings through v0.2.82, the removal of implicit dup/drop (VERDICTS-70)
moves through codegen in the same releases, and the reference checker still
lands several S1 fixes a day in the rules this design leans on. A second
rewrite of the same files in the same releases is the risk; nothing is lost by
waiting, because §4 shows IO-1b closes no door. **Why not later than v0.2.83.**
Decision 3 changes what `Impl(Future)` means, and every release adds code
written against the erased meaning; the question file's option A would be
built and then reverted.

The seed column says which generation the PR needs: A (compiler), B (std on
the new seed), C (deletion once the seed carries it). Seed gating in one
line: AFA-1 to AFA-3 change no prelude or std text. Everything that adds a
name std must spell (`BoxFuture`, `io.spawn_scoped`, `alloc` on `spawn`,
`IoOp`) lands as a compiler builtin one release before std uses it.

| PR | Release | Seed | Content | Acceptance |
| --- | --- | --- | --- | --- |
| **AFA-0** | v0.2.81–82 | no | This plan. `scripts/bench/async-chain.yo` (`p2`), a `select`/`timeout`/spawn bench, a channel ping-pong. `YO_ASYNC_STATS=1`: frames started as cell / embedded / fused, cells per task. The question file answered B. §4's guard rails in IO-1b | The baseline table below: 1,412 instructions per iteration; 1 cell per cold await, 1 per I/O call, per `select` and per `timeout` (counted) |
| **AFA-1** | v0.2.83 | no | Evaluator: each `io.async` instance is its own concrete type; a by-value `Impl(Future)` parameter is generic; the await graph and its cycles are recorded. No frame change | The async emit-diff changes only in instances of future-taking generics. Printed: share of await sites with a static child in `std/` and `src/`, the cycles, the instance count, `yo.c` size and C-compile RSS |
| **AFA-2** | v0.2.83 | no | Codegen: the future value is the capture struct; the frame cell is allocated at the start | A future made and dropped costs 0 cells. The async suites. `async-chain` no slower |
| **AFA-3** | v0.2.83–84 | no | Embedding: the child frame in the await-slot union for a static, acyclic operand; `resume(frame, task)`; the static abort walk; stack frames for sync-context awaits; ASan poisoning; `--max-frame-size`. A cycle still falls back to a cell. `YO_ASYNC_EMBED=0` for one release | `async-chain` ≤ 400 instructions per iteration (model 160). 0 cells per await at static sites. Pools off under valgrind: allocations = tasks + a constant. `std-vs-raw` stays 1.00–1.01; `bench-vs-libuv.sh` rows and `io-floors.env` no worse. Then measure fusion off: if within noise, delete fusion |
| **AFA-4** | with AFA-3 | A | `BoxFuture` in the compiler: the builtins, await in the box, `io.spawn` of a box reuses its block; `io.spawn_scoped` and the `alloc` argument of `io.spawn` | Tests call the `__yo_*` builtins directly; a cli-case |
| **AFA-5** | next release | B | The prelude declares `BoxFuture`; `std/`, `src/` and tests box their recursion (`yo fix`). The compiler rejects: an unboxed cycle, two futures at one slot, an `Impl(Future)` field, a `Dyn` method or function-pointer type returning `Impl(Future)` | The four issues move to `issues/fixed/`. cli goldens for the four diagnostics |
| **AFA-6** | with AFA-5 | B | std: `select`, `timeout` and `both` on scoped children; `_Scoped` and the three `unsafe` go; the prelude's `spawn` takes `alloc` | `select` and `timeout`: 0 cells (today, read from `std/async/index.yo`: a task cell per operand, a join-wait cell per wait, two join futures, and for `timeout` a deadline task, its timer and an `Rc`; AFA-0 counts them). The timeout bench |
| **AFA-7** | next | C | Delete the cell fallback, the erased-parameter lowering, `_future_field_upcast`, `YO_ASYNC_EMBED` | `check ./src`; the same files |
| **AFA-8** | after AFA-7 | A, B, C | In-place operations for the executor entries: `IoOp`, `yield`, `park`, `sleep`, the join wait. The lingering rule | Channel ping-pong, `Mutex.lock` and a `yield` loop: 1 cell per operation → 0 |
| **AFA-9** | gated on AFA-8's numbers | A, B, C | The ~90 backend entries on four backends, ordered against NO_LIBC P4 | Mallocs per std I/O call 1 → 0; `bench-vs-libuv.sh`; `LINUX_ASYNC_IO_PERFORMANCE.md` §4 |

### Benchmark table (filled in per stage)

Each stage appends its measured column; the baseline is AFA-0's. The target
column is the stage's acceptance number.

| Measure | Baseline (VERDICTS-81 probes; AFA-0 re-measures on `async-chain`) | Target | Stage |
| --- | --- | --- | --- |
| instructions per `p2` iteration | 1,412 (~92 ns) | ≤ 400 (model `m1`: 160, ~8.5 ns) | AFA-3 |
| cells per cold await at a static site | 1 | 0 | AFA-3 |
| cells per `select` / `timeout` | counted by AFA-0 (a task cell per operand, a join-wait cell per wait, two join futures; `timeout` adds a deadline task, its timer and an `Rc`) | 0 | AFA-6 |
| cells per executor operation (`yield`, `park`, `sleep`, join wait, channel ping-pong, `Mutex.lock`) | 1 | 0 | AFA-8 |
| mallocs per std I/O call | 1 | 0 | AFA-9 |
| std I/O versus the raw operation (`std-vs-raw`) | 1.00–1.01 | no worse | every stage |

## 6. Rejected

| Option | Verdict |
| --- | --- |
| **(a) Immovable types.** Sound only if every generic move point is checked; it reopens decision 40 with a third kind of value | Every `T` gains an implicit `Move`, and `Option.take`, `replace`, `swap` and every growing container need the opt-out. It needs a result place for every expression form (out-pointer returns, in-place `cond`/`match` arms, nested field init) and a new error family at every move of a `T`. It buys a started future as a first-class value, which only a user-written `poll` or an intrusive list written in Yo would need: `Future` has no methods and cannot be implemented by hand (`p9`), and the runtime is C. Revisit only if the IO plan's §5 experiment ports a backend to Yo, and even there raw pointers under `Pragma.AllowUnsafe` are enough |
| **(b) `Pin`.** Sound only with `unsafe` projection | Contradicts decision 40 and O5; needs a user-callable `poll` that Yo does not have, an `Unpin` auto-trait and projection rules. `Pin` polices moving a value that points into itself; Rust needs it because a future is polled through a reference the user holds. In Yo the only operations on a future are consume (`await`, `spawn`), borrow for `state`, and drop |
| **(c) No borrow into the frame across an `await`.** Sound | Reverses O5's 2026-10-20 correction and makes `p1` an error. It forces `buf` out of the frame and into a `Box`, which adds an allocation. The restriction is true for free where it matters: a cold future has run no code, so nothing points into it |
| **Rust's whole-machine future value** | Moving a large cold future copies all of it. Yo's start is already lazy, so the frame can be built in its final place from the captures (§3) |
| **Erasing every `Impl(Future)` slot** (the question file's option A) | `Impl(Trait)` stays static dispatch everywhere, with no future-only exception to teach. The erased form has its own spelling, `BoxFuture`, so the cost is visible at the use site (explicit over implicit). It would be built and then reverted if AFA changed the meaning later |
| **`Dyn(Future)`** | Rejected by VERDICTS-80 (E0614) and unchanged: the table is in the prefix, so a `Dyn` fat pointer would only duplicate it. `BoxFuture` is the erased form |
| **Leaving the question file's option C** (fields erase, nothing else does) | Leaves four failures open as separate bugs, each fixed or rejected on its own, and keeps the one future-only exception |

## 7. Open questions, and the documentation that changes

Answers are the maintainer's adoption of 2026-11-25.

| | Question | Adopted |
| --- | --- | --- |
| **Q1** | The erased future's name | `BoxFuture(T, E)` |
| **Q2** | Unboxed recursion | An error plus a `yo fix` repair; not silent boxing |
| **Q3** | The scoped child | `io.spawn_scoped(f, e)` returning a handle bound to the frame; `select` and `timeout` stay std functions |
| **Q4** | `io.state(&f)` always answers `Cold` | Delete it and keep `JoinHandle.state()` (1 use in `std/` and `src/`, 8 in tests) |
| **Q5** | Is 0 mallocs per syscall-bound operation worth ~90 entries on four backends? | Decided on AFA-8's numbers; the maintainer leans towards allocation-free, so AFA-9 is the default unless the numbers show no gain |
| **Q6** | Lingering | The rule of §4 is confirmed, and today's io_uring behaviour on abort is investigated now (a potential S1, its own lane) |
| **Q7** | Static task slots wait for an embedded target (§2) | Agreed |

**Documentation that changes when AFA lands** (not edited by AFA-0; the user
docs describe only the current language): `docs/en-US/ASYNC_AWAIT.md` and its
`zh-CN` twin ("Memory Management" and "`Impl(Future(T))` Dispatch and
Allocation Model"), `docs/*/OWNERSHIP_AND_BORROWING.md`'s `pinning` row,
`pack/context.md`, and `yo explain` text for the four new diagnostics.
Decision 40 and O5 in `VALUES_BY_DEFAULT.md` and `REFERENCES_AND_ORIGINS.md`
take the amended sentence of §1 in AFA-3.
