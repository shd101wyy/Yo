# Yo Async and Effects Recipes

These patterns cover normal Yo async code and algebraic effects.

## Pick the right execution model

| Need                       | Pattern                                                |
| -------------------------- | ------------------------------------------------------ |
| Sequential async work      | `result := io.await(task, io)`                         |
| Start work and wait later  | `handle := io.spawn(task, io)` then `handle.await(io)` |
| Yield to other ready tasks | `io.await(yield(), io)`                                |
| True multithreading        | Use thread or parallelism APIs, not `io.async` alone   |

## Minimal async function

```rust
{ yield } :: import("std/async");

pause_then_answer :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(), io);
    i32(42)
  })
);
```

- `io.async(...)` is lazy.
- The closure's parameter is the effect bundle. The simplest bundle is just `Io`.
- The `Future(T, E)` return type names the same bundle type that the closure consumes.

## Sequential await

```rust
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    io.await(yield(), io);
    i32(1)
  });

  result := io.await(task, io);
  assert((result == i32(1)), "unexpected result");
});

export(main);
```

## Concurrent tasks on the same thread

```rust
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io) => {
    io.await(yield(), io);
    i32(1)
  });
  task2 := io.async((io : Io) => {
    io.await(yield(), io);
    i32(2)
  });

  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);

  result1 := handle1.await(io);
  result2 := handle2.await(io);
});

export(main);
```

- `io.spawn(...)` begins execution without waiting.
- `handle.await(io)` returns `Option(T)` because a spawned task can abort via `unwind`.

## Propagating and handling effects

Handlers are typed `fn(...) -> R` when they only resume, and `ctl(...) -> R` when their
body may `unwind`. Use the local binding form `(name : EffectType) = ((args) -> { ... })`
to install a handler; lambdas on the RHS of `=` need outer parens.

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : String) -> i32);

safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond(
    (y == i32(0)) => raise(`divide by zero`),
    true => (x / y)
  )
);

resume_example :: (fn() -> i32)({
  // No `unwind` in this body — type the binding as the same Raise (a `ctl` is also a `fn`-compatible value when not unwinding).
  // Use plain `fn(...) -> i32` if you want to forbid unwind altogether at this site.
  (raise : Raise) = (msg -> {
    println(msg);
    return(i32(0));
  });

  safe_divide(i32(8), i32(0), raise)
});

escape_example :: (fn() -> i32)({
  (raise : Raise) = (msg -> {
    println(msg);
    unwind(i32(-1));
  });

  safe_divide(i32(8), i32(0), raise)
});
```

| Handler action  | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `return(value)` | Resume the continuation with `value`                                                    |
| `unwind(expr)`  | Exit the function that installed the handler. Only valid inside a `ctl(...) -> R` body. |

## Futures with multiple effects — bundle them in a struct

`Future(T, E)` accepts a single effect type `E`. To carry several effects, declare a
bundle struct and pass that.

```rust
{ yield } :: import("std/async");

Raise :: (ctl(msg : String) -> i32);
TaskCtx :: struct(io : Io, raise : Raise);

work :: (fn(ctx : TaskCtx) -> Impl(Future(i32, TaskCtx)))(
  io.async((ctx : TaskCtx) => {
    ctx.io.await(yield(), ctx.io);
    safe_divide(i32(10), i32(2), ctx.raise)
  })
);
```

- The closure takes a single bundle parameter (e.g. `ctx : TaskCtx`).
- Inside the body, fields are accessed via dot (`ctx.io`, `ctx.raise`).
- The Future type names the same bundle struct: `Future(i32, TaskCtx)`.
- Build the bundle at the call site (`ctx := TaskCtx(io: io, raise: raise)`) and
  pass it to `io.await` / `io.spawn`.

## Async recursion — use an iterative worklist instead

`recur` does **not** work inside an `io.async` lambda — it refers to the lambda's own signature, not the outer function. Calling the outer function by name is also forbidden in Yo. Attempting either will produce a compile-time error.

**Solution**: replace async recursion with an iterative worklist using `ArrayList` as a stack:

```rust
{ read_dir, DirEntry } :: import("std/fs/dir");

WalkCtx :: struct(io : Io, exn : Exception);

process_dir :: (fn(root: Path, ctx : WalkCtx) -> Impl(Future(unit, WalkCtx)))(
  io.async((ctx : WalkCtx) => {
    stack := ArrayList(Path).new();
    { stack.push(root); };

    while(stack.len() > usize(0), {
      cur := match(stack.pop(), .Some(p) => p, .None => return());
      entries := ctx.io.await(read_dir(cur, ctx.io), ctx.io);
      // process `entries`, push subdirectories to `stack`
      n := entries.len();
      i := usize(0);
      while(i < n, {
        match(entries.get(i),
          .None => (),
          .Some(e) => {
            match(e.file_type,
              .Directory => { stack.push(cur.join(Path.new(e.name))); },
              _ => ()   // handle files here
            );
          }
        );
        i = (i + usize(1));
      });
    });
  })
);
```

## Common pitfalls

- `io.async(...)` does not run immediately.
- `unwind` is only valid inside a `ctl(...) -> R` body. From any other position
  (match arm, `cond` branch, `begin` block, plain `fn` body), use `return`.
- `unwind` inside an async task aborts the future instead of completing it normally.
- `io.await(...)` on an already-aborted future can panic; `JoinHandle.await(...)` converts abort into `.None`.
- Closures cannot be `ctl`, and they cannot capture a `ctl`-typed value. Handlers are bare (non-capturing) anonymous functions. If you need to use a `ctl` handler from inside a closure body, pass it in as an explicit parameter instead of capturing it.
- Pointers and references to `ctl` types (or structs containing them) are rejected.
- **`recur` inside `io.async` calls the lambda, not the outer function** — use an iterative worklist for async recursion.
- **`io.await` in a branch condition must BE the condition, not nested in it.**
  Supported directly inside `io.async`:

  ```rust
  if(io.await(exists(p, io), io), { ... });                 // ✓
  cond(io.await(ready(io), io) => ..., true => ...);        // ✓ (first branch)
  match(io.await(num(io), io), 42 => ..., _ => ...);        // ✓ scrutinee
  while(io.await(more(io), io), { ... });                   // ✓ condition
  while(c, { ... io.await(f, io) ... }, { ... });           // ✓ step (arg 2)
  ```

  Codegen hoists these across the state boundary. They are real suspensions —
  a task spawned first still interleaves — not blocking waits.

  Three cases are rejected, each with a diagnostic naming the fix:

  ```rust
  // ✗ nested inside a larger expression — bind it first
  if(!io.await(exists(p, io), io), { ... });
  found := io.await(exists(p, io), io);
  if(!found, { ... });                                      // ✓

  // ✗ a LATER cond branch: `cond` is lazy, so hoisting would await even when
  //   an earlier branch matches. Bind it first (evaluates unconditionally).
  cond(c1 => ..., io.await(f, io) => ..., true => ...);
  ```

  This whole area only applies **inside `io.async`**. At the top level of a
  plain `fn`, `io.await` drives the loop synchronously and may appear anywhere.

  Historically the unsupported shapes were a **silent** miscompile: `rc=0` and
  a segfaulting binary with the branch body dropped. See
  `issues/fixed/yo-self-init-segfaults-on-first-run.md` and
  `issues/fixed/await-in-branch-positions-matrix.md`.
- **An `io.await` reached only through a MACRO EXPANSION is compiled as a
  BLOCKING await** (measured 2026-09-11). Codegen looks for awaits in the
  body's own AST, and a macro call keeps the macro head there — the expansion
  lives in `ExprInfo.macro_expansion`. So a body whose only awaits come from a
  macro is emitted as a plain closure (no state machine) with
  `// Synchronous await (io.await outside state machine)` in the C. Inside a
  spawned task that is a DEADLOCK: `io.spawn` never returns from the cold
  start, so the caller never reaches whatever would satisfy the await. It only
  shows up when the awaited future depends on the caller — a timer completes
  on its own and the program merely serialises, so an awaiting macro can pass
  a whole test suite and then hang. This is why `std/async/stream.yo` ships NO
  `for_await` macro
  (`issues/io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md`,
  `plans/backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`).
- **`join_all` / `race` / `any` / `timeout` are TOP-LEVEL combinators — never
  call one from inside an `io.async` body.** They wait by looping
  `__yo_async_poll_step()`, and an `io.async` body always runs as a RESUMED
  continuation, so the loop re-enters the event loop from inside a task: C37's
  guard aborts under `YO_ASYNC_STRICT=1`, and without it the "concurrent" code
  silently runs serially. To collect spawned work from inside an async body,
  poll and yield, then read the results:

  ```rust
  // ✗ inside io.async — nests the event loop
  outs := join_all(handles, io);

  // ✓ every handle terminal first; then `await` reads without polling
  while(runtime(_any_pending(handles)), { io.await(yield(io), io); });
  (i : usize) = usize(0);
  while(i < handles.len(), { outs.push(handles(i).await(io)); i = (i + usize(1)); });
  ```

  Keep the `while` CONDITION a plain `fn` — an `io.await` nested inside a
  larger condition expression is one of the rejected shapes above. Gate any
  `src/` code that spawns with a cli-case carrying `env=YO_ASYNC_STRICT=1`;
  nothing else makes the nesting visible
  (`issues/fixed/build-scheduler-join-all-nests-the-event-loop.md`).
- **Build a combinator chain OUTSIDE the `io.async` body that awaits it.** An
  `=>` closure passed to a generic callback parameter INSIDE an async body
  leaves the enclosing future's result type unresolved, and the error lands on
  the SPAWN site (`No matching call found with arguments: (h.await)(io)`), not
  on the closure. A `(fn(x : T) -> R)(...)` literal in the same position works,
  and so does the same call outside the body
  (`issues/closure-argument-inside-an-io-async-body-loses-the-future-result-type.md`).
- **Do not bind a captured value to a local and then call a SUSPENDING method
  on the local** inside an async body: `local := captured_stream;` followed by
  `io.await(local.next(io), io)` emits invalid C (a state-machine field
  assigned from the wrong capture type). Await on the captured NAME itself.

## Async iteration — `Stream`

`std/async/stream` is the async analogue of `Iterator`: `next(self, io)`
answers `Impl(Future(Option(Self.Item), Io))`, and `.None` is terminal.

```rust
{ Stream } :: import("std/async/stream");

conns := listener.incoming().take(usize(3));    // lazy chain, built out here
io.await(conns.for_each(c => serve(c), io), io);
```

- The future's effect bundle is **`Io`, not `IoExn`** — a stream never throws.
  A fallible stream carries the failure in the ITEM (`Item = Result(T, E)`,
  e.g. `incoming`'s `Result(TcpStream, NetError)`).
- `next` takes `self : Self` (not `inout(self)`), so every source is a
  `ref(struct(...))` — a future cannot hold an `inout` borrow across a
  suspension.
- Implementors: `TcpListener.incoming()`, `Watcher`, `Channel(T)`.
  Combinators: `map`, `filter`, `filter_map`, `take`, `skip`; consumers:
  `for_each`, `collect`.
- A generic consumer uses a BARE bound (`where(S <: Stream)`) or a CONCRETE
  one (`Item := i32`). `where(S <: Stream(Item := A))` with a generic `A`
  binds nothing and rejects every argument — `Iterator` behaves the same way
  (`plans/backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md`). A blanket-impl
  combinator method also cannot be called on a generic stream PARAMETER
  (`s.collect(io)` → `No matching call found`); the trait's own `next` can.

## Waking a task from another task — `Waker` / `Park`, and `yield_now`

`yield` hands the loop a turn; it does not let one task wait for ANOTHER
task's progress. `std/async/waker` is that primitive.

```rust
{ Park, park, yield_now } :: import("std/async/waker");

// The waiter: create the park, hand its waker to whoever will signal, THEN
// suspend — in that order, with no await in between.
p := Park.new();
waiters.push(p.waker());
io.await(p.wait(io), io);

// The signaller, from any other task:
match(waiters.pop(), .Some(w) => w.wake(), .None => ());

// Or, for the single-waker case, with the ordering built in:
io.await(park((w : Waker) => { slot.* = Option(Waker).Some(w); }, io), io);
```

- A wake that arrives BEFORE the sleeper suspends is not lost: an await point
  reads the future's state before it registers a continuation, so an
  already-woken park resumes inline.
- Waking is idempotent — a waiter list can signal everyone without tracking
  who already ran.
- A park nothing can wake is REPORTED, not hung: the runtime counts live waker
  tokens, and a loop with a parked task and no token left says so and stops.
- **`yield_now(io)` is `yield` without the 1 ms timer.** Same guarantee (one
  loop turn, including an I/O poll), measured at 0 ms against `yield`'s 603 ms
  over 400 hand-offs. `std/async`'s own `yield` is still on the timer for a
  bootstrap reason, not a design one — it is on the compiler's import path and
  the seed emits a runtime without the new symbol — so prefer `yield_now` in
  new code.

Do NOT poll with `while(!h.is_finished(), io.await(yield(io), io))` when a
waker will do: that is the millisecond floor this exists to remove.

## Exception (non-resumable)

`Exception` is a built-in struct-record effect for non-resumable error handling. When the handler calls `unwind`, the continuation is discarded:

```rust
{ Exception } :: import("std/error");
{ println } :: import("std/fmt");

DivError :: enum(DivByZero);
derive(DivError, Error(.DivByZero => `division by zero`));

safe_divide :: (fn(x : i32, y : i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(DivError.DivByZero)),
    true => (x / y)
  )
);

main :: (fn() -> unit)({
  exn := Exception(
    throw : (err -> {
      println(`Error: ${err}`);
      unwind(());
    })
  );

  result := safe_divide(i32(10), i32(2), exn);
  println(`result: ${result}`);

  safe_divide(i32(10), i32(0), exn);
});

export(main);
```

- The struct constructor `Exception(...)` already pins the binding's type, so a plain `exn := Exception(...)` is enough — no `(exn : Exception) = ...` annotation needed. The annotation form is only required when the RHS is a raw lambda that has to commit to `ctl(...) -> R`.
- `Exception` has a single field `throw : (ctl(error : AnyError) -> T)`.
- `exn.throw(dyn(error))` calls the handler with a type-erased error.
- Handler uses `unwind` to discard the continuation and exit the enclosing function.
- Code after the escaped call is never reached.

### Swallowing exceptions with a fallback value (return in Exception handler)

When an exception is thrown inside an async operation (e.g., `cmd.status()` or `cmd.output()`), you can **swallow the error and resume with a fallback value** by using `return` in the handler (not `unwind`). The `ResumeType` is the return type of the operation that would have thrown.

```rust
{ Command, ExitStatus, Output } :: import("std/process/command");

// Check if a tool is available — returns false if it throws (e.g., not found)
try_exn := Exception(throw: (err -> {
  return(ExitStatus(raw: i32(1)));  // resume with "failed" exit status
}));
status := io.await(cmd.status(io, try_exn), io);
available := status.success();  // false if exception was swallowed

// For cmd.output(), resume with a failed Output:
out_exn := Exception(throw: (err -> {
  return(Output(status: ExitStatus(raw: i32(1)), stdout: ArrayList(u8).new(), stderr: ArrayList(u8).new()));
}));
out := io.await(cmd.output(io, out_exn), io);
if(!out.status.success(), { return(); });  // handle failure
```

Key: the `return` inside the handler resumes the _effect invocation site_ with the provided value. The calling code then sees the fallback as if the operation returned normally. Use `unwind` only when the enclosing function returns `unit` (e.g., test bodies).

`ResumableException(ResumeType)` is a struct-record effect for resumable error handling. The handler uses `return` to resume with a recovery value:

```rust
{ Exception } :: import("std/error");
{ println } :: import("std/fmt");

safe_divide :: (fn(x : i32, y : i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(`division by zero`)),
    true => (x / y)
  )
);

main :: (fn() -> unit)({
  exn := ResumableException(i32)(
    throw : (err -> {
      println(`Recovering from: ${err}`);
      return(i32(0));
    })
  );

  result := safe_divide(i32(10), i32(0), exn);
  assert((result == i32(0)), "recovered with 0");
});

export(main);
```

- Handler uses `return(value)` to resume the continuation with the recovery value.
- The call site receives the returned value and continues normally.

## Struct-record effects vs function-type effects

Effects in Yo can be plain function/ctl types or struct-record types that group several
operations:

```rust
Raise :: (ctl(msg : String) -> i32);

Logger :: struct(
  log : (fn(level : i32, msg : String) -> unit)
);
```

Both kinds are passed as explicit parameters. Struct-record effects group related
operations under a single nominal type — that pattern composes naturally with the
"single bundle struct" Future contract.

## Effect-bundle polymorphism (advanced)

A function can be polymorphic over the effect bundle a Future carries by quantifying
over `E : Type.Struct`:

```rust
wait_then :: (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T)(
  io.await(fut, e)
);
```

- `generic(E : Type.Struct)` constrains `E` to be a struct (so its fields can be looked
  up at call sites and injected into the underlying state machine).
- See [ALGEBRAIC_EFFECTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ALGEBRAIC_EFFECTS.md) for the full design.
