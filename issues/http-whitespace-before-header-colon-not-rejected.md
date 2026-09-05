# `Content-Length : 5` — whitespace before a field-line colon is ignored instead of rejecting the message

**Found**: 2026-09-05, while fixing
`issues/fixed/http-content-length-ows-and-invalid-values.md` (the OWS-after-the-colon
bug in the same scan). Open: closing it needs a message-level validity channel
that this parse fix deliberately did not invent.

## Symptom

RFC 9112 §5.1:

> No whitespace is allowed between the field name and colon. […] A server MUST
> reject, with a response status code of 400 (Bad Request), any received
> request message that contains whitespace between a header field name and
> colon.

`std/http/wire.yo`'s `_header_values` matches a field name only when the colon
follows it immediately — which is correct as a definition of "field line" — so
a header written `Content-Length : 5` is not matched at all and the framing
reads as `Absent`:

```rust
{ println } :: import("std/fmt");
{ find_header_end, find_content_length } :: import("std/http/wire.yo");
open(import("std/string"));

main :: (fn() -> unit)({
  raw := `HTTP/1.1 200 OK\r\nContent-Length : 5\r\n\r\nhello`;
  b := raw.as_bytes();
  println(
    match(
      find_content_length(b, find_header_end(b)),
      .Absent => `absent`,
      .Length(n) => `length ${n}`,
      .Invalid(msg) => `INVALID (${msg})`
    )
  );
});
export(main);
```

Observed:

```
absent
```

Expected: the message is rejected (400 from `HttpServer`, a typed throw from
the client), because a peer that treats `Content-Length :` as a header and a
peer that does not will disagree about where the body ends — the classic
request-smuggling split §5.1 exists to close.

## Why it is not urgent today

`std/http`'s server closes after one request per connection, so there is no
second request on the same connection for a disagreement to smuggle into, and
the client is the one framing responses it asked for. The hole is latent, not
live.

## Shape of the fix

The rule is message-level, not field-level: it applies to EVERY field name, so
it does not belong in a per-name lookup like `find_content_length`. The natural
home is a `header_section_is_valid(data, header_end)` check in `wire.yo` run
once when `find_header_end` first succeeds, throwing a typed error the server
turns into a 400 — which is the same plumbing
`issues/fixed/http-content-length-ows-and-invalid-values.md` notes is needed to
turn `MalformedChunkedBody` and `MalformedContentLength` into 400 responses
rather than dropped connections. Do the three together.
