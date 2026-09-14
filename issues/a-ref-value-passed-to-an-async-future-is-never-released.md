# A `ref` value passed as a parameter to an `io.async` future is never released

**Status: OPEN.** Found 2026-09-11 while building `std/http`'s connection pool
(`HttpClient`), whose `Dispose` this defect makes unreachable.

## Symptom

A `ref(struct(...))` value handed to a function whose body is an `io.async`
future is dup'd into the future's capture record and never dropped. Its
reference count therefore never reaches zero, so its `Dispose` never runs and
the object leaks — one leaked object per call, unbounded.

The identical parameter on a plain `fn` is released correctly, which is what
localizes this to the async lowering.

## Reproducer

`issues/repros/ref-param-to-async-future-never-released.yo`:

```
plain fn:  created=50 disposed=50
io.async:  created=50 disposed=0
```

Both loops create 50 `Thing`s in a scope that ends each iteration; the second
passes each one to an `io.async` future and awaits it. Fifty objects leak, and
they are still leaked after the enclosing function returns — this is not a
drop deferred to the end of the frame.

It reproduces for `self` too (`t.method(io)` where `method`'s body is an
`io.async`), and it does not need a suspension point: the future in the
reproducer completes synchronously.

## Why it matters

Every reference-semantics value that reaches async code is affected, which in
`std/` is most of them:

- `TcpStream` / `TlsStream` passed to the framing read
  (`std/http/wire.yo`'s `read_http_message_buffered`), to `_flush_wbio` and to
  `_feed_rbio`. Their `Dispose`s can never fire on a drop, so "the descriptor
  is closed when the stream goes out of scope" — the contract `TcpStream`'s
  `Dispose` exists to provide — does not hold in practice for any stream that
  has been read from or written to.
- `HttpClient` (`std/http/client.yo`): the pool's `Dispose` closes every idle
  connection, and a client that has made a single request never reaches count
  zero, so the idle set is only released through the explicit `close_idle()`.
  That is why `tests/http/http.test.yo`'s "dispose closes every idle
  connection" calls `dispose` by hand: the body under test is the right one,
  but the drop that should invoke it cannot fire.

## Where to look

The capture record is built in the future-construction stub emitted next to
each `io.async` body (`__capture_closure_*` in the generated C), which dups
every captured `ref`:

```c
__yo_t63 __capture_closure_yo_id_18364_0 =
  (__yo_t63){ .size = size, .self = ((__yo_t17*)__yo_incr_rc((void*)(self))), ... };
```

and the state machine has a `_state_dispose` function. Either that dispose does
not drop the capture record's `ref` fields, or it is not called on the
completed future's release. `src/codegen/async/` and the state-machine
dispose emitter are the places to start.
