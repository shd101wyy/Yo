# One malformed request killed `HttpServer.serve`

**Status: FIXED** (2026-09-06, `std/http/wire.yo`, `std/http/server.yo`,
`std/http/http.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 18.

## Symptom

`serve_once` read the request through `read_http_message`, which THROWS
`HttpError.ResponseTooLarge` / `MalformedContentLength` / `MalformedChunkedBody`
through the server's `IoExn`. `serve` is a loop of `serve_once` under that same
exception, so a single client sending `Content-Length: abc`, a broken chunk,
or a body over `max_request_bytes` ended the server — for every other client.
Only a request that FRAMED correctly but failed `parse_request` got the
intended `400`.

There was also no `## Stability` marker on the module, which by the plan's
convention froze the one-connection-at-a-time shape.

## Why not catch it

Yo has no try/catch; the only recovery primitive is `unwind` from an
`Exception` handler, and a handler installed INSIDE an `io.async` body does
not resolve the future with the unwound value — it aborts the task, and the
program then exits 0 in silence
(`issues/unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`).
So the fix is D13's shape instead: the pure decoder returns `Result`, the
effect form wraps it.

## Fix

- `read_http_message(...) -> Impl(Future(Result(String, HttpError), IoExn))`:
  the three framing defects come back as `.Err`; I/O failures on the stream
  still throw. The client's two call sites (`std/http/client.yo`) throw the
  `.Err` themselves. (A first cut kept a throwing wrapper around a
  `_result` core; a GENERIC async wrapper awaiting a GENERIC async core from
  inside its own `io.async` body left the core's body "never fully evaluated"
  at codegen — an abstract specialization minted during the wrapper's
  def-eval — so the wrapper went. The body also carries no mid-loop `return`:
  the defect is recorded in a local and ends the read loop.)
- `serve_once` consumes the `Result`: `.Err(ResponseTooLarge)` → `413 Payload
  Too Large` (added to `http_status_text`), any other framing error → `400`
  with the reason, then the connection is closed and `serve` takes the next
  one. A parse failure still gets its `400`.
- `## Stability: unstable` on the module, naming what is expected to change
  (the one-request-per-connection shape) and what is not (the method names).

## Remaining gap

An I/O failure on the accepted socket (peer reset mid-read) still propagates
out of `serve`. Recovering from that needs the catch primitive above.

## Regression tests

`tests/http/server.test.yo` — a request with `Content-Length: abc` gets `400`
naming the header and the NEXT request is served; a request over a 64-byte
ceiling gets `413` and the next request is served. Both were process-ending
throws before.
