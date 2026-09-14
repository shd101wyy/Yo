# `read_http_message` never truncates a body to its `Content-Length` — bytes after the frame are handed on AS body

**Status: FIXED** (`std/http/wire.yo`, this branch).

**Severity: correctness / smuggling.** A framed HTTP message ends where its
framing says it ends. `read_http_message` **stopped reading** at that boundary
but **returned the whole receive buffer**, so anything the peer had already sent
after the body became part of the body — on both the client side (response
smuggling) and the server side (request smuggling), RFC 9112 §11.2.

## How it surfaced — and why it hid for so long

It failed **one** CI leg (`test (macos-26-intel)`) of PR #434, while the other
five — including both Windows legs and the other two macOS/Linux legs — passed
on the same commit. That asymmetry is the whole story: whether the bug is
observable depends on whether two of the peer's writes **coalesce into a single
`read`**, which is a platform TCP decision, not a program one.

The failing test was `tests/http/http.test.yo`'s
`only a real Content-Length field line frames a kept-alive response`, whose
server writes the response and then a `TRAILING-MUST-NOT-BE-READ` marker as two
separate `write_string` calls. On five platforms those arrived as two reads and
the loop returned after the first; on macos-26-intel they arrived as one.

It was **not** caused by #434 — #434 only happened to be the PR whose runner
coalesced. The defect is as old as the framing loop.

## Reproducer

Deterministic anywhere, by making the server write once:

```rust
_serve_one_write :: (fn(listener : TcpListener, payload : String, io : Io) -> Impl(Future(unit, IoExn)))(
  io.async(e => {
    s := e.io.await(listener.accept(e.io), e);
    _req := e.io.await(_read_request(s, e.io), e);
    _w := e.io.await(s.write_string(payload, e.io), e);
    e.io.await(s.close(e.io), e);
    return(());
  })
);
// payload: `HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloTRAILING-MUST-NOT-BE-READ`
```

```
body      = "helloTRAILING-MUST-NOT-BE-READ"
body len  = 30   want 5
```

## Root cause

`std/http/wire.yo`, `read_http_message`. The read loop is correct — it stops the
moment the frame is satisfied:

```rust
.Length(cl) => {
  body_len := (result.len() - body_start);
  cond((body_len >= cl) => { done = true; }, true => ());
},
```

but the value it hands back is the entire buffer:

```rust
true => String.from_bytes(result)
```

`body_len >= cl` — not `==`. One read can overshoot the frame by any amount, and
every overshot byte was returned. `parse_response` / `parse_request` then take
the body **verbatim** (`std/http/http.yo:310` says so explicitly, and correctly:
framing is `read_http_message`'s job), so the overshoot lands in
`HttpResponse.body` / `HttpRequest.body`.

Both framing rules were affected:

| framing | before | after |
| --- | --- | --- |
| `Content-Length: N` | body = every byte read past the headers | body = exactly N bytes |
| absent, `is_request` | body = every byte read past the headers | body = empty (request ends at its headers) |
| absent, response | delimited by close — every byte read is body | unchanged |
| chunked | `dechunk` already returns exactly the decoded data | unchanged |

The chunked path was never affected because `dechunk` rebuilds the buffer from
the decoded chunks rather than slicing the raw one — which is why only the
`Content-Length` and body-less-request paths needed fixing.

## Fix

Truncate to the frame boundary before returning (`_message_upto`). The bound is
computed as `cl < avail` rather than `(body_start + cl) < result.len()` so a
hostile `Content-Length` cannot overflow `usize` into a false "no truncation
needed".

## Regression tests

Both write the framed message and the bytes after it in **one** `write_string`,
so they do not depend on coalescing and fail on every platform without the fix
(verified red-first):

- `tests/http/http.test.yo` — *bytes after a Content-Length body are not part of
  the body*: the trailing bytes are a whole second HTTP response, so a failure
  reads as the smuggling it is.
- `tests/http/server.test.yo` — *bytes pipelined after a body-less request are
  not its body*: a second request pipelined into the same write must not reach
  the handler.

## Lesson

A test whose oracle depends on **how the peer's bytes were segmented** is a test
that will pass on five platforms and fail on the sixth. The two pre-existing
keep-alive tests were written with two `write_string` calls precisely to model
"trailing bytes on a kept-alive connection", and that shape made them
*probabilistic*. Writing the whole payload in one call makes the same assertion
deterministic — and strictly stronger, since coalesced delivery is the harder
case.
