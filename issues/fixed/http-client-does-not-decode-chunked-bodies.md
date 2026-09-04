# `std/http` never decoded `Transfer-Encoding: chunked` — the body kept its hex chunk framing

**Status: FIXED 2026-08-29** (`std/http/client.yo`). **Found:** 2026-08-29 while
closing plans/STD_API_AUDIT.md §7 P1 "chunked/redirect/timeout client" —
redirects and the deadline had landed (C33), chunked never had. **Severity:**
HIGH for correctness — HTTP/1.1 servers chunk dynamic responses by default,
so `fetch` returned bodies like `7\r\nhello, \r\n8\r\nchunked \r\n0\r\n\r\n`
verbatim, and `Content-Length` was the only completion signal (a chunked
response was only ever read to completion because the client sends
`Connection: close`).

## Reproducer

`tests/http/http.test.yo` "fetch decodes a chunked body": a scripted loopback
server answers

```
HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n
7\r\nhello, \r\n8\r\nchunked \r\n32\r\nworld — …\r\n0\r\nX-Trailer: t\r\n\r\n
```

and `resp.body` must be `hello, chunked world — …`. Before the fix the body
was the raw framing.

## Fix

- `_is_chunked(data, header_end)` — case-insensitive header scan; the last
  listed transfer coding must be `chunked` (RFC 9112 §6.1).
- `_dechunk(body, body_start) -> _Dechunk` — RFC 9112 §7.1 framing:
  `hex-size[;ext]CRLF data CRLF` repeated, then the zero chunk, optional
  trailer fields and the final CRLF. Upper/lower-case hex, chunk extensions
  and trailers are all accepted and dropped. Returns `Done(data)`,
  `Incomplete` (well-formed prefix — the read loop keeps reading) or
  `Malformed(msg)` (never returned for a mere prefix; exhaustively checked
  over every prefix of the test body).
- `_read_http_response` ends the read at the terminating zero chunk instead
  of relying on the peer closing, and hands the response on with the body
  REPLACED by the decoded data (`headers CRLFCRLF data`), so
  `parse_response` and `HttpResponse.body` see the payload while the
  `Transfer-Encoding` header stays visible.
- New typed error `HttpError.MalformedChunkedBody(msg)` (additive) for a
  non-hex size, a missing CRLF after chunk data, or a connection that closes
  before the zero chunk — with the offset and the bytes seen.
- The stale `UnsupportedScheme` doc comment ("only http is supported") was
  corrected while here: https has spoken real TLS since D6 PR-2.

## Regression tests

`tests/http/http.test.yo`: "fetch decodes a chunked body (sizes, extensions
and trailers stripped)" (two responses: lower-case sizes + trailer; upper-case
size + chunk extension) and "a malformed chunk size is a typed HttpError, not
a garbage body". Both RED before the fix under the tree-built compiler (the
v0.2.19 seed miscompiles the file's await-in-cond `while` — the C38 class,
fixed in #345 — so `tests/` in this area need the stage-1 binary).
