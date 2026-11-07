# `Io` becomes an interface value; the runtime stays emitted C as its native implementation

**Status: BACKLOG — decided 2026-11-07 (VERDICTS-32, maintainer adopted). The
code lands after VALUES_BY_DEFAULT (v0.2.80–v0.2.82) and before
[`NO_LIBC_BY_DEFAULT`](NO_LIBC_BY_DEFAULT.md) P0b. The documentation
corrections landed inside VBD, with this plan.**

The maintainer asked, on 2026-11-07:

> As we plan to do NO_LIBC_BY_DEFAULT, should we extract our runtime to be part
> of std, like make our current async Io a std lib? Right now the entry point
> for our async Io is the main function parameter `main :: (fn(io : Io) -> unit)`.
> Should we make it more like how Zig handles `std.Io`?

The question has two halves, and they get different answers:

1. **Should `Io` take Zig's shape?** Yes. `Io` becomes a value made of a
   context and a function table, like `Allocator`. It carries every
   operation the event loop mediates.
2. **Should the runtime move into std, written in Yo?** No, not now. The
   emitted C runtime becomes the *native implementation* of that interface,
   behind an ABI that this plan writes down. One backend is ported to Yo as a
   measured experiment after NO_LIBC P9; nothing else is.

Companion: [`THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md`](THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md),
the parallelism half of the same consult.

## 0. What is true today (develop, 2026-11-07)

- **`Io` is four `fn` fields** (`std/prelude.yo`, the `Io :: struct(async,
  await, state, spawn)` definition): `Copy`, `!Send`, `!Sync`. Its one
  instance, `__yo_builtin_io`, binds them to the `__yo_io_*` compiler
  builtins.
- **The value is never read.** The main wrapper passes every `main` parameter
  as `(T){0}` (`src/codegen/functions/generation.yo`, `_main_call_args`).
  `io.async`, `io.await`, `io.spawn` and `io.state` are recognised by a marker
  the evaluator records when the callee resolves to `__yo_io_async` and its
  siblings (`src/evaluator/async/await_analysis.yo`, `is_io_async_call`). At
  run time, "the event loop" is a `_Thread_local` (`runtime_core.yo`,
  `static _Thread_local __yo_loop_t __yo_this_loop`).
- **`io` is already in every async signature.** `io : Io` appears 298 times in
  27 std files and 256 times in `src/`, and 66 test files declare
  `main :: (fn(io : Io …`. `File.open(path, mode, io)`,
  `write_string(self, data, io)` and `sleep(duration, io)` all take it,
  because their bodies are `io.async` literals.
- **The layer under them takes no `io`.** The 90 `__yo_async_*_start` externs
  (`std/sys/externs.yo`) and their `std/sys` wrappers (`openat(dirfd, path,
  flags, mode) -> IoFuture`) submit to the hidden per-thread reactor.
- **The runtime is 18,371 lines of C emitted from Yo string templates:**

  | File | Lines |
  | --- | ---: |
  | `runtime_core.yo` | 1,495 |
  | `runtime_io_common.yo` | 2,759 |
  | `runtime_io_linux.yo` | 4,207 |
  | `runtime_io_macos.yo` | 2,459 |
  | `runtime_io_windows.yo` | 5,972 |
  | `runtime_io_wasm.yo` | 936 |
  | `parallelism/runtime.yo` | 543 |

  The executor already calls its backend through a small seam:
  `__yo_io_init`, `__yo_io_loop_start`, `__yo_io_cleanup`,
  `__yo_has_pending_io`, `__yo_io_poll`, `__yo_io_wait` and
  `__yo_io_notify(loop)`.

So today `io` is a type-level capability token. The reactor it stands for is
found through the thread, not through the value. That is dynamic scoping, the
property that `plans/backlog/ALLOCATOR_PLACEMENT.md` §0 deleted from
allocators when it removed `with_allocator`.

## 1. The four rules

1. **Every operation that suspends a task or submits work to the reactor is
   an entry in the `Io` vtable, and takes `io`.**
2. **A blocking syscall is not an `Io` operation.** `println`/`print`,
   `std/env`, `std/process.exit`, `Instant.now`, `sleep_blocking` and
   `std/libc/*` take no `io`. In short: **`io` gates what the event loop
   mediates.** No `Io` implementation could intercept a blocking call without
   owning the thread.
3. **An `Io` value is valid only on the thread whose loop it names.** It is
   `!Send` and `!Sync`. A task body's `io` is the one its awaiter passed in
   the effect bundle.
4. **A Yo-written `Io` is a decorator or a complete table.** It builds its
   futures from `IoFuture.completed(r)` and from `park` plus a `Waker`. It
   never builds them from the state-machine ABI (§3).

## 2. The surface

```yo ignore
/// The event loop and its reactor, as a value: an opaque context plus an
/// immortal vtable (two words, `Copy`). Valid only on the thread whose loop
/// `ctx` names, which is what `!Send`/`!Sync` enforce.
IoVTable :: struct(
  // executor
  spawn : (fn(ctx : ?*void, fut : *void) -> unit),        // start a cold future as a task on this loop
  run_until : (fn(ctx : ?*void, fut : *void) -> unit),    // drive this loop until `fut` is terminal (sync contexts)
  now : (fn(ctx : ?*void) -> u64),                        // the loop's monotonic clock, ns
  sleep : (fn(ctx : ?*void, ms : u64) -> IoFuture),
  park : (fn(ctx : ?*void) -> IoFuture),                  // the primitive every Yo-written op is built from
  // fs: today's __yo_async_*_start set, verbatim, each with a leading ctx
  openat : (fn(ctx : ?*void, dirfd : i32, path : *u8, flags : i32, mode : i32) -> IoFuture),
  read : (fn(ctx : ?*void, fd : i32, buffer : *u8, size : u32, offset : u64) -> IoFuture),
  // … statx, getdents, mkdirat, unlinkat, renameat, fsync, ftruncate, …
  // net: socket, bind, listen, accept, connect, send, recv, sendto, recvfrom, shutdown, setsockopt, getsockopt, …
  // process: spawn_cwd, wait, …; watch: poll_add, fs_event, …; dns: lookup
);
Io :: struct(ctx : ?*void, vtable : *IoVTable);
derive(Io, Copy, Clone);
impl(Io, !Send());
impl(Io, !Sync());
impl(
  Io,
  /// Compiler operations: the bodies are the `__yo_io_*` builtins, recognised
  /// by the extern marker as today (await_analysis.yo), not by a field.
  async : __yo_io_async,
  await : __yo_io_await,
  state : __yo_io_state,
  spawn : __yo_io_spawn,
  /// The calling thread's native loop and reactor: the value `main` received,
  /// and the one a `Thread` or pool worker is handed. Pragma-gated: ordinary
  /// code takes `io` as an argument and never constructs one.
  native : (fn() -> Io)(…)      // under Pragma.AllowUnsafe; extern __yo_io_native()
);
```

- **`main` receives `io : Io`, as today.** The wrapper emits
  `__yo_user_main(__yo_io_native())` instead of `(Io){0}`. That is one line in
  `_main_call_args`, keyed on the parameter's type being `Io`. A sync
  `main :: (fn() -> unit)` stays legal and links no reactor.
- **A thread builds its own `Io`.** `Thread(T).spawn`'s entry, a pool
  worker's entry and `spawn_blocking`'s thread each call
  `__yo_async_scheduler_init()`, then hand `__yo_io_native()` to the task.
  `Thread(T).spawn`'s signature is unchanged (`FnOnce(io : Io) -> T, Send`).
- **`__yo_builtin_io` is deleted.** Its users write `Io.native()` under the
  pragma: the test runner's batch main (`src/main.yo`,
  `io :: __yo_builtin_io`), and any program that wants async from a sync
  `main`. The call is explicit, rare and visible.
- **`IoFuture` and `IoVTable` move into the prelude, beside `Io`.**
  `std/sys/future.yo` keeps re-exporting `IoFuture`. The native table is
  `extern("Yo", __yo_io_native_vtable : IoVTable)`, emitted by the backend
  selected at emit time, with the executor entries from `runtime_core.yo`.
- **Every `std/sys` operation gains the argument.**
  `openat(dirfd, path, flags, mode, io) -> IoFuture` becomes
  `io.vtable.openat(io.ctx, …)`. `std/fs`, `std/net`, `std/time/sleep`,
  `std/process` and `std/async` forward the `io` they already hold, so **no
  signature above `std/sys` gains a parameter**.
- **Two runtime additions make a Yo-written `Io` possible:**
  - `IoFuture.completed(result : i32) -> IoFuture`, a future born
    completed (`state = -1`, `result = r`). A fake `read` returns
    `IoFuture.completed(n)`.
  - `park` as a vtable entry (today's `__yo_async_park_start` plus `Waker`,
    `std/async/waker.yo`). A fake `accept` parks, and a scripted peer task
    wakes it.

  Nothing else is needed: completion through a `Waker` is already the
  cross-task protocol.
- **Sync console output.** `println` is the sync console, like Zig's
  `std.debug.print`. `std/io/stdio`'s async handles are reactor operations and
  take `io`. This answers the "two writers" question in `stdio.yo`'s stability
  note.
- **The effect row `E : Type.Struct` is unchanged.** `io` rides in the bundle
  as it does today, which is what makes the task body's `io` the awaiter's
  value.

### 2.1 What the compiler owns

The stackless transform stays compiler-owned and untouched:
- the `io.async` body becomes a state machine;
- `io.await` reads the future's state, registers a continuation and returns;
- the future prefix and per-type vtable (`resume`, `set_effect`,
  `cancel_pending`, bundle);
- effect-bundle injection, the abort registry and dispose.

These are the language, and none of them needs `io.vtable`. The compiler
touches the vtable in exactly two lowerings:
- `io.spawn(f, e)` becomes `io.vtable.spawn(io.ctx, f)` after the bundle
  injection;
- `io.await` or `JoinHandle.await` **from a sync context** (`main`, a plain
  function) becomes `io.vtable.run_until(io.ctx, f)`.

Inside a task, `io.await` is the inline protocol and never calls through the
table.

### 2.2 What a test gets

A deterministic `Io` is a value: a struct that holds the native `Io` and
overrides some entries. It can override `now` and `sleep` for virtual time,
or the file and net entries for a scripted peer. It hands
`Io(ctx : &self, vtable : &MY_VTABLE)` to the code under test. No thread
tricks, no global swap and no second compiler mode are involved. A
`std/io/sim` module with such decorators is a later, separate piece.

## 3. The ABI between generated state machines and an executor

This is the stable contract between generated state machines and any
executor, native or Yo-written. "Stable" means that a change to it is a
codegen PR that updates this section and the async suite in the same PR.
std never reads these offsets. IO-1a also emits it as one comment block
above `__YO_FUTURE_PREFIX`.

| Piece | Today's definition (`src/codegen/types/generation.yo`, `runtime_core.yo`) |
| --- | --- |
| Future prefix | `__YO_FUTURE_PREFIX` = `{__yo_ref_header_t header; int state; const __yo_future_vtable_t* vt; void (*continuation_fn)(void*); void* continuation_sm;}`; `_Static_assert`s pin the four offsets |
| Per-type future vtable | `__yo_future_vtable_t` = `{resume, set_effect, cancel_pending, bundle_offset, bundle_size}` |
| Continuation protocol | An awaiter reads `state`, cold-starts a `0`, and writes itself into the single continuation slot. Completion sets `-1`, schedules the continuation on its thread's queue and releases one reference. `-2` is aborted, with `cancel_pending(pre_state)` |
| Bundle injection | `__yo_future_set_bundle` at `io.await(f, e)` / `io.spawn(f, e)` |
| Waker token | `__yo_waker_token_t` and its ownership counter (the cross-thread inbox of `__yo_loop_t`) |
| `IoFuture` | `__yo_io_future_t` = the prefix plus `int32_t result`, `cancel_fn` and `backend_link` |
| Executor entries | `IoVTable.spawn`, `run_until`, `now`, `sleep`, `park` (§2) |

## 4. Zig: what Yo follows and what it must not

Zig facts as read from `ziglang/zig` master on 2026-11-07:
- `std.Io` is `{userdata : ?*anyopaque, vtable : *const VTable}`. The vtable
  carries async/concurrent/await/cancel/select, group, mutex and condition
  entries, the file, net and dir operations, `now` and `sleep`.
- `std.Io.Threaded` runs `async` on a thread pool, and its operations are
  blocking syscalls.
- `Io.Evented` is a comptime switch to `Io/IoUring.zig` or `Io/Kqueue.zig`.
  These are **stackful** fibers with 4 MiB stacks, one ring per thread, and
  idle threads steal ready fibers.
- `std.process.Init` could not be verified on master. Nothing here depends on
  it.

| | Follow? |
| --- | --- |
| `{userdata, vtable}`, the operations on the interface, `io` passed by argument, user implementations possible, one `Io` per thread handed at the entry | **yes** |
| `Threaded`: `io.async` runs on another thread | **no.** An `io.async` body captures non-atomic `Rc` values and is `!Send` by construction, and the state machine's own reference count is non-atomic. Yo's spelling of parallel work is `ThreadPool.spawn` with `FnOnce + Send` checked at the boundary |
| Stackful fibers and fiber stealing | **no.** Both migrate a started task between threads, which contradicts the single-threaded-per-thread rule that keeps the async runtime free of locks |
| No function colouring | **no.** An `io.async` body is a state machine, and taking `io` is the colour. That is the price of a per-thread, non-atomic, stackless model, and it is the right price |

**A blocking `Io` is possible with stackless futures.** Every operation
returns `IoFuture.completed(syscall())`, and `spawn` runs the machine inline
to completion. macOS and Windows already do this for most file operations.
**A `Threaded`-style `Io` that parallelises `io.async` is not possible, and
must not be built.**

## 5. Where the runtime lives

**The executor, the reactors, the timers and the wakers stay emitted,
target-selected C.** [`NO_LIBC_BY_DEFAULT`](NO_LIBC_BY_DEFAULT.md) §2 is
upheld. What changes is the runtime's identity, not its location: it becomes
the native implementation of §2's interface. The boundary between std and the
runtime is `IoVTable` plus the §3 ABI, instead of 90 externs plus an implicit
`_Thread_local`.

Why not port it to Yo now, in order of weight:

1. **It is not the same rewrite as NO_LIBC P4.**
   - P4 swaps about 55 libc call sites for `__yo_os` seam calls and keeps
     everything else.
   - A Yo port is all 18k lines. That includes the io_uring ring layer, the
     inline-first / `MSG_DONTWAIT` / `RWF_NOWAIT` decisions of
     `plans/reference/LINUX_ASYNC_IO_PERFORMANCE.md` §2, the kqueue and IOCP
     models, and the waker inbox with its ownership counter.
   - It would also have to re-earn the performance record on three
     platforms.

   The two jobs do not overlap, so "do it once" does not apply.
2. **What Yo would add is not where the work is.** Yo brings the type
   checker, `Drop` and the verifier. The runtime is raw pointers,
   `_Thread_local` statics, atomics on the cross-thread inbox and a
   `_Static_assert`ed future prefix. Ported to Yo under `Pragma.AllowUnsafe`,
   it would be C with a worse spelling, and `yo verify` would have nothing to
   say about it.
3. **Bootstrapping and compile time.** The compiler is the heaviest user of
   the runtime. A runtime in std is re-evaluated on every compile: prelude
   caching covers the prelude, not an 18k-line std module tree. A runtime bug
   would also become a seed-gated fix spanning two releases, instead of one
   codegen PR.
4. **Per-target selection is solved on both sides already.** The C is
   selected at emit time. std selects with a comptime `cond` on `platform`
   (`std/crypto/random.yo`). The vtable's *shape* is target-independent; the
   *table* belongs to the backend.
5. **Some things stay emitted regardless:**
   - the state-machine layout and its resume/dispose functions;
   - the future prefix;
   - the main wrapper, and after NO_LIBC the crt0;
   - TLS declarations;
   - the parallelism primitives that thread entries use before any std code
     runs.

**Revisit trigger (recorded, not scheduled).** After NO_LIBC P9, port **one**
backend to Yo over `__yo_os` as an experiment: the epoll fallback, the
smallest Linux backend. Gate it on the `LINUX_ASYNC_IO_PERFORMANCE.md`
numbers.
- If it is within noise and removes more lines than it adds, the io_uring
  layer follows.
- Otherwise, the experiment is archived.

Until then, there is no Yo runtime.

The parallelism runtime gets the same answer. `parallelism/runtime.yo` stays
C, and NO_LIBC P5/P6 swap pthreads for `clone`/`futex` under it. The pool
redesign
([`THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md`](THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md))
is made in that C once, before P5, so P5 ports the final shape.

## 6. Schedule and PRs

None of this fixes VBD soundness, and nothing gets rewritten twice by waiting.
So **the code lands after v0.2.79 (VBD's last release) and before NO_LIBC
P0b**. The order is:

**IO-1a → TP-1 → IO-1b → NO_LIBC P0 → P0b → …**

NO_LIBC's std-only P3 and P7 are unaffected and may run at any time.

| Piece | Release | Seed-gated | Content | Gate (Tier 1) |
| --- | --- | --- | --- | --- |
| **DOC-1** | inside VBD (this plan's PR) | no | This plan; the NO_LIBC §2 amendment; the ZIG_ADOPTION §0 row; the stale `ThreadPool` docs; the pool S2 issue, filed open | fmt with the tree binary, `check-issue-refs.sh`, both doc languages |
| **IO-1a** (compiler, Generation A) | v0.2.80 | yes: the prelude on the v0.2.80 seed is still the four-field `Io` | See the list below this table | `check ./src`, `yo build --std-path ./std`, `compile src/main.yo --skip-c-compiler`; `tests/async_await`, `tests/async/{join_handle,sm_protocol,sm_ownership,effect_bundle,waker}`, `tests/spawn_blocking`, `tests/thread`, `tests/thread_pool`, `tests/cross_thread_wake` (one file per `yo test` call); the `tests/internal/` files importing `await_analysis`, `calls/function`, `parallelism/runtime` or `types/generation` (≤ 8); the async emit-diff gate |
| **TP-1** (pool) | v0.2.80 | no | The pool redesign (companion plan) | That plan's §4 |
| **IO-1b** (std, Generation B) | v0.2.81, on the v0.2.80 seed | yes | See the list below this table | `check ./std`; `yo test` on IO-1a's files plus `tests/fs/*`, `tests/net/*`, `tests/io/*`, `tests/time/sleep`, `tests/process`; cli-diff (verify that no diagnostic text names `__yo_builtin_io`); the README example repos rebuilt on the tip; the seed-run `yo test` steps in `.github/workflows/` and `scripts/check-embedded-yo.sh`, per AGENTS.md's Generation A rule |
| **IO-1c** | v0.2.82 | yes | Delete IO-1a's four-field recognition path | `check ./src`, the same test files |
| Yo-port experiment | after NO_LIBC P9 | — | §5's trigger: the epoll backend in Yo over `__yo_os`, measured | the `LINUX_ASYNC_IO_PERFORMANCE.md` numbers |

**IO-1a contents:**
- The evaluator recognises the `__yo_io_*` markers on a *method* of `Io` as
  well as on a field.
- Every backend emits `__yo_io_native()` and `__yo_io_native_vtable`.
- The runtime gains the `IoFuture.completed` and `park` primitives.
- `_main_call_args` passes `__yo_io_native()` for an `Io` parameter.
- Thread and pool entries hand `__yo_io_native()` to the task.
- `io.spawn` and a sync-context `io.await` are lowered through
  `vt->spawn`/`vt->run_until` when the prelude's `Io` has a `vtable` field,
  and as today otherwise.
- The §3 ABI comment block is emitted.

**IO-1b contents:**
- The prelude flips: `IoVTable`, `Io :: struct(ctx, vtable)`, the
  `impl(Io, …)` methods, and `IoFuture` moved up.
- `__yo_builtin_io` is deleted.
- Every `std/sys` operation takes `io` and dispatches through the table.
- `std/fs`, `std/net`, `std/time/sleep`, `std/process` and `std/async`
  forward `io`.
- `src/main.yo` uses `Io.native()`.
- Docs: `ASYNC_AWAIT.md` gains §8's section in both languages, and
  `std/sys/future.yo`'s header is rewritten.

NO_LIBC P0b's crt0 main path then constructs `__yo_io_native()` once, in the
final shape.

`std/sys`'s operations do not take `io` before IO-1b. The argument arrives in
one sweep, not as a pre-migration
(`issues/questions/2026-11-07-should-std-sys-ops-take-io-before-the-io-interface-lands.md`).

## 7. Rejected

- **Keep `Io` a concurrency capability with a hidden reactor** (the status
  quo). That is dynamic scoping through the thread, the objection that
  deleted `with_allocator`. It also gives no deterministic `Io` without a
  compiler mode.
- **An `Init` struct for `main`** (`main :: fn(init : Init)` carrying `io`,
  `gpa` and `args`). It re-bundles the allocator that placement by argument
  just unbundled, and args and env are reads (`std/env`, `std/process`).
- **Two vtables, one for the executor and one for the operations.** A
  virtual-time decorator must override `now` and `sleep` together, and a test
  executor must see both. So there is one table, as in Zig.
- **The runtime in Yo, in std, now.** See §5: 18k lines, three platforms'
  performance records, no verifier leverage over raw pointers, per-program
  re-evaluation and seed-gated runtime fixes. Revisit with one backend after
  NO_LIBC P9.
- **A `Threaded`-style `Io` that parallelises `io.async`.** It is unsound
  under non-atomic reference counting and `!Send` task state. `ThreadPool.spawn`
  is the typed form.
- **Zig's stackful fibers or fiber stealing.** They contradict the
  single-threaded-per-thread rule that keeps the async runtime free of locks.

## 8. Text for `docs/*/ASYNC_AWAIT.md` (lands with IO-1b)

> **An `Io` is a value.** `io : Io` is the event loop and its reactor: an
> opaque context plus a table of operations, the way `Allocator` is an
> allocator.
>
> `main` receives the calling thread's native `Io`. A `Thread` or pool task is
> handed its worker's. A task body sees the `io` its awaiter passed in the
> effect bundle.
>
> Every operation that suspends or submits goes through `io`: `File.open`,
> `TcpListener.accept`, `sleep`, `io.spawn`. A plain blocking call does not:
> `println`, `Instant.now`, `sleep_blocking`.
>
> A test can hand code a different `Io`, for example one that fakes the clock
> or scripts a peer. It builds one from the native value (`std/io/sim`, later)
> or from its own table. Never construct one yourself outside a test:
> `Io.native()` is pragma-gated and exists for the runtime's entries.
