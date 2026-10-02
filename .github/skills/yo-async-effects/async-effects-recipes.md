# Yo Async and Effects Recipes

These patterns cover normal Yo async code and algebraic effects.

## Pick the right execution model

| Need                       | Pattern                                                |
| -------------------------- | ------------------------------------------------------ |
| Sequential async work      | `result := io.await(task, io)`                         |
| Start work and wait later  | `handle := io.spawn(task, io)` then `handle.await(io)` |
| Yield to other ready tasks | `io.await(yield(io), io)`                                |
| True multithreading        | Use thread or parallelism APIs, not `io.async` alone   |

## Minimal async function

```rust
{ yield } :: import("std/async");

pause_then_answer :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
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
    io.await(yield(io), io);
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
    io.await(yield(io), io);
    i32(1)
  });
  task2 := io.async((io : Io) => {
    io.await(yield(io), io);
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

unwind_example :: (fn() -> i32)({
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
    ctx.io.await(yield(ctx.io), ctx.io);
    safe_divide(i32(10), i32(2), ctx.raise)
  })
);
```

- The closure takes a single bundle parameter (e.g. `ctx : TaskCtx`).
- Inside the body, fields are accessed via dot (`ctx.io`, `ctx.raise`).
- The Future type names the same bundle struct: `Future(i32, TaskCtx)`.
- Build the bundle at the call site (`ctx := TaskCtx(io: io, raise: raise)`) and
  pass it to `io.await` / `io.spawn`.

## Async recursion — call the outer function by name

Inside an `io.async` lambda, `recur` names the LAMBDA (its own signature), not the
outer function, so `recur(n, io)` there is an argument-count error. Call the outer
`::` function by its name instead; each level is its own future:

```rust
count_down :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) =>
    cond(
      (n == i32(0)) => i32(0),
      true => (io.await(count_down((n - i32(1)), io), io) + i32(1))
    )
  )
);
```

An iterative worklist with an `ArrayList` as the stack avoids one future per level:

```rust
{ read_dir, DirEntry } :: import("std/fs/dir");

WalkCtx :: struct(io : Io, exn : Exception);

process_dir :: (fn(root : Path, io : Io) -> Impl(Future(unit, WalkCtx)))(
  io.async((ctx : WalkCtx) => {
    stack := ArrayList(Path).new();
    { stack.push(root); };

    while(stack.len() > usize(0), {
      cur := match(stack.pop(), .Some(p) => p, .None => return());
      entries := ctx.io.await(read_dir(cur, ctx.io), { io : ctx.io, exn : ctx.exn });
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
- **`recur` inside `io.async` calls the lambda, not the outer function** — call the outer function by name (or use an iterative worklist) for async recursion.
- **`io.await` may appear anywhere in an `io.async` body**: a `match`
  scrutinee, nested inside a condition (`if(!io.await(…), …)`), a later `cond`
  branch, an operand (`add(io.await(a, io), io.await(b, io))`), a `while`
  condition or step, a macro expansion. The body is lowered in one pass, and
  each await suspends exactly where it is written, in source order; laziness
  is kept (an await in a later branch or on the right of `&&` runs only when
  reached). This replaced the segment lowering, whose unsupported shapes were
  rejected with E0904 or silently miscompiled
  (`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5).
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

  The `join_all`-style nesting above is the restriction that still stands
  (it re-enters the event loop, `issues/fixed/build-scheduler-join-all-nests-the-event-loop.md`);
  ordinary await PLACEMENT no longer is — since #1018 an `io.await` may sit
  directly in (or nested inside) a `while` condition, a `cond` condition or
  a `match` scrutinee. Gate any `src/` code that spawns with a cli-case
  carrying `env=YO_ASYNC_STRICT=1`; nothing else makes the nesting visible.
- **Build a combinator chain OUTSIDE the `io.async` body that awaits it.** An
  `=>` closure passed to a generic callback parameter INSIDE an async body
  leaves the enclosing future's result type unresolved, and the error lands on
  the SPAWN site (`No matching call found with arguments: (h.await)(io)`), not
  on the closure. A `(fn(x : T) -> R)(...)` literal in the same position works,
  and so does the same call outside the body
  (`issues/fixed/closure-argument-inside-an-io-async-body-loses-the-future-result-type.md`).
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
- A generic consumer takes a bare bound (`where(S <: Stream)`), a concrete one
  (`Item := i32`), or a generic one (`where(S <: Stream(Item := A))`, with `A`
  bound from the argument's impl). The blanket combinators (`s.collect(io)`,
  `s.map(f)`) can be called on such a parameter. `Iterator` bounds work the same.

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
{ ToString, println } :: import("std/fmt");

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

### Swallowing exceptions with a fallback value (unwind out of a helper)

An `Exception` handler CANNOT resume the throw with a value: `throw`'s resume type
is chosen by each throw site, so `err -> { return(ExitStatus(raw: i32(1))); }` is a
compile error that points at `ResumableException`. It must `unwind`, diverge, or
fall through with `()`. To turn a failing operation into a fallback value, install
the handler in a small helper and `unwind` the fallback out of it:

```rust
{ Command } :: import("std/process/command");
{ Exception } :: import("std/error");

// `true` if the tool runs and exits 0; `false` if it fails or cannot be spawned.
tool_ok :: (fn(cmd : Command, io : Io) -> bool)({
  exn := Exception(throw: (err -> {
    unwind(false);
  }));
  status := io.await(cmd.status(io), { io, exn });
  status.success()
});
```

`unwind(v)` exits the function that installed the handler (`tool_ok`) with `v`.
To resume the throw site with a recovery value instead, the callee must take a
`ResumableException(T)`:

`ResumableException(ResumeType)` is a struct-record effect for resumable error handling. The handler uses `return` to resume with a recovery value:

```rust
{ Exception, ResumableException } :: import("std/error");
{ ToString, println } :: import("std/fmt");
{ assert } :: import("std/assert");

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
