# A deadline combinator usable from INSIDE a task — and the HTTP server keep-alive it blocks

**Status: BACKLOG.** Written 2026-09-11 while landing the client-side HTTP
connection pool (`plans/STD_API_STABILIZATION.md`, "HTTP keep-alive, the
pooling client"). The client half needs no such thing; the SERVER half cannot
be written without one, and this doc is the measured answer to "is it in
reach today?".

## The blocked call site

`std/http/server.yo`, `HttpServer.serve_once`:

```rust
serve_once : (fn(self : Self, handler : ..., io : Io) -> Impl(Future(unit, IoExn)))(
  io.async(e => {
    stream := e.io.await(self.listener.accept(e.io), e);
    framed := e.io.await(read_http_message(stream, self.max_request_bytes, MessageKind.Request, e.io), e);
    ...
  })
)
```

Server keep-alive means looping that framing read on the same connection until
the client goes away. `serve` is one connection at a time, so a client that
holds a persistent connection open and sends nothing would wedge the server
for every other client — which is why the server half is not simply "loop
until the client closes". It needs an IDLE TIMEOUT: the second `await` above
has to become "either the next request's bytes, or a deadline".

## Why `std/async`'s `timeout` cannot be used there

`timeout(handle, limit, io)` is a **blocking-poll plain `fn`**: it drives the
event loop itself (`__yo_async_poll_step` in a `while`) until the handle or the
deadline finishes. That is fine on a caller's own stack, and it is exactly what
a test does. It is not usable inside an `io.async` body: calling a
loop-driving plain function from within a task nests the event loop and freezes
every other task on it until the inner loop returns
(`issues/fixed/sync-await-in-plain-fn-nests-the-event-loop.md`). `serve_once`
IS an `io.async` body.

So `timeout` does not compose with the framing read. `std/async` offers no
`Future`-returning equivalent — `join_all`, `race`, `any` and `timeout` are all
the same blocking-poll shape, and all take `JoinHandle`s rather than futures —
so there is nothing in `std/async` to compose with.

## What DOES work today, and what it costs

The pattern that works inside a task is hand-rolled, and this tree already has
one instance of it: `std/http/client.yo`'s `_fetch_deadline`, which implements
`FetchOptions.timeout`.

```rust
h := e.io.spawn(work(e.io), e);              // the operation, as a task
dh := e.io.spawn(sleep(limit, e.io), e.io);  // the deadline, as a task
while(runtime(!h.is_finished() && !dh.is_finished()), {
  e.io.await(yield(e.io), e.io);             // a REAL suspension point
});
```

It composes with the framing read, because `read_http_message_buffered` is
itself an `io.async` future and can be spawned. Two costs come with it:

1. **Cancelling a parked read leaks.** When the deadline wins, the read task is
   `abort()`ed while its 8 KiB buffer is registered with the I/O backend. The
   buffer is `malloc`ed inside the async body and freed by a statement at the
   end of that body, so an abort skips the free: one 8 KiB buffer plus one
   state machine per timed-out connection. (`std/async`'s `timeout` records the
   mirror-image residual for its deadline timer —
   `issues/timeout-deadline-timer-future-leak.md`.) There is no way to avoid
   it with today's primitives: the read is already in flight by the time the
   deadline is known, and the backend has no cancel.
2. **A polling wait, not a woken one.** `yield` parks on a 1 ms timer, so an
   idle server burns a wakeup per millisecond per connection. `std/async`'s own
   doc header already names the waker-based rewrite as planned work.

## Options

**A. Hand-roll the race in `std/http/server.yo`.** Hoist it into its own
`io.async` helper (`_read_request_or_deadline`) so the connection loop stays
flat — an await one branch under a `while` is a supported shape; a `while` with
awaits nested inside another `while`'s branch is not, and that is what the
inline version would be. Cost: the leak and the polling above, plus the
contract change discussed below. Roughly 80 lines.

**B. Add a `Future`-returning deadline combinator to `std/async`.** The missing
API is something like

```rust
with_deadline :: (fn(generic(T : Type), fut : Impl(Future(T, IoExn)), limit : Duration, io : Io)
  -> Impl(Future(Result(T, TimeoutError), IoExn)))
```

i.e. `timeout`'s semantics with `timeout`'s blocking poll replaced by an
`io.async` body, awaitable from inside a task. Written with today's primitives
its body IS option A's race, so it does not remove the leak — but it puts the
one hand-rolled race in one place instead of once per call site, and it is the
natural home for the fix when the backend gains read cancellation or the waker
rewrite lands.

**C. Cancellation in the I/O backend.** The real fix for cost 1: a way to
withdraw a submitted read so the aborted task's buffer can be freed. That is
`src/codegen/async/runtime_io_*.yo` work on three platforms and is a campaign,
not a step.

## Recommendation

**B, then A on top of it, and not before C is at least scoped.** Concretely:

1. Add `with_deadline` to `std/async` and re-express
   `std/http/client.yo`'s `_fetch_deadline` in terms of it — that removes a
   hand-rolled race from `std/http` and gives the combinator a caller that
   already has tests.
2. Land server keep-alive on top of it, **opt-in** (`with_keep_alive(idle)`),
   leaving the default one-request-per-connection shape alone. Opt-in is not
   timidity here: keep-alive on a strictly serial server lets one client
   monopolize it, so the safe default for `HttpServer` as it stands is off.
3. File the backend cancellation work separately; until it exists, document the
   per-timeout leak on `with_keep_alive`.

## Collateral the server half carries (why it is not a small step)

Turning `serve_once` into a connection loop changes what it MEANS, and existing
tests encode the current meaning:

- `tests/http/server.test.yo`'s `_read_all` reads until the server closes.
  Under keep-alive it waits out the idle timeout instead — every such test
  pays the deadline.
- "bytes pipelined after a body-less request are not its body" asserts that the
  second request in one write is NOT served (`!raw.contains("/smuggled")`).
  Under keep-alive, serving it is CORRECT — pipelining is legal — so the test
  has to be re-expressed as "the second request is framed as its own message",
  which is the same property stated the other way round.
- Every response currently gets `Connection: close` added when the handler set
  none; that becomes "add nothing (HTTP/1.1 is persistent) unless keep-alive is
  off".

Doing this under an opt-in flag (step 2 above) avoids all of it: the default
path keeps its contract and its tests, and the keep-alive path gets its own.
