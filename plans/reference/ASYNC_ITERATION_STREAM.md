# Async iteration — a `Stream` trait

> **CLOSED 2026-09-11 — LANDED, with two of five items parked.** `std/async/stream.yo`
> ships the `Stream` trait and the lazy combinators `map` / `filter` /
> `filter_map` / `take` / `skip` plus the consumers `for_each` / `collect`.
> Implementors: `Watcher` (`std/fs/watch.yo` — its hand-rolled `next` BECAME
> the trait method, unchanged), `TcpListener.incoming` (`std/net/tcp.yo` — the
> deferred `plans/STD_API_STABILIZATION.md` row, now closed) and `Channel(T)`
> (`std/async/channel.yo` — `next` IS `recv`). Tests:
> `tests/async/combinators.test.yo` (27), `tests/async/channel.test.yo` (8),
> `tests/net/tcp.test.yo` (21), `tests/fs/watch.test.yo` (6) — every combinator
> awaited from a spawned task as well as from `main`, each bounded by
> `std/async`'s `timeout`.
>
> **Parked, with reasons measured rather than guessed:**
>
> - **`for_await` (item 4) was written and then REMOVED.** An `io.await` reached
>   only through a MACRO EXPANSION is not counted as a suspension point, so the
>   enclosing `io.async` body is emitted as a plain closure with a BLOCKING
>   await — correct from `main`, a deadlock inside a task. See
>   `issues/io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md`
>   and `plans/backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`.
>   `for_each` + `take` and the hand-written `while` loop cover the ground
>   meanwhile.
> - **`BufReader.lines` (item 5, second half) needs a non-throwing read.** A
>   stream reports failure in the ITEM, `read_line` THROWS, and a `ctl` handler
>   cannot be installed across a suspension or stored in a `ref` struct — so the
>   blocker is `Reader`'s error style, not the stream protocol:
>   `plans/backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md`.
>
> **Two corrections to the design below**, both measured:
>
> 1. `next`'s future is `Impl(Future(Option(Self.Item), Io))` — the second type
>    argument is **`Io`, not `IoExn`** as written under "Design". `Io` is what
>    `Watcher.next` already used and what compiles; it is also the right shape,
>    since a stream that never throws needs no `Exception` in its bundle.
> 2. `TcpListener.incoming`'s item is `Result(TcpStream, NetError)`, not
>    `Result(TcpStream, IoError)`. `NetError` is the type `accept` THROWS, so a
>    server loop moving from `accept` to `incoming` keeps one error vocabulary
>    (`NetError.Io(IoError)` still carries the raw errno case).
>
> Two shape constraints found while landing it, recorded for the next reader:
> a free function's `where(S <: Stream(Item := A))` with a GENERIC `A` binds
> nothing and rejects every argument (a bare bound or a concrete item type
> works, and `Iterator` behaves the same —
> `plans/backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md`), and a chain built
> INSIDE an `io.async` body loses the future's result type
> (`issues/closure-argument-inside-an-io-async-body-loses-the-future-result-type.md`)
> — build the chain outside, await it inside.

**Status:** LANDED 2026-09-11 (was: BACKLOG, written 2026-09-10 because
`TcpListener.incoming` was deferred on it, and because four std APIs had
independently invented the same shape by hand).

## The problem

Yo has `Iterator` (with an associated `Item` type, `docs/en-US/DESIGN.md`) and
it has `Future`, but nothing that is both. There is no async analogue of
`Iterator` — no type that yields *"a value, later, repeatedly"*.

So every std API that produces a sequence asynchronously invents its own
shape:

| API | its hand-rolled shape |
| --- | --- |
| `TcpListener.accept` | `Impl(Future(TcpStream, IoExn))`, called in the caller's own loop |
| `Watcher.next` (`std/fs/watch.yo`) | `fn(self, io) -> Impl(Future(Option(FsEvent), Io))` — `.None` means closed |
| `Channel.recv` (`std/async/channel.yo`) | a future plus a separate `try_recv -> Result(T, TryRecvError)` |
| `BufReader.lines` (`std/io/bufio.yo`) | synchronous only; the async form does not exist |

Four spellings of one concept, none composable: there is no `map`, no `filter`,
no `take`, no `for`-equivalent over any of them, and no way to write a function
generic over *"something that yields values asynchronously"*.

`plans/STD_API_STABILIZATION.md` records the consequence at the point where it
bites:

> **`TcpListener.incoming` is deferred, and this is why.** Rust's `incoming()`
> is a BLOCKING iterator of `io::Result<TcpStream>`. Yo's `accept` is
> `Impl(Future(TcpStream, IoExn))`, and there is no `Stream` trait — no async
> analogue of `Iterator` — for an iterator of futures to implement.

## Design

```rust
Stream :: trait(
  Item : Type,
  /// Yield the next item, or `.None` once the stream is finished.
  next : (fn(self : Self, io : Io) -> Impl(Future(Option(Self.Item), IoExn)))
);
```

This is the shape `Watcher.next` already has, generalised — which is the
strongest evidence it is the right one: the API that needed it first arrived
at it independently.

Two decisions the shape encodes:

- **`Option(Item)`, not a separate "done" signal.** `.None` is terminal. A
  stream that can fail yields `Item = Result(T, E)`, exactly as Rust's
  `TcpListener::incoming` yields `io::Result<TcpStream>` — the failure is in
  the item, so a single failed accept does not end the stream.
- **`self : Self`, not `inout(self)`.** `Iterator` uses `inout(self)` because
  it is synchronous; a stream's `next` returns a future that outlives the
  call, and an `inout` borrow cannot be held across it. Every std stream
  source is already a `ref` type, so field writes work through the handle
  (this is the same reason `File.close` takes `self : Self`).

### Combinators

Written once over `where(S <: Stream)`, mirroring the `Iterator` combinators
the tree already has: `map`, `filter`, `filter_map`, `take`, `skip`,
`for_each`, `collect`. Each is a `ref` struct wrapping the upstream stream
plus its closure, with a `Stream` impl of its own — the same construction
`std/iter` uses, and subject to the same known trap:
[[yo-varbound-receiver-cell-recovery]] (a var-bound combinator receiver needs
the SomeT resolution-cell channel; `flat_map`'s doubly-derived item type is
still broken there, so `flat_map` should be LAST).

### A `for`-equivalent

`for(iter, body)` desugars to `next()` + `match` in a loop. The async form
needs the loop body to `io.await` each `next()`, which means it must expand
inside an `io.async` body. Two options:

1. **`for_await(stream, io, body)` macro** — expands to the same
   `while`/`match` with `io.await` around `next()`. Additive, no parser
   change, and it reads acceptably.
2. **Make `for` polymorphic over `Iterator`/`Stream`** — nicer at the call
   site, but the macro must decide which expansion to emit from the
   scrutinee's traits, and a macro expanding differently by type is a new
   capability.

Recommend (1) first; (2) only if the spelling proves to matter.

## What it unblocks

- `TcpListener.incoming() -> Impl(Stream(Item := Result(TcpStream, IoError)))`
  — the deferred row, closed.
- `Watcher` implements `Stream` instead of hand-rolling `next` (its current
  `next` becomes the trait method; no signature change).
- `Channel(T)` implements `Stream`, so a consumer loop is a combinator chain
  rather than a `recv`/`try_recv` dance.
- `BufReader.lines` gains an async form for free.
- Any user API that yields asynchronously stops having to invent a shape.

## Implementation sketch

Nothing in the compiler. This is a `std/` change — the trait plus impls plus
combinators — because associated types, `Impl(...)` wrappers and futures all
already work. Verified 2026-09-10 with a probe: an associated type in a return
position, supplied per-type and consumed from a blanket impl, compiles and
runs.

The one compiler-adjacent risk is the async state machine's treatment of an
`io.await` inside a combinator's `next` body — the shapes recorded in
[[yo-async-cond-shared-await-point-fixed]] and
[[yo-blocking-await-inside-a-task-deadlocks]]. Each combinator needs a test
that AWAITS it from inside a spawned task, not only from `main`, because a
blocking await inside a task nests the event loop.

## Order of work

1. The trait, in `std/async/stream.yo`, with `Watcher` as the first
   implementor (it already has the shape, so this is a rename that proves the
   trait fits a real type).
2. `TcpListener.incoming` — the row this exists for.
3. `map`/`filter`/`take`/`for_each`, each with a spawned-task test.
4. `for_await`.
5. `Channel(T)` and `BufReader.lines`.
