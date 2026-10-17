# Async/Await - Single-Threaded Concurrency for Yo

## Philosophy

Yo uses **async/await with state machine transformation** via **algebraic effects** for efficient **single-threaded concurrency**. This is a stackless coroutine model similar to JavaScript's event loop - all async code runs on the **same thread** as the caller.

**Key Insight**: `io.async`/`io.await` provides **concurrency** (interleaved execution), not **parallelism** (simultaneous execution). For parallelism, see `PARALLELISM.md`, which describes `Thread(T).spawn` (std/thread) and the worker pool for isolated multi-threaded execution.

```yo
{ yield } :: import("std/async");

// All async code runs on the SAME thread
main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(1));
  });
  task2 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(2));
  });
  // spawn starts both without waiting, returning JoinHandles
  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);
  // await on handles and extract results (Option(T))
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export(main);
```

## Concurrency vs Parallelism

| Concept         | Mechanism             | Description                                |
| --------------- | --------------------- | ------------------------------------------ |
| **Concurrency** | `io.async`/`io.await` | Multiple tasks interleaved on ONE thread   |
| **Parallelism** | `Thread(T).spawn`        | Multiple tasks running on SEPARATE threads |

```yo
// Concurrency: Same thread, interleaved execution
main :: (fn(io : Io) -> unit)({
  a := io.async((io : Io) => { /* ... */ });
  b := io.async((io : Io) => { /* ... */ });
  ha := io.spawn(a, io); // Start a without waiting (consumes a, returns its JoinHandle)
  hb := io.spawn(b, io); // Start b without waiting
  _ra := ha.await(io);
  _rb := hb.await(io);
});

// Parallelism: Different threads, true simultaneous execution
thread := Thread(unit).spawn(io => {
  // Runs on a DIFFERENT thread, with its own independent event loop.
  // Isolated: only Send values cross the boundary.
  ();
});
thread.join();
```

## Execution Model: Lazy Start via Algebraic Effects

Yo's async uses **algebraic effects** with the `Io` effect type. Async tasks are **lazy** — they don't start until explicitly awaited or spawned:

- `io.async(fn)` creates a **cold Future** — the function body is NOT executed yet
- `io.await(task)` starts a cold task and runs it to completion (sequential)
- `io.spawn(task)` starts a cold task **without waiting** for it to complete, returns `JoinHandle(T)`

```yo
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  counter := Rc(i32)(0);

  // Lazy creation — neither task starts yet
  task1 := io.async((io : Io) => {
    counter.* = (counter.* + 1); // Runs when started
    io.await(yield(io), io); // Yields to event loop
    counter.* = (counter.* + 1); // Resumes after other tasks yield
  });

  task2 := io.async((io : Io) => {
    counter.* = (counter.* + 10);
    io.await(yield(io), io);
    counter.* = (counter.* + 10);
  });

  // counter is still 0 here — tasks haven't started
  assert(counter.* == i32(0), "tasks are lazy");

  // spawn starts both without waiting:
  // 1. task1 runs: counter=0→1, yields
  // 2. task2 runs: counter=1→11, yields
  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);

  // handle.await waits for completion and returns Option(T):
  // 3. task1 resumes: counter=11→12
  // 4. task2 resumes: counter=12→22
  handle1.await(io);
  handle2.await(io);

  assert(counter.* == i32(22), "both tasks interleaved and completed");
});
export(main);
```

**Key Difference from Eager Models (old Yo, C#, C++):**

- Eager: `let f = async_fn()` runs immediately until first `await`
- Lazy (current): `task := io.async(fn)` does nothing until `io.await(task)` or `io.spawn(task)`

## Motivation

### Why Single-Threaded Async?

1. **Simplicity**: No thread safety concerns, no Send trait needed for async
2. **No data races**: All async code runs on one thread
3. **Memory Efficiency**: State machines only need ~100-500 bytes per task
4. **Massive Concurrency**: Can handle millions of concurrent tasks
5. **Zero-Cost Abstraction**: State machine transformation at compile time
6. **Familiar Model**: Similar to JavaScript's event loop - proven and intuitive
7. **No Atomics Needed**: Reference counting doesn't need atomic operations
8. **Algebraic Effects**: Io capabilities are explicit via `io : Io`

### Why Not Multi-Threaded Async?

Multi-threaded async (like Rust's tokio) adds complexity:

- Need `Send` trait to verify thread safety
- Need atomic reference counting
- Need cross-thread synchronization
- Work-stealing adds overhead

Yo's approach: Keep async simple (single-threaded), use `Thread(T).spawn` for parallelism (isolated threads).

## Language Syntax

```yo
{ yield } :: import("std/async");

// Async task creation (lazy — doesn't run until awaited/spawned)
task := io.async((io : Io) => {
  io.await(yield(io), io); // Yield to event loop
  return(i32(42));
});

// Sequential await: starts the task, runs to completion
result := io.await(task, io);

// Concurrent: spawn starts tasks without waiting, returns JoinHandle(T)
handle1 := io.spawn(task1, io);
handle2 := io.spawn(task2, io);
handle3 := io.spawn(task3, io);

// Then handle.await extracts results as Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
r3 := handle3.await(io);
```

### Io Effect and Using

Async operations require the `Io` effect, passed via `io : Io`:

```yo
// Main function receives Io effect
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    // Can use io.await, io.async, io.spawn here
    io.await(yield(io), io);
  });
  io.await(task, io);
});
export(main);

// Test blocks automatically have `io : Io` available
test("my test", {
  task := io.async((io : Io) => { /* ... */ });
  io.await(task, io);
});
```

### API

```yo ignore
io.async(fn)                  // Create a cold Future (lazy, doesn't start)
io.await(future, e)           // Consume the Future: start it if cold, wait, return (move out) its result
io.state(&future)             // Query the current state of a Future (returns FutureState); borrows it
io.spawn(future, e)           // Consume a cold Future and start it without waiting, returns JoinHandle(T)
handle.await(io)              // Consume the handle: wait for the task, return Option(T) (.None on unwind); a BLOCKING wait for main / plain fns
handle.join(io)               // Consume the handle into a Future of the same Option(T) (std/async): the form for inside a task
handle.state()                // Borrow the handle: the task's FutureState (also is_finished(), abort(), as_ptr())
yield(io)                     // Create a pending Future completed by the next loop turn (yields control to the event loop)

// `e` is the EFFECT RECORD the future needs. For a pure-Io task that is just
// `io`, e.g. `io.await(fut, io)`. For a future needing several effects, bundle
// them in a struct and pass that one value.
```

**Important Rules**:

1. `io.async(fn)` creates a **lazy** Future — the function body does NOT execute until awaited or spawned
2. `io.await(future)` starts a cold future and runs it sequentially to completion
3. `io.state(&future)` returns the current `FutureState` without blocking or starting the Future
4. `io.spawn(future)` consumes a cold future and starts it without waiting — returns `JoinHandle(T)` for later awaiting
5. `handle.await(io)` waits for a spawned task and returns `Option(T)` — `.Some(result)` on completion, `.None` on unwind (abort). A `JoinHandle` is move-only: `await` and `join` consume it, and `state`, `is_finished`, `abort` and `as_ptr` borrow it
6. A Future is **move-only**: `io.await` and `io.spawn` consume it, so an aborted task is reachable only through its `JoinHandle`, which reads `.None`
7. All async code runs on the **same thread** — no thread spawning
8. `yield()` suspends the current task and yields to other ready tasks in the event loop
9. A Future is awaited **once**: a second `io.await` (or an await after `io.spawn`) is E0901. So is a `JoinHandle`: a second `await` or `join` is E0901. A result several tasks need is joined once and shared (`Rc(T)`, a channel)
10. A Future aborted while a task awaits it propagates the abort to that task (see "Aborted Futures"), and aborting the task aborts the Future it awaits
11. `io.spawn(future, e)` runs the task **inline up to its first suspension point** before returning; spawn is not itself a suspension point of the caller
12. The effect bundle `e` is **copied into the future at its cold start** (the first `io.await` or `io.spawn`); that is the bundle the body runs under. Because one bundle starts many futures, every bundle field must be implicitly copyable: a move-only field, or plain data without `Copy`, is an error at the `io.await`/`io.spawn` (§3.13 A6). Keep shared state in an `Rc` field

### Execution Model

```yo
// All three tasks run on the SAME thread
main :: (fn(io : Io) -> unit)({
  // LAZY — tasks are cold, nothing runs yet
  t1 := io.async((io : Io) => { /* task1 body */ });
  t2 := io.async((io : Io) => { /* task2 body */ });
  t3 := io.async((io : Io) => { /* task3 body */ });

  // spawn starts each task without waiting:
  // - t1 runs until first yield, suspends
  // - t2 runs until first yield, suspends
  // - t3 runs until first yield, suspends
  h1 := io.spawn(t1, io);
  h2 := io.spawn(t2, io);
  h3 := io.spawn(t3, io);

  // handle.await waits for completion and returns Option(T):
  // - event loop resumes t1, t2, t3 in round-robin
  r1 := h1.await(io);
  r2 := h2.await(io);
  r3 := h3.await(io);
});
```

### Future Type

```yo
// `io.async(fn)` returns `Impl(Future(T))` — a pointer to a heap-allocated state machine.
// The state machine stores:
//   - state: int (0 = cold, 1..N = intermediate, -1 = completed, -2 = aborted)
//   - continuation_fn / continuation_sm (who to resume on completion)
//   - result: T (when completed; omitted for unit)
//   - captured vars + locals that cross await
// Dropping/disposing the Future frees the state machine.
```

#### Future with Effects

`Future(T)` can carry algebraic-effect information. The shape is:

```yo ignore
Future(T)        // No effects
Future(T, E)     // Future yielding T with effect bundle E
```

`E` is a single type — typically a struct that bundles every effect the async body
needs (handler fields plus any `Io`-like records). The author packs the bundle
themselves; the language does not concatenate effects from multiple type arguments.

```yo
// A bundle struct carries every effect the task needs.
TaskCtx :: struct(io : Io, raise : Raise, log : Log);
```

**Matching rules**

1. **Type equality on the bundle.** `Future(T, E1)` matches `Future(T, E2)` when
   `E1` and `E2` are compatible types. There is no order-independent set matching
   anymore — there is no set, just one bundle.
2. **A bundle-less future fits any bundle; a bundled one fits `Future(T)`
   only with `Io`.** A future whose type names no bundle (a raw `IoFuture`,
   `yield`) is compatible with `Future(T, E)` for any `E`: it reads no
   bundle. The other direction is narrower. An await or spawn through a
   `Future(T)` type injects nothing, so a bundled future may be viewed as
   `Future(T)` only when its bundle is `Io`, whose fields are compiler
   builtins the body never calls through. A future whose bundle carries
   handlers keeps its bundle in every type it is passed as; viewing it as
   `Future(T)` is a `yo check` error.
3. **Io when the body awaits.** Any async body that calls `io.await` / `yield`
   needs an `Io` in its bundle, so the bundle struct typically has an `io : Io`
   field.

**Example: bundled effects through async**

```yo
{ yield } :: import("std/async");
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : String) -> i32);
Log :: (fn(msg : String) -> unit);
TaskCtx :: struct(io : Io, raise : Raise, log : Log);

main :: (fn(io : Io) -> unit)({
  (raise : Raise) = (
    msg -> {
      return(i32(0));
    }
  );
  (log : Log) = (
    msg -> {
      println(&msg);
    }
  );
  ctx := TaskCtx(io : io, raise : raise, log : log);

  (task : Impl(Future(i32, TaskCtx))) = io.async((e : TaskCtx) => {
    e.log(`doing work`);
    r := e.raise(`recoverable`);
    e.io.await(yield(e.io), e.io);
    r + i32(42)
  });

  result := io.await(task, ctx);
  println(`result ${result}`);
});
export(main);
```

The `Io` effect record is itself a bundle-shaped struct that the async runtime
provides:

```yo
Io :: struct(
  async : (fn(generic(T : Type, E : Type.Struct), action : Impl(FnOnce(e : E) -> T)) -> Impl(Future(T, E))),
  await : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T),
  state : (fn(generic(T : Type, E : Type.Struct), fut : &Impl(Future(T, E))) -> FutureState),
  spawn : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> JoinHandle(T))
);
```

Why heap allocation?

- A Future can suspend at an `await` and resume later; the state machine must have a stable address after the current C stack frame returns.
- The runtime queues continuations as `(resume_fn, state_machine_ptr)`, so the state machine must outlive the scheduling point.

This is an implementation choice, not a semantic requirement.

### A Future Is Awaited Once

A Future is a move-only value (decision 13 of `plans/VALUES_BY_DEFAULT.md`).
`io.await(f, io)` and `io.spawn(f, io)` consume `f`, so each Future is awaited
or spawned exactly once, and `io.await` moves the result out, so a move-only
result type works. A second await is E0901:

```yo
{ assert } :: import("std/assert");

main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => i32(42));
  result := io.await(task, io);
  assert(result == i32(42), "the await moves the result out");
  // io.await(task, io); // E0901: `task` was moved by the await above
});
export(main);
```

`io.state(&f)` borrows the Future and may be called any number of times
before it is consumed. A result that several tasks need is computed once and
shared: await it in one place and share the value as `Rc(T)`, or send it
through a channel.

### Borrowing Futures

An `io.async` body may borrow instead of owning: name the borrow in its
capture list (`{ &x }`, `{ &mut x }`). The Future it makes is then
**second-class** (§3.13 A2 of `plans/VALUES_BY_DEFAULT.md`), like a closure
that borrows:

- it is awaited where it is made, as the operand of `io.await` (directly, or
  as the value of an `if`/`cond`/`match` arm or a block's tail);
- a function may return it when everything it borrows is one of that
  function's own `&`/`&mut` parameters, so the caller's lent places outlive
  it. A `&T` parameter is borrowed through the body's own capture list
  (`{ &c }`); a returned Future that reaches one only through a closure it
  captures is E0909. A borrowing closure the function was lent through a
  `&Impl(Fn(...))` parameter counts as that parameter
  (`m.with_lock({ &s }(v : &mut i64) => ..., io)`);
- it is never bound to a local (a `match` arm's pattern included), discarded
  with `_ := ...`, stored, captured by an escaping closure or spawned (E0909);
- the effect bundle of its `io.await` is a place (`io`, `self.io`), not an
  expression that runs code: the bundle is evaluated after the Future is made,
  and could otherwise move or overwrite what the Future borrows (E0910);
- the Future holds what the call's receiver and arguments lend from the moment
  each is evaluated, so a later argument of the same call may not move the
  lent place, assign to it or lend it `&mut` again
  (`bump_by(&mut c, take(c), io)` and `bump_by(&mut c, c.touch(), io)` with a
  `&mut self` method are E0910). Compute such an argument before the
  statement. A plain call rejects the same three, with the borrow ending at
  the call ([FLOWABILITY.md](./FLOWABILITY.md#one-call-site-rule)).

A call through a function value (a local or parameter of function type)
cannot show what its Future borrows, so its Future is assumed to borrow every
place the call lends with `&`/`&mut`: `fp := bump; f := fp(&mut c, io);` is
E0909 like the direct call.

A call through a `Dyn` goes through its vtable, whose Future type carries no
borrows, so a type whose trait method returns a borrowing Future cannot be
made a `Dyn` of that trait: `dyn(v)` is E0909 there. Call the method on the
concrete type or through a generic `Impl(Trait)` parameter, or let the
method's `io.async` capture what it needs by value; a Future made through a
`Dyn` is then first-class and may be bound or spawned.

```yo
{ assert } :: import("std/assert");

Counter :: struct(n : i32);
bump :: (fn(c : &mut Counter, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ &mut c }(io : Io) => {
    c.n = (c.n + i32(1));
  })
);

main :: (fn(io : Io) -> unit)({
  c := Counter(n : i32(0));
  io.await(bump(&mut c, io), io);
  io.await(bump(&mut c, io), io);
  assert(c.n == i32(2), "each await writes through the lent `&mut`");
  // f := bump(&mut c, io); // E0909: `f` would hold a borrowing future
});
export(main);
```

A place lent to a borrowing Future may not pass through an `Rc`
dereference, a `ref` object, a pointer or an index into a collection
(`io.await(count(&r.*.items, io), io)` and `io.await(bump(&mut xs(i), io), io)`
are E0909): the borrow lasts across the suspension, and nothing would notice
another task writing or reallocating through its own handle meanwhile. Lend
the handle instead (`h : &Rc(S)`) and read `h.*.items` inside the Future at
each use, or own the value in the task. An element of a fixed-size array is
part of the array's own storage and may be lent.

An `Arc` dereference is the exception for a shared borrow: no handle writes
an `Arc`'s payload in safe code (its state changes only through a `Mutex` or
an atomic inside it, as in Rust; a std mutator such as `a.*.o.take()` is
rejected like a direct write, since D3 judges every callee by what it writes),
and the task's own handle keeps the payload alive, so `io.await(a.*.lock(io), io)` with `a : Arc(Mutex(T))` is
accepted, as is a path that crosses only `Arc` dereferences. A `&mut` borrow
through an `Arc` is still E0909, and so is any path that also crosses an `Rc`
(`rc(arc(m))`). An `Rc` joins `Arc` once its payload is read-only through the
handle too (plans/VALUES_BY_DEFAULT.md decision 46).

Nor may a lent place be rooted in a module-level runtime binding or a
`thread_local`, `Arc` dereferences included (`io.await(bump(&mut G, io), io)`
with `G := ...` at module level is E0909, and so are `io.await(G.bump(io), io)`
and `io.await(peek(&G.*, io), io)` with `mut(G) := arc(...)`): any task on
the thread can reach the binding by name and reassign it while this one
waits, releasing the value the Future borrows. Lend a local copy, or read the
global by name inside the Future, where each use reads its current value. A `::` constant has no runtime
storage to change and may be lent.

### Aborted Futures

When an algebraic effect handler calls `unwind` inside an async task, the Future is marked as **aborted** (internal state = -2). The task's continuation is discarded and no result is stored.

**With `io.await`**: the abort propagates to the awaiter. Inside an
`io.async` body the awaiting task is aborted in turn, so a `JoinHandle.await`
or `join` further up reads `.None`. In a plain `fn` the awaiting function
takes over the unwind: a handler installed in that function catches it, and
otherwise it escapes to the caller, up to `main`, where an escape prints
`unhandled effect unwind escaped to top level` and aborts. The rule is the
same whether the Future was aborted before the await started or while it
waited, and whether or not its type names an effect bundle. (Until
2026-10-03 the already-aborted case was a panic, "attempted to await an
aborted Future".)

**With `handle.await`**: `JoinHandle.await` returns `Option(T)` — `.None` on abort, safely catching the unwind:

```yo
{ yield } :: import("std/async");
{ assert } :: import("std/assert");
{ String } :: import("std/string");

main :: (fn(io : Io) -> unit)({
  Raise :: (ctl(generic(T : Type), msg : String) -> T);
  Ctx :: struct(io : Io, raise : Raise);
  task := io.async((ctx : Ctx) => {
    ctx.io.await(yield(ctx.io), ctx.io);
    ctx.raise(`something went wrong`);
    return(i32(42));
  });

  // `spawn`/`await` take ONE effect argument. With more than one effect,
  // bundle them into a struct and pass that.
  (raise : Raise) =
    (
      msg -> {
        unwind(());
      }
    );
  handle := io.spawn(task, { io, raise });
  result := handle.await(io);
  // result is Option(i32).None — the task was aborted
  assert(result.is_none(), "aborted task returns None");
});
export(main);
```

### Cancelling a task

`handle.abort()` cancels a spawned task. The task is marked aborted (-2), and
the cancellation is **structured**: whatever the task is suspended on is
cancelled with it.

- A pending I/O operation or timer is cancelled at the OS level, where the
  backend has a cancel path (timers everywhere; on Linux the epoll and
  io_uring descriptor and datagram operations; on macOS the kqueue-parked
  descriptor operations). An operation without one runs to completion, and
  the task stays aborted.
- A child Future the task was awaiting is aborted in turn, recursively, when
  the task started it: an anonymous `io.await(child(io), io)`, or a named
  future this await cold-started. A named future someone else started may be
  shared with other awaiters, so it keeps running.
- A raw `IoFuture` spawned directly is cancelled the same way, and its handle
  keeps reading `.None` after the operation's time.
- A task parked on a `Mutex` or `Channel` leaves its queue. The next `unlock`
  or `send` skips the dead waiter and hands the lock or the message to a live
  one; a task the lock was already handed to passes it on to the next waiter
  when its last reference goes. Nothing is lost.
- Every task awaiting the aborted one is woken. An `io.await` that was
  **waiting** when the abort happened aborts its own task too, so a
  `JoinHandle.await` further up reads `.None`. Starting an `io.await` on a
  Future that is **already** aborted behaves the same way.

The aborted task's locals are dropped when its last reference goes away.

```yo
{ sleep } :: import("std/sys/timer");

f := io.async((io : Io) => {
  io.await(sleep(u64(50)), io);
  i32(7)
});
// The awaiting task owns `f` (a capture list moves it in, §3.13 A1).
a := io.async({ f }(io : Io) => io.await(f, io));
ha := io.spawn(a, io);
io.await(yield(io), io);
ha.abort();
// Aborting the awaiter aborted the future it was awaiting, too.
assert(ha.await(io).is_none(), "the aborted task reads .None");
```

`timeout(handle, d, io)` from `std/async` is built on `abort`. It consumes the
handle. When it times out, the task and everything it is blocked on are
cancelled.

**Future State Machine States:**

| State | Meaning                                                | `FutureState` enum      |
| ----- | ------------------------------------------------------ | ----------------------- |
| 0     | Cold — not started yet                                 | `FutureState.Cold`      |
| 1..N  | Intermediate — suspended at an await/yield point       | `FutureState.Running`   |
| -1    | Completed — result is available                        | `FutureState.Completed` |
| -2    | Aborted — an effect handler called `unwind`, no result | `FutureState.Aborted`   |

### Querying Future State

`io.state(future)` returns the current `FutureState` without blocking or starting the Future. This is useful for polling or diagnostics:

```yo
FutureState :: enum(
  Cold = 0,
  // Cold — not started yet
  Running = 1,
  // In progress — suspended at an await/yield point
  Completed = -1,
  // Completed — result is available
  Aborted = -2 // Aborted — an effect handler called unwind
);
```

```yo
{ assert } :: import("std/assert");
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(42));
  });

  // Before starting: Cold
  assert(io.state(&task) == FutureState.Cold, "cold future is Cold");

  // Spawning consumes the future; its handle reads the task's state from then on.
  h := io.spawn(task, io);
  _r := h.await(io);

  // After completion: Completed
  assert(h.state() == FutureState.Completed, "done task is Completed");
});
export(main);
```

**Key points:**

- `io.state` is a **non-blocking**, **synchronous** read of the Future's internal state field
- Raw state machine values 1..N (intermediate suspend states) are all mapped to `FutureState.Running`
- `io.state` does **not** start a cold Future — it only observes
- Multiple `io.state` calls on the same Future are consistent

## State Machine Transformation

The compiler transforms async functions into state machines at each `await` point.

### Example Transformation

**Input Yo code:**

```yo
task := io.async((io : Io) => {
  response := io.await(http_get(url), io);
  data := io.await(response.read(), io);
  return(data);
});
```

**Conceptual transformation:**

1. **State Machine Struct**:

   - Tracks current state (0, 1, 2...)
   - Captures function parameters (url)
   - Stores local variables used across await points (response, data)
   - Holds pending futures

2. **Poll Function**:

   - Switch statement with one case per state
   - State 0: Call http_get, check if ready
   - State 1: Extract response result, call read, check if ready
   - State 2: Extract data result, return Ready(data)

3. **Resume Function (Lazy Start)**:
   - State 0 (cold): Future is created but NOT started
   - When `io.await` or `io.spawn` triggers the first resume:
     - State 0: Call http_get, check if ready
     - State 1: Extract response result, call read, check if ready
     - State 2: Extract data result, return Ready(data)
   - At each yield/await point, the task yields for fairness

### Key Points

- Each `await` becomes a state transition
- Local variables used across `await` are captured in state struct
- Poll function is a switch statement advancing through states
- No threads involved - all polling happens on same thread

### Where `await` may appear inside `io.async`

Anywhere an expression may. The body is lowered in one pass: each `await`
becomes a suspension point exactly where it is written, and the task resumes
there. Every local, pattern binding and intermediate value lives in the task
itself, so nothing is lost across the suspension.

```yo
cond(
  needs_write => {
    io.await(write_string(p, data, io), io);
  },
  true => ()
);
if(!io.await(exists(p, io), io), { ... }); // inside a condition
cond(c1 => ..., io.await(f, io) => ..., true => ...); // a later cond branch
match(io.await(num(io), io), 42 => ..., _ => ...); // a scrutinee
x := add(io.await(a, io), io.await(b, io)); // two in one expression
while(io.await(more(io), io), { ... });
while(c, {
  t := io.await(f, io);
  i = t;
}, { ... }); // the step of a 3-arg while
```

Evaluation order is the source order. In `add(g(), io.await(f, io))`, `g()`
runs before the task suspends. Laziness is kept: an `await` in a later `cond`
branch, or on the right of `&&`, runs only when that branch or operand is
evaluated.

These are real suspensions: a task spawned before an awaited condition runs
while the awaiting task is suspended.

## Writing `io.async` bodies: recursion and waiting on tasks

### Recursion: call the outer function by name

Inside an `io.async` lambda, `recur` names the **lambda**, not the function
that returns it. The lambda's signature is `(io : Io) => …`, so `recur(n, io)`
there is `E0603: Argument count mismatch: expected 1 arguments, got 2`. Call
the outer `::` function by name instead:

```yo
{ println } :: import("std/fmt");

count_down :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async(
    (io : Io) =>
      cond(
        (n == i32(0)) => i32(0),
        true => (io.await(count_down(n - i32(1), io), io) + i32(1))
      )
  )
);

main :: (fn(io : Io) -> unit)({
  r := io.await(count_down(i32(10), io), io);
  println(`count_down(10) = ${r}`); // count_down(10) = 10
});
export(main);
```

Every level is its own future, and all of them stay alive until the innermost
one completes, so memory grows linearly with the depth. Measured with v0.2.49
on Linux x86-64: 100,000 levels peak at 35 MB, 1,000,000 levels at 316 MB
(about 310 bytes per level; no stack overflow, since the futures live on the
heap).

When the depth is data-dependent (a directory tree, a graph), keep an explicit
worklist instead: one future in total, and the pending work is an `ArrayList`.

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ ArrayList } :: import("std/collections/array_list");

// Split `n` into halves until every piece is 1, awaiting once per piece.
count_leaves :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    stack := ArrayList(i32).new();
    stack.push(n);
    (leaves : i32) = i32(0);
    while(stack.len() > usize(0), {
      cur := match(stack.pop(), .Some(k) => k, .None => i32(0));
      io.await(yield(io), io); // stands in for the per-item I/O
      cond(
        (cur > i32(1)) => {
          half := (cur / i32(2));
          stack.push(half);
          stack.push(cur - half);
        },
        true => {
          leaves = (leaves + i32(1));
        }
      );
    });
    leaves
  })
);

main :: (fn(io : Io) -> unit)({
  r := io.await(count_leaves(i32(1000), io), io);
  println(`leaves = ${r}`); // leaves = 1000
});
export(main);
```

The same walk over 100,000 pieces peaks at 4 MB.

### Waiting for spawned tasks from inside a task

`handle.await(io)` is a **blocking wait**: it loops over the event loop until
the handle is finished. That is what you want in `main` or in any plain `fn`.
Inside an `io.async` body it **nests the event loop**: the waiting task stays
on the C stack while the inner loop runs the other tasks, the tasks under it
on that stack cannot resume until the wait returns, and if the awaited work
needs one of them the program deadlocks. With `YO_ASYNC_STRICT=1` such a wait
is a deterministic panic, and `yo test` sets that variable for every test
binary it runs under its default address sanitizer:

```
panic: a blocking await ran inside an async task: an io.await in a non-io.async function,
JoinHandle.await, or a std/async combinator (join_all/race/any/timeout) was called from a
spawned or awaited task. That nests the event loop and can deadlock. ...
```

The form for a task is **`handle.join(io)`** (`std/async`): a future that
resolves to the same `Option(T)` and **suspends** the awaiting task until the
handle is terminal. The `std/async` combinators (`join_all`, `race`,
`race_first`, `any`, `any_first`, `timeout`) are futures of the same kind, so
one spelling works in `main` and inside a task alike:

```yo
{ println } :: import("std/fmt");
{ join_all, yield } :: import("std/async");
{ ArrayList } :: import("std/collections/array_list");

work :: (fn(id : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    (k : i32) = i32(0);
    while(k < i32(3), {
      io.await(yield(io), io);
      k = (k + i32(1));
    });
    id
  })
);

run_all :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    handles := ArrayList(JoinHandle(i32)).new();
    handles.push(io.spawn(work(i32(1), io), io));
    handles.push(io.spawn(work(i32(2), io), io));
    // ✓ a real suspension point: the other tasks run while this one waits
    outs := io.await(join_all(handles, io), io);
    (sum : i32) = i32(0);
    (i : usize) = usize(0);
    while(i < outs.len(), {
      match(
        outs(i),
        .Some(v) => {
          sum = (sum + v);
        },
        .None => ()
      );
      i = (i + usize(1));
    });
    // one handle: the same shape
    h := io.spawn(work(i32(3), io), io);
    match(
      io.await(h.join(io), io),
      .Some(v) => {
        sum = (sum + v);
      },
      .None => ()
    );
    sum
  })
);

main :: (fn(io : Io) -> unit)({
  n := io.await(run_all(io), io);
  println(`sum ${n}`); // sum 6, also under YO_ASYNC_STRICT=1
});
export(main);
```

Joining consumes the handle (§3.13 A3 of `plans/VALUES_BY_DEFAULT.md`): the
result moves out of the task, and a `join` of a finished task resolves at
once. `join_all`, `race_first`, `any_first` and `timeout` consume their
handles too. `race` and `any` take the list by value and hand it back with
the index, `(index, handles)`, so the losers can still be aborted or joined:

```yo ignore
(w, rest) := io.await(race(handles, io), io);
(i : usize) = usize(0);
while(i < rest.len(), i = (i + usize(1)), {
  if(i != w, {
    rest(i).abort(); // a loser: abort it through the returned list
  });
});
```
 Under the wait is one runtime primitive, a park future the task's
completion or abort wakes (`__yo_join_wait_new` / `__yo_join_wait_add` in
`std/sys/externs`); `race` and `timeout` add several handles to one wait.

## Event Loop

The async runtime uses a simple **single-threaded event loop**:

```
┌─────────────────────────────────────────────┐
│              Event Loop (Main Thread)       │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │           Ready Queue               │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐           │    │
│  │  │Task1│ │Task2│ │Task3│  ...      │    │
│  │  └─────┘ └─────┘ └─────┘           │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         Poll next ready task        │    │
│  │   - Run until await                 │    │
│  │   - If Io pending, register waker   │    │
│  │   - If ready, continue              │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         Io Completion Check         │    │
│  │   - Check epoll/kqueue/IOCP         │    │
│  │   - Wake completed tasks            │    │
│  │   - Add to ready queue              │    │
│  └─────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
```

### Event Loop Steps

1. **Dequeue** a ready task from the ready queue
2. **Poll** the task's state machine
3. **If await on pending Io**: Register waker, task sleeps
4. **If await on ready Future**: Continue to next state
5. **If complete**: Mark Future as ready, wake awaiters
6. **Check Io**: Poll OS for completed Io events
7. **Wake tasks**: Move woken tasks to ready queue
8. **Repeat** until all tasks complete

### Thread-Local Event Loop

Each OS thread has its own event loop. All async runtime state is thread-local (`_Thread_local` on POSIX, `__declspec(thread)` on Windows):

```c
// Per-thread task queue
static _Thread_local __yo_async_task_queue_t __yo_thread_async_queue = {NULL, NULL, 0};

// Per-thread event loop state
static _Thread_local bool __yo_async_scheduler_initialized = false;
static _Thread_local bool __yo_io_initialized = false;
static _Thread_local size_t __yo_pending_io_count = 0;
static _Thread_local size_t __yo_active_watch_count = 0;

// Per-thread I/O backend (Linux example)
static _Thread_local struct __yo_uring __yo_io_ring;
```

This means:

- **Main thread**: Has its own event loop for `io.async`/`io.await` tasks
- **Worker threads** (from `Thread(T).spawn`): Each gets an independent event loop
- **Multiple workers per thread**: Workers on the same OS thread cooperatively share that thread's event loop
- **No cross-thread task migration**: Tasks always run on the thread that created them
- **No locking needed**: Queue operations are single-threaded by design
- **Process-global state** (signal handlers, WSA init, TTY settings) stays `static` — shared across all threads

### Runtime Initialization

The async runtime is generated conditionally — **only when the program uses async/await**:

- The compiler scans for `io.async`, `io.await`, and `io.spawn` calls during code generation
- If no async code is present, the runtime (scheduler, I/O subsystem, continuation queue) is **not emitted** at all, and `main()` calls the user function directly
- If async code is present, `main()` initializes the scheduler and waits for all tasks:

```c
int main(int argc, char** argv) {
  __yo_async_scheduler_init();   // Lightweight: just sets a flag
  __yo_user_main();
  __yo_async_wait_all();         // Drains queue; returns immediately if empty
  return 0;
}
```

**I/O initialization is lazy**: `__yo_io_init()` is called on the first actual I/O operation (file open, socket connect, etc.), not at program start. This means programs using only `yield()` and pure computation pay zero I/O setup cost.

Similarly, the **parallelism runtime** (thread pool, worker spawn, hardware detection) is only emitted when the program uses `Thread(T).spawn` or `std/thread`'s `spawn(pool, cb)`. Non-parallel programs save ~450 lines of generated C code.

**Synchronous system helpers** (stat/dirent accessors, sendfile/copyfile, sync file operations, mmap/madvise, fcntl, flock, socket address helpers, signal handlers, TTY) are always emitted via `generate_sys_runtime()` which includes both cross-platform helpers and platform-specific sync helpers (`generate_platform_sys_runtime_{macos,linux,windows,wasm}`). These have **no IoFuture dependency**. All functions are `static`, so unused ones are stripped by the C compiler's dead-code elimination. This ensures non-async programs that use signals, stat, mmap, TTY, etc. compile without pulling in the full async runtime.

### Platform-Specific I/O Backends

| Platform | Backend                                         | File                    |
| -------- | ----------------------------------------------- | ----------------------- |
| Linux    | `io_uring` (vendored ring layer), epoll fallback | `src/codegen/async/runtime_io_linux.yo`   |
| macOS    | `kqueue` (kevent readiness + sync pread/pwrite) | `src/codegen/async/runtime_io_macos.yo`   |
| Windows  | I/O Completion Ports (IOCP)                     | `src/codegen/async/runtime_io_windows.yo` |
| WASM     | POSIX I/O (NODERAWFS) + timer queue             | `src/codegen/async/runtime_io_wasm.yo`    |

#### WASM Async Support

WASM targets (`wasm32-unknown-emscripten` via emcc) support the core async scheduler with real timer support — `io.async()`, `io.await()`, `io.spawn()`, `JoinHandle.await()`, and `sleep()` (from `std/sys/timer`) all work. The scheduler runs with POSIX I/O via NODERAWFS for file operations, and a sorted timer queue for non-blocking sleep.

What works on WASM:

- `io.async()` — create lazy futures
- `io.await()` — await futures
- `io.spawn()` / `JoinHandle.await()` — spawn and join tasks
- `yield()` — cooperative yielding between tasks
- Algebraic effects with async
- `sleep()` (from `std/sys/timer`) — timer-based delays via sorted timer queue
- File I/O (`File.open`, `read`, `write` from `std/fs/file` and `std/sys/file`) — via NODERAWFS (Node.js) or Emscripten FS

What does NOT work on WASM:

- DNS, TCP, UDP — no network stack in Emscripten
- Process spawn, signals, FS events — no OS-level APIs
- Parallelism (`Thread(T).spawn`) — requires pthread support (experimental)

Concurrency helpers return sensible defaults: `__yo_thread_get_hardware_threads()` returns 1, `__yo_get_thread_id()` returns 0, `__yo_thread_yield()` is a no-op.

## Memory Management

### Non-Atomic Reference Counting

Since all async code runs on one thread:

- No atomic operations needed for RC
- Simple increment/decrement
- No synchronization overhead

```c
// Non-atomic RC (single-threaded)
struct __yo_ref_header {
  size_t ref_count;  // Simple size_t, not atomic!
};

// Increment - no atomics!
static inline void yo_rc_inc(__yo_ref_header_t* header) {
  header->ref_count++;
}

// Decrement - no atomics!
static inline bool yo_rc_dec(__yo_ref_header_t* header) {
  return --header->ref_count == 0;
}
```

### Future Lifetime Management

Futures (async block state machines) are **reference counted** to handle cases where tasks complete before being awaited:

**Lifetime Pattern: "Event Loop Holds References"**

```yo
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    /* work */
  });
  // task is cold (refcount=1), hasn't started yet
  h := io.spawn(task, io);
  // spawn consumes `task`: its reference moves into the JoinHandle, and the
  // running task (the event loop) takes +1 (refcount=2)
  _r := h.await(io);
  // Waits for completion and reads the result
  // Task completes, event loop drops its reference (refcount=1)
  // h goes out of scope (refcount=0, freed)
});
export(main);
```

**Refcount Lifecycle:**

1. **Creation**: `io.async(fn)` allocates state machine, `refcount = 1`
2. **Start (via await/spawn)**: the Future is consumed, so the caller's
   reference moves into the await (or the `JoinHandle`), and
   `__yo_incr_rc()` adds one for the running task (refcount = 2)
3. **Await done**: the await moves the result out and releases its reference
   (refcount = 1); a handle releases its reference when it is dropped
4. **Task Completion**: State machine calls `__yo_decr_rc()` (refcount = 0, freed)

**Key Insight**: Tasks stay alive until completion even if user code drops their handle early!

**`JoinHandle(T)` owns a reference.** `io.spawn` returns a move-only value
struct that holds one reference to the task's Future: `io.spawn` consumed the
Future, and its reference moved into the handle. The handle has no `Clone`,
so one task has one handle. Awaiting it (`h.await(io)`, or
`io.await(h.join(io), io)`) consumes it: the result moves out of the task, and
the handle's reference is released. A handle that is dropped without being
awaited **detaches** the task: its `Drop` releases the reference, the task
keeps running, and it frees itself when it finishes, so a fire-and-forget
`io.spawn(task, io);` statement leaks nothing.

**A task still pending when its thread's program body returns is aborted and
released at thread exit.** Nothing will ever drive that thread's event loop
again, so the runtime aborts every task still queued or parked on a timer or
I/O operation, and releases the task, its pending await's future and
everything it captured — the task's `Drop` impls run there. No task body
resumes after `main` returned: an aborted task's resume runs only its release
guard.

**Implementation Details:**

The state machine struct includes a `__yo_ref_header_t` as its first field:

```c
struct async_block_state_t {
  __yo_ref_header_t header;  // Must be first for __yo_decr_rc to work
  int state;
  // ... other fields ...
};
```

The `Impl(Future(T))` type uses `__yo_sometype_drop` which calls `__yo_decr_rc`:

```c
void fn_id12345___drop(async_block_state_t* self) {
  if (self != NULL) { __yo_decr_rc((void*)self); };
}
```

**Type System Integration:**

The evaluator's `get_receiver_methods_by_name_from_env` function has special handling for Future types - it does NOT use the `resolved_concrete` for method lookup. This ensures that when calling `task.___drop()`, it uses the SomeType's own `___drop` method which calls `__yo_sometype_drop`, rather than using the capture struct's drop function.

### State Machine Lifecycle

```c
// 1. Creation — allocate Future with state machine (cold, refcount=1)
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->header.ref_count = 1;
future->state = 0;  // Cold — not started
// Initialize state machine fields...

// 2. Start (lazy) — triggered by io.await or io.spawn
__yo_incr_rc(future);  // refcount = 2
future->__yo_resume_fn(future);  // Runs until first yield/await
// Task suspends at yield, gets queued in event loop

// 3. Event loop — runs ready tasks
while (not_complete) {
  __yo_async_run_ready_tasks();  // Resumes queued tasks
}

// 4. Completion
future->state = -1;  // Mark as completed
future->result = final_value;
__yo_decr_rc(future);  // Release running task reference
// Wake continuation (if any)

// 5. Cleanup — when user drops, refcount reaches 0, freed
```

### `Impl(Future(T))` Dispatch and Allocation Model

**`Impl(Future(T))` is always heap-allocated with non-atomic reference counting.**

This is **not** static dispatch (where the concrete type is known and stack-allocated). Instead:

1. **Heap allocation**: `io.async(fn)` calls `__yo_malloc(sizeof(state_machine_struct))` and returns a pointer. This is necessary because:

   - Futures suspend and resume across C stack frames — the state machine must outlive the frame that created it
   - The event loop queues continuations as `(resume_fn, state_machine_ptr)` pairs — stable addresses are required
   - Multiple references (user code + event loop) can exist simultaneously

2. **Reference counting**: Each state machine has a `__yo_ref_header_t` as its first field. The RC is non-atomic because all async code runs on a single thread. The typical lifecycle is:

   - Creation: `refcount = 1` (user owns)
   - Start (await/spawn): `refcount = 2` (user + event loop)
   - Task completion: event loop decrements → `refcount = 1`
   - User scope exit: user decrements → `refcount = 0` → freed via dispose function

3. **Pointer semantics**: In generated C code, `Impl(Future(T))` compiles to `state_machine_struct*` (a pointer). The Yo type system treats it as opaque — user code cannot inspect the struct fields.

4. **Dispose function**: Each state machine type gets a custom dispose function that:

   - Drops the capture struct (outer scope variables)
   - Drops the result value (if completed and result contains RC types)
   - Drops local variables (if aborted mid-execution)
   - The memory is freed by `__yo_decr_rc` after the dispose function returns

5. **sync_fut_t optimization**: When an async block has **no await points** (purely synchronous), a lightweight `sync_fut_t` struct is generated instead of a full state machine. It has the same header layout but no state dispatch — the resume function simply calls the closure and sets state to -1 (completed).

**Why not stack allocation?** Even with `Impl(...)` (which typically implies static dispatch in Yo), Futures must be heap-allocated because their lifetime is decoupled from the creating stack frame. A future created in function `f()` may be awaited in function `g()` after `f()` has returned.

### State Machine Memory

A task is one heap allocation:

- a 40-byte header: the reference count, the state, a pointer to the type's
  operations (resume, effect binding, abort hook), and the first waiter;
- the result;
- the captured values, and the closure's parameters (an `Io` is 32 bytes);
- one pointer for the future it is suspended on;
- one field per local that is live across an `await`.

A local that is used only between two awaits stays a local of the C resume
function and costs the task nothing. Locals whose live ranges do not overlap
share one field when their C type is the same, heap-owning values included.
Measured on x86_64, a task with one await and a small capture is 88 bytes.
Sixteen sequential awaits whose results are all used at the end take 152
bytes, of which 60 are the fifteen results still waiting to be added.

## Performance Characteristics

### Memory Usage

**10,000 concurrent async operations:**

- State machines: 10,000 × ~100 bytes = 1MB
- No thread stacks needed!

**Comparison:**

- 10,000 OS threads × 1MB stack = 10GB ❌
- 10,000 Go goroutines × 2KB = 20MB
- 10,000 Yo async tasks × ~100 bytes = 1MB ✅

### Throughput

Measured on a loaded 32-thread x86_64 box (`--optimize 2`, median ns per
operation over 100k; treat as ±2×):

| Operation | ns |
|---|---|
| `io.await` of an already-completed future | ~4 |
| cold child future that completes synchronously | ~25 |
| the same while other I/O is parked in the kernel | ~24 |
| a chain of 4 nested awaits | ~150 |
| `io.spawn` + `JoinHandle.await` of a no-await task | ~210 |

A child that completes synchronously continues inline (within a budget of
1024 per resume), and a finishing task hands its waiter the rest of the same
scheduler step, so neither costs a trip through the run queue or the kernel.

- No context switching (same thread)
- No synchronization overhead
- Cache-friendly (small state machines)

## Async iteration: the `Stream` trait

`Iterator` yields values now. `Future` yields one value later. A **`Stream`**
is both — "a value, later, repeatedly":

```yo
Stream :: trait(
  Item : Type,
  next : (fn(self : &mut Self, io : Io) -> Impl(Future(Option(Self.Item), Io)))
);
```

It lives in `std/async/stream` and `.None` means the stream is finished —
terminal, and it stays terminal.

```yo
{ Stream } :: import("std/async/stream");
{ TcpListener } :: import("std/net/tcp");

conns := listener.incoming().take(usize(3)); // a Stream, lazily
accepted := io.await(conns.collect(io), io); // ArrayList(Result(TcpStream, NetError))
```

### Who implements it

| type | its stream |
| --- | --- |
| `TcpListener.incoming()` (`std/net/tcp`) | `Item = Result(TcpStream, NetError)` — one connection per item |
| `Watcher` (`std/fs/watch`) | `Item = FsEvent` — `.None` once the watcher is closed and drained |
| `Channel(T)` (`std/async/channel`) | `Item = T` — `next` IS `recv`; `.None` once closed AND drained |

### Combinators and consumers

Written once over `where(S <: Stream)`, mirroring the `Iterator` combinators.
Each takes the stream and its closure by value: an adapter is a plain value
that owns what it wraps. The consumers take the stream by value too, so the
future they return owns it, and a task may own that future
(`io.spawn(chain.collect(io), io)`).

| lazy | what it does |
| --- | --- |
| `map(f)` | transform each item |
| `filter(pred)` | keep the items satisfying `pred` (by value, like `map`) |
| `filter_map(f)` | `f` answers `Option(B)`; the `.Some`s are yielded |
| `take(n)` | at most `n` items, then finished — without touching upstream again |
| `skip(n)` | discard the first `n` |

| consumer | what it does |
| --- | --- |
| `for_each(f, io)` | drive the stream to its end, calling `f` on each item |
| `collect(io)` | drive it to its end, gathering the items into an `ArrayList` |
| `for_await(s, io, x => body)` | the loop form (a macro): `body` runs per item, and `break`, `continue` and `return` work in it |

```yo
// Every third event's name, at most five of them.
names := watcher.filter(e => (e.kind == FsEventKind.Change)).map(e => e.name).take(usize(5));
io.await(names.for_each(n => println(&n), io), io);

// Or as a loop over a chain built the same way, which can stop early: here at
// the first empty name.
for_await(names2, io, n => {
  if(n.len() == usize(0), {
    break;
  });
  println(&n);
});
```

### Implementing one

`next` takes `self : &mut Self`, the way `Iterator` does, and its future
borrows the stream: the body names the borrow in its capture list
(`{ &mut self }`), so the future is second-class. It is awaited where it is
made (`io.await(s.next(io), io)`), or returned from a function whose `&mut`
parameter it borrows, and never stored or spawned. A stream source is
therefore a plain value whose fields `next` writes through the borrow:

```yo
Countdown :: struct(_n : i32);
impl(
  Countdown,
  Stream(
    Item : i32,
    next : (fn(self : &mut Self, io : Io) -> Impl(Future(Option(i32), Io)))(
      io.async({ &mut self }(io : Io) =>
        cond(
          (self._n <= i32(0)) => Option(i32).None,
          true => {
            v := self._n;
            self._n = (self._n - i32(1));
            Option(i32).Some(v)
          }
        ))
    )
  )
);
```

A stream whose items can FAIL carries the failure IN the item — `Item =
Result(T, E)`, the way `incoming` yields `Result(TcpStream, NetError)`. That
is why `next`'s future is `Future(_, Io)` and not `Future(_, IoExn)`: **a
stream never throws**, so one failed item does not end the sequence and a
consumer needs no `Exception` handler.

### Four things to know before writing one

1. **Build a chain OUTSIDE the `io.async` body that awaits it.** A closure
   passed to a generic callback INSIDE an async body leaves the enclosing
   future's result type unresolved, and the error lands on the caller's
   `await`. Make the chain first, then await it — including from inside a
   spawned task:

   ```yo
   chain := source.map(x => f(x)); // out here
   task := io.async({ chain }(io : Io) => io.await(chain.collect(io), io)); // awaited in there
   ```

2. **`for_await` is the hand-written loop.** Its expansion is this, and its
   await suspends the enclosing task like any other, so it works inside a
   spawned task as well as from `main`:

   ```yo
   (done : bool) = false;
   while(done == false, {
     nx := io.await(stream.next(io), io);
     match(
       nx,
       .Some(x) => { … },
       .None => {
         done = true;
       }
     );
   });
   ```

3. **A generic consumer is an ordinary generic function.**
   `where(S <: Stream)`, `where(S <: Stream(Item := i32))` and
   `where(S <: Stream(Item := A))` with a generic `A` all accept sources and
   combinator chains. A generic `A` is bound from the argument's `Stream` impl,
   so the body can use it (`ArrayList(A)`, `A <: Add(A)`), and the blanket
   combinators (`s.collect(io)`, `s.map(f)`) can be called on the parameter.

4. **`.None` is terminal.** A consumer stops on it, so an implementor must
   keep answering `.None` afterwards — never resume after finishing.

## API

### Core Operations

```yo
{ yield } :: import("std/async");

// io.async: Create a lazy Future (cold, doesn't start until awaited/spawned)
task := io.async((io : Io) => {
  // body
  return(value);
});

// io.await: Start if cold, wait for completion, return result
result := io.await(task, io);

// io.spawn: Start a cold Future without waiting, returns JoinHandle(T)
handle1 := io.spawn(task1, io);
handle2 := io.spawn(task2, io);
// After spawn, tasks are running — handle.await returns Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
```

### Example: Concurrent Tasks with Spawn

```yo
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  counter := Rc(i32)(0);

  task1 := io.async((io : Io) => {
    counter.* = (counter.* + 1);
    io.await(yield(io), io);
    counter.* = (counter.* + 1);
    return(counter.*);
  });

  task2 := io.async((io : Io) => {
    counter.* = (counter.* + 10);
    io.await(yield(io), io);
    counter.* = (counter.* + 10);
    return(counter.*);
  });

  // Tasks are cold — counter is still 0
  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);
  // Both run via interleaved execution: counter = 22
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export(main);
```

### Example: Sequential Await (No Spawn)

```yo
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  counter := Rc(i32)(0);

  task1 := io.async((io : Io) => {
    counter.* = (counter.* + 1);
    io.await(yield(io), io);
    counter.* = (counter.* + 1);
  });

  task2 := io.async((io : Io) => {
    counter.* = (counter.* + 10);
    io.await(yield(io), io);
    counter.* = (counter.* + 10);
  });

  // Without spawn: tasks run sequentially
  io.await(task1, io); // task1 runs fully to completion
  io.await(task2, io); // then task2 runs fully to completion
  // counter = 22 either way, but no interleaving
});
export(main);
```

### Waking a task from another task: `Waker` and `Park`

`yield` hands the loop a turn; it does not let one task wait for *another
task's progress*. That needs a token the other side can fire, and
`std/async/waker` is it.

```yo
{ Park } :: import("std/async/waker");

// The waiter. Create the park, hand its waker to whoever will signal, then
// suspend — in that order, and with no await in between.
p := Park.new();
waiters.push(p.waker());
io.await(p.wait(io), io);

// The signaller, from any other task:
match(waiters.pop(), .Some(w) => w.wake(), .None => ());
```

A `Waker` is a move-only value: the waiter list above owns it once it is
pushed, `pop` moves it back out, and dropping it releases its token. A
`Park` is move-only too, and `wait` consumes it. `Mutex` and `Channel` keep
their waiter lists this way.

Three properties are worth knowing, because primitives built on this depend on
them:

- **A wake that arrives before the sleeper suspends is not lost.** An await
  point reads the future's state before it registers a continuation, so an
  already-woken park resumes inline instead of suspending.
- **Waking is idempotent.** A second `wake()`, or a wake of a park whose task
  has already finished, does nothing. A waiter list can therefore signal
  everyone without tracking who already ran.
- **A cancelled waiter says so.** `w.is_woken()` is `false` right after
  `w.wake()` when the parked task was cancelled and will never run. A waiter
  list uses that to pass the wake on to the next waiter, which is how `Mutex`
  and `Channel` stay correct under `abort` and `timeout`.
- **A park that nothing can wake is reported, not hung.** The runtime counts
  live waker tokens; when nothing is runnable, no I/O is outstanding, and a
  token is still alive, the loop says so and stops instead of spinning.

`park(register, io)` wraps the whole sequence for the common case of a single
waker:

```yo
{ park } :: import("std/async/waker");

io.await(
  park((w : Waker) => {
    slot.* = Option(Waker).Some(w);
  }, io),
  io
);
```

`register` runs *before* the suspension and receives the waker, so the order
cannot be got wrong. This is the shape Rust's `Future::poll(cx)` uses. Reach
for `Park` directly when a waiter list wants to hold the token itself.

### Sharing a lock between tasks: the async `Mutex`

`std/async/mutex`'s `Mutex(T)` is a lock whose critical section may span
awaits: a task that finds it held parks, and `unlock` hands the lock to the
longest waiter. It follows Rust's `tokio::sync::Mutex`:

- a `Mutex` is a move-only value (copying one is E0901), and tasks share one
  as `Arc(Mutex(T))`, each holding its own handle on the `Arc`;
- `lock(self : &Self, io)` and `with_lock` return a Future that borrows the
  mutex, so it is awaited where it is made, through the handle:
  `io.await(m.*.lock(io), io)` (a shared borrow through an `Arc` may cross the
  suspension, see "Borrowing Futures" above);
- it is `Send` and `Sync` when `T` is `Send`: a short blocking guard protects
  its state, so tasks on different threads' loops may contend for one. The
  guard is never held while a `with_lock` body runs;
- waiters are served in arrival order, whichever thread's loop each runs on:
  `unlock` leaves the lock held and marks it as the front waiter's, so neither
  a later arrival nor a `try_lock` can take it first.

```yo
{ assert } :: import("std/assert");
{ Mutex } :: import("std/async/mutex");
{ sleep } :: import("std/sys/timer");

main :: (fn(io : Io) -> unit)({
  m := arc(Mutex(i64).new(i64(0)));
  worker := m; // another handle on the same mutex (`m.clone()` once V2c lands)
  h := io.spawn(
    io.async({ worker }(io : Io) => {
      io.await(worker.*.lock(io), io);
      before := worker.*.get();
      io.await(sleep(u64(1)), io); // the section stays exclusive across the await
      worker.*.set(before + i64(1));
      worker.*.unlock();
    }),
    io
  );
  io.await(m.*.lock(io), io);
  m.*.set(m.*.get() + i64(1));
  m.*.unlock();
  h.await(io);
  assert(m.*.get() == i64(2), "both sections ran under the lock");
});
export(main);
```

`Rc(Mutex(T))`, the single-thread sharing (Rust's `Rc<Mutex<T>>`), works once
an `Rc` is read-only through its handle (decision 46); until then a `lock`
through an `Rc` is E0909.

### `yield_now`: a fairness yield with no timer

`std/async`'s `yield` and `std/async/waker`'s `yield_now` are the same
mechanism: the future is created pending and completed by the next ready-task
drain, after that drain has measured its budget, so the resumed task runs on
the following turn with exactly one I/O poll in between. There is no timer
under either.

Until v0.2.32 `yield` parked on a 1 ms timer, which put a millisecond floor
under everything built on it (measured over 400 turns in a spawned task:
`yield_now` 0 ms, the timer-backed `yield` 603 ms). The delay was a bootstrap
constraint, not a design one: `yield` is on the compiler's own import path,
and the seed compiler that builds the tree emits the async runtime it was
built with, so `yield` could only point at the new primitive once a published
seed carried it. `yield_now` stays as the name `std/async/waker` exports.

## Comparison with Other Languages

| Language                            | Model                    | Threading           | Memory/Task | Max Concurrency |
| ----------------------------------- | ------------------------ | ------------------- | ----------- | --------------- |
| **Yo**                              | Stackless state machines | **Single-threaded** | ~200 bytes  | Millions        |
| **JavaScript**                      | Stackless promises       | **Single-threaded** | ~100 bytes  | Millions        |
| **Python (asyncio)**                | Stackless coroutines     | **Single-threaded** | ~200 bytes  | Millions        |
| **Rust (single-threaded executor)** | Stackless futures        | **Single-threaded** | ~100 bytes  | Millions        |
| **Rust (tokio multi-threaded)**     | Stackless futures        | Multi-threaded      | ~100 bytes  | Millions        |
| **Go**                              | Stackful goroutines      | Multi-threaded      | 2KB+        | 100K-1M         |

**Note**: Yo's single-threaded async is most similar to JavaScript and Python asyncio:

- ✅ Simple mental model (no thread safety)
- ✅ No Send/Sync traits needed
- ✅ No atomic RC overhead
- ✅ Familiar to web developers

For parallelism, use `Thread(T).spawn` (see `PARALLELISM.md`).

## Effect Injection (Runtime Effect Binding)

When an async closure declares effect parameters via `e : E`, the handlers
may not be known at `io.async` creation time. Yo supports **runtime effect
injection**: the caller supplies concrete handlers at `io.spawn` or `io.await`
time, and they are bound into the future's capture struct. `io.spawn` returns a `JoinHandle(T)` which can be awaited via `handle.await(io)` returning `Option(T)`.

### When Is Runtime Injection Used?

An effect parameter becomes a runtime `void*` field in the capture struct when
**all** of the following are true:

1. The parameter is **function-typed** (not a module like `Io`)
2. The function type has **no `generic` parameters** (generic effects like
   `fn(generic(T : Type), ...) -> T` are resolved at compile time instead)
3. The handler is **not already resolved** at `io.async` creation time (no
   `(name : Type) = handler` binding in the outer scope)

If the handler IS available at creation time (via a `given` binding), it is
resolved at compile time and the parameter remains compile-time only.

### Set-Once Semantics

Effect injection follows **set-once** semantics. The first `io.spawn` or
`io.await` call that transitions a future from pending (state 0) to running
binds the effect handlers. Subsequent calls to `io.spawn`/`io.await` with
different `e : E` arguments have no effect — the original handlers are
retained.

```yo
Log :: (fn(msg : String) -> unit);
Ctx :: struct(io : Io, log : Log);

task := io.async((e : Ctx) => {
  e.log(`hello`);
});

(log1 : Log) = (
  msg -> {
    println(`Log1: ${msg}`);
  }
);

// The spawn's effect argument carries log1; it is bound into the future's
// captures when the task starts, and the JoinHandle remembers it.
handle := io.spawn(task, Ctx(io : io, log : log1));

// handle.await uses the already-bound handlers
handle.await(io);
// Output: "Log1: hello"
```

### How It Works (Implementation)

1. **Evaluator**: Function-typed `using` parameters that are unresolved at
   `io.async` time are added to the closure's `capturedVariablesWithValues`
   with `isEffectParam: true` and `value: undefined`.

2. **Capture struct**: Effect param fields are typed as `void*` in C and
   NULL-initialized when the future is created.

3. **Injection at spawn/await**: When `io.spawn(task, ...)` or
   `io.await(task, ...)` is called and the future is still cold
   (state == 0), the codegen emits assignments like:

   ```c
   future->__capture.log = (void*)fn_handler;
   ```

4. **Calling through void\***: Inside the async closure body, calls to effect
   parameters go through a function pointer cast:
   ```c
   ((return_type (*)(param_types...))sm->__capture.log)(args);
   ```

### Compile-Time vs Runtime Effects

| Condition                        | Resolution        | C representation      |
| -------------------------------- | ----------------- | --------------------- |
| `handler` in scope at `io.async` | Compile-time      | Direct function call  |
| Generic effect (`generic(T)`)    | Compile-time      | Direct function call  |
| Non-module (`Io`) type           | Compile-time      | No runtime field      |
| Non-generic, unresolved handler  | Runtime injection | `void*` capture field |

## Async + Algebraic Effects

Algebraic effects and async work together: async closures can declare effect
parameters via `e : E`, and callers inject handlers at `io.await` or
`io.spawn` time. This section covers tested scenarios and known limitations.

### Tested Scenarios

| Scenario                                    | Description                                                  |
| ------------------------------------------- | ------------------------------------------------------------ |
| Effect resume inside async closure          | Handler `return`s a value, async closure receives it         |
| Effect resume across multiple yields        | Effect called after each `io.await(yield())`                 |
| Two effects injected via `io.await`         | Two independent effect handlers injected together            |
| Two effects injected via `io.spawn`         | Same, but via `io.spawn` + `handle.await`                    |
| Effect resume in async while loop           | Effect called inside `while` loop body with yields           |
| Effect resume in while loop with break      | Effect triggers `break` based on return value                |
| Escape via injected effect aborts future    | Handler `unwind`s, future enters `Aborted` state             |
| JoinHandle unwind via spawn-injected effect | Same but with `io.spawn`, `handle.await` returns `.None`     |
| Given handler inside async with yields      | `given` binding defined inside async body, used after yields |

### Known Limitations

1. **Effect handlers are not closures** — handler functions are standalone C
   functions and cannot capture variables from the enclosing scope. Pass state
   via explicit parameters or an `Rc`. See `docs/en-US/ALGEBRAIC_EFFECTS.md`.

Limitations listed in earlier revisions of this document — the 3-argument
`while` in async, a binary expression as an async return value, and an
"async unwind RC double-decrement" that never had an issue record and does
not reproduce — are gone. See `issues/fixed/async-while-3arg-form.md` and
`issues/fixed/async-sm-result-type-binary-expr.md`.

## Summary

Yo's async/await provides:

1. **Lazy execution** — `io.async(fn)` creates cold Futures that don't start until `io.await(f, e)` or `io.spawn(f, e)`, either of which consumes the Future
2. **Single-threaded concurrency** — all async runs on one thread
3. **Concurrent spawn** — `io.spawn(f, e)` starts a cold Future without waiting, returns `JoinHandle(T)`
4. **No thread safety concerns** — no data races possible
5. **Algebraic effects** — Io capabilities explicit via `io : Io`
6. **State machine transformation** — zero-cost abstraction
7. **Non-atomic RC** — no synchronization overhead
8. **Memory efficient** — millions of concurrent tasks (~200 bytes each)
9. **Fairness** — yield points ensure tasks interleave correctly
10. **Zero-cost** — compiled to efficient C code

### Quick Reference

```yo
{ yield } :: import("std/async");

// Create lazy async task
task := io.async((io : Io) => {
  io.await(yield(io), io); // Yield to event loop
  return(i32(42));
});

// Sequential: start and run to completion
result := io.await(task, io);

// Concurrent: start tasks without waiting, then await handles
handle1 := io.spawn(task1, io);
handle2 := io.spawn(task2, io);
r1 := handle1.await(io); // Option(T)
r2 := handle2.await(io); // Option(T)
```

### Key Principles

1. **Lazy execution** — `io.async(fn)` creates cold Futures
2. **`io.await(task)`** — starts cold task, runs sequentially to completion
3. **`io.spawn(task)`** — starts cold task without waiting, returns `JoinHandle(T)`
4. **`handle.await(io)`** — waits for spawned task, returns `Option(T)` (`.None` on unwind)
5. **Single-threaded** — all async code runs on the calling thread
6. **`yield()` yields** — suspends task, gives control to other ready tasks
7. **State machines** — compiler transforms each `io.await` into state transition
8. **One thread per loop** — `io.spawn` takes no `Send` bound; `Io` and `JoinHandle` are `!Send`, so a task cannot leave its loop
9. **Non-atomic RC** — simple reference counting (no synchronization)
10. **Event loop** — runs ready tasks, checks Io completion
11. **Zero-cost** — compiled to efficient C code

### When to Use What

| Use Case                       | Mechanism                         |
| ------------------------------ | --------------------------------- |
| Io-bound concurrent tasks      | `io.async`/`io.await`             |
| Running multiple tasks at once | `io.spawn` + `handle.await`       |
| CPU-bound parallel computation | `Thread(T).spawn` (see PARALLELISM.md) |
| Background processing          | `Thread(T).spawn` (see PARALLELISM.md) |
| Waiting for multiple IOs       | `io.spawn` + `handle.await`       |
| Consuming an async sequence    | `Stream` + `for_each`/`collect` (see [Async iteration](#async-iteration-the-stream-trait)) |
| Utilizing multiple CPU cores   | `Thread(T).spawn` (see PARALLELISM.md) |

## Backend selection on Linux (`YO_IO_BACKEND`)

On Linux the runtime picks its backend once per thread, at the first async
operation, and never re-decides:

1. **io_uring** (the default wherever the kernel allows it — 5.6+, not blocked).
2. **epoll fallback** — chosen automatically when the ring cannot be created
   (a kernel without io_uring, or a sandbox that blocks it, such as Docker's
   default seccomp profile). Readiness-driven for sockets, pipes and ttys;
   regular files and the ops epoll cannot express complete synchronously in
   the future, matching the macOS backend's behavior.
3. **degraded** — only if epoll is also unavailable: every async operation
   completes with an errno instead of hanging or exiting the process.

The selection is never silent: a fallback logs one line to stderr per I/O
thread, naming the errno (and, for `ENOSYS`, the likely cause — a seccomp
filter such as Docker's default profile). Pin a backend for testing or
benchmarking with the `YO_IO_BACKEND` environment variable (`auto` (default)
| `uring` | `epoll`); a pinned backend that fails to initialize is a hard
error rather than a silent step, and any other value is an error too, so a
typo can never quietly mean `auto`.

### What runs where on Linux

Both backends try to finish an operation without the loop having to wait for
it, because a round trip through the loop (suspend the task, enter the
kernel, reap, resume) costs far more than the syscall itself:

- **Sockets:** `send`/`recv`/`sendto`/`recvfrom` are attempted inline with
  `MSG_DONTWAIT` first; only a would-block result parks the task (an io_uring
  SQE, or an epoll registration). An inline attempt never runs ahead of an
  earlier operation of the same direction still queued on that socket. A
  socket whose last inline `recv` would have blocked sends its next one
  straight to the ring (or straight to epoll), until a receive completes
  without the loop waiting.
- **Timers:** a sleep is a node in a per-thread timer heap on both backends;
  the loop's wait is bounded by the earliest deadline. Arming and cancelling
  one costs no syscall (std/async's `timeout` cancels its deadline whenever
  the guarded work wins).
- **File metadata on io_uring:** `stat`, `mkdir`, `unlink`, `rename`,
  `symlink`, `link` and opens that create or truncate run inline on the loop
  thread. The kernel cannot do them without blocking, so io_uring always
  hands them to a worker thread; the hand-off measured ~57 µs against
  0.3–3 µs for the syscall itself. A path lookup on a slow or network
  filesystem blocks the loop for its duration — the contract macOS and the
  epoll fallback already had. Buffered writes are tried inline with
  `RWF_NOWAIT` and go to the ring only when the kernel refuses; ext4 and
  tmpfs refuse on current kernels, and the refusal is remembered per
  descriptor. Reads, plain opens, `fsync` and `ftruncate` stay on the ring.
- **Watches** (`std/sys/events` poll handles, `std/fs/watch`): a watched
  descriptor ends a blocked wait, so a callback fires while unrelated I/O is
  in flight, and `Watcher.next` parks rather than polling.

### What runs where on macOS

The kqueue backend follows the same "finish it without the loop" rule, and adds
two macOS-specific ones: the loop never pays for a kernel scan that can find
nothing, and it never wakes without a reason.

- **Sockets:** `send`/`recv`/`sendto`/`recvfrom`/`accept` are attempted
  inline (with `MSG_DONTWAIT`) first; only a would-block result parks the
  task on the descriptor's `EVFILT_READ`/`EVFILT_WRITE` knote. An inline
  attempt never runs ahead of an earlier operation of the same direction still
  parked on that descriptor. A socket whose last inline `recv` would have
  blocked parks its next one directly, until a receive turns out to have had
  its data already. A delivered `recv` without flags is a plain `read`: the
  event reports the byte count, so it cannot block.
- **Regular files:** `pread`/`pwrite` complete at start (the unified buffer
  cache makes them fast). A `pread` that answers `ESPIPE` (pipe, socket, FIFO)
  or `ENXIO` (tty) falls back to the readiness path. A descriptor opened
  `O_APPEND` writes at end-of-file.
- **Timers:** a sleep is a node in a per-thread timer heap, and the loop's
  `kevent()` wait is bounded by the earliest deadline. Arming and cancelling
  one costs no syscall. The OS still coalesces timer wakeups: a 1 ms deadline
  wakes after ~1.25 ms, the same as libuv and any other `kevent()` timeout.
- **The loop's kernel entries:** a turn with nothing in the kernel (only
  timers, or operations that all completed at start) makes no syscall. A turn
  that leaves no task runnable makes no poll of its own, because the next
  step's blocking `kevent()` reaps the same events in the same call. On macOS
  26 a zero-timeout `kevent()` that finds nothing costs ~12 µs, so a
  non-blocking poll first asks the kqueue descriptor with a zero-timeout
  `select()` (~0.2 µs). With tasks still queued, the kernel is polled every
  61 turns (tokio's interval). While traffic is flowing (the last wait was
  answered within 50 µs), a wait is bounded by 50 µs rather than unbounded:
  on macOS a wait with a near deadline wakes sooner, which is worth ~7% on a
  loopback-TCP round trip. The first such wait that times out empty ends it.
- **Watches** (`std/sys/events` poll handles, `std/fs/watch`): they share one
  watch kqueue per thread, nested in the loop's. A watched descriptor ends a
  blocked wait, and a directory watch rescans on the directory's vnode events,
  plus at most every 50 ms for writes into existing entries, which only a
  rescan sees.

### Operation lifetimes are the same on every backend

- **Closing a descriptor ends the operations still pending on it**: they
  complete with `-EBADF` (kqueue, epoll and io_uring alike — the ring cancels
  its requests, because an io_uring request holds its own file reference and
  would otherwise outlive the descriptor). That includes `dup2` over an open
  descriptor, which closes it. Close descriptors the runtime has
  waited on through std (`file.close`, `tcp.close`, `pipe.dup2`), not a raw
  `libc` `close`: the backend cannot see a close it is not told about.
- **Concurrent receives on one stream socket:** kqueue and epoll complete
  them in the order they were issued; io_uring does not order them (a later
  `recv` may get the next bytes). Each byte still reaches exactly one
  `recv`.
- **Aborting a task cancels the operation it is suspended in**, so an aborted
  `recv` never consumes data a later `recv` should see.
- **A `std/net` stream write to a peer that has closed throws**
  (`IoError.BrokenPipe`, or a reset) instead of raising `SIGPIPE`, whose
  default action kills the process. `TcpStream`/`UnixStream` writes go
  through `std/sys`'s `stream_write`: `write(2)` on macOS, where std sets
  `SO_NOSIGPIPE` on every stream it connects or accepts, and
  `send(MSG_NOSIGNAL)` on Linux. The raw `std/sys` `send` passes its flags
  through unchanged.
- **Sockets may be blocking or nonblocking** for `send`/`recv`/`sendto`/
  `recvfrom`: the readiness backends attempt them with `MSG_DONTWAIT`.
  `accept`, `connect` and `read`/`write` on a pipe or tty need a nonblocking
  descriptor on the macOS and epoll backends (every socket and pipe std
  creates is one); a blocking descriptor there blocks the loop thread for the
  duration of the call. io_uring handles either mode.
- A Unix-domain `connect` to a listener whose backlog is full is retried by
  io_uring until it connects; the epoll fallback reports `EAGAIN` instead —
  readiness cannot express "the backlog has room".
