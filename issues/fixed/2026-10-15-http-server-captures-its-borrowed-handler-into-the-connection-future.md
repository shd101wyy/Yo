# std/http's server captures its borrowed handler into the connection future

**Severity:** S2 — `HttpServer.serve` and `serve_once` rejected every handler closure that captures a value that is not `Copy`, so `tests/http/server.test.yo` (13) and `tests/http/http_limits.test.yo` (6) failed to compile on develop.

**Found:** 2026-10-15, develop battery run 38604999635 at `be5855a4a`.
**Status:** FIXED 2026-10-15.

## Symptom

```text
error[E0901]: use of moved value: the closure captures `handler`, whose type `Impl(Fn(HttpRequest) -> HttpResponse)` is move-only (it is neither `Copy` nor `Clone`), so the capture moves it, and `handler` cannot be moved: it is borrowed (a by-value parameter, a `match`/`for` binding, a `&mut` borrow or a module-level binding). Take it `sink(...)` to own it.
note: raised here, inside the standard library
   --> std/http/server.yo:79:16
```

The test closures capture an `ArrayList` (`Clone`, not `Copy`) or the
`HttpServer` handle (neither), for example
`server.serve(req => { server.stop(); … }, io)`.

## Root cause

- `serve_once` and `serve` took `handler : &Impl(Fn(req : &HttpRequest) -> HttpResponse)`
  and returned `io.async(e => { … handler(&req) … })`. The future captured
  `handler` by value.
- That capture copied the closure. #1366 (decision 36) made a closure `Copy`
  exactly when every by-value capture is. A handler capturing a value that is
  not `Copy` cannot be copied out of a borrow, so the capture is a move, and a
  `&` parameter cannot be moved. The checker is right.
- Borrowing the handler instead (`io.async({ self, &handler }(e : IoExn) => …)`)
  type-checks for a returned future, but that future is second-class.
  Every test spawns it (`io.spawn(server.serve(…), …)`), and the spawn is E0909.
  A server that serves in the background has to own its handler, as Rust's
  servers take theirs by value.

## Fix

- `serve_once` and `serve` take `sink(handler) : Impl(Fn(req : &HttpRequest) -> HttpResponse)`.
  The future owns the handler, so it can be spawned. A closure argument moves
  its captures into it (decision 22). A reference-type capture such as the
  `HttpServer` handle is shared, so the caller can still use it.
- `serve` no longer calls `serve_once` once per connection, which would need a
  fresh owned handler each time. Both call two private helpers and call the
  handler themselves:
  - `_accept_request` accepts a connection and reads one request. It yields
    the stream and either the request or the `400`/`413` response.
  - `_respond` adds `Connection: close`, writes the response and closes the
    stream.

The observable behavior is unchanged, including the malformed-request
handling of `issues/fixed/one-malformed-request-killed-http-server-serve.md`.

## Verification

`tests/http/server.test.yo` (13 tests) and `tests/http/http_limits.test.yo`
(6 tests) fail to compile before the fix and pass after. They pass with the
tree-built compiler and with seed v0.2.62 over the tree's std.
