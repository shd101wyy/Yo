# `Content-Length:5` framed as "no body" — the header scan skipped one byte too many, and every unreadable value became `-1`

**Found**: 2026-09-05, auditing `std/http/wire.yo`'s field-value parsing.
**Fixed**: same day — the header section is walked as field LINES per RFC 9112
§5, the OWS after the colon is optional and any run of SP/HTAB, and a
`Content-Length` that is not `1*DIGIT` is a typed error instead of a silent
absence. Pinned by five tests in `tests/http/server.test.yo` and
`tests/http/http.test.yo`, all verified RED first.

## Symptom

`find_content_length` located the header with `index_of("content-length:")`
and then jumped `pos + 16` bytes: 15 for `content-length:` plus **one more for
a space that RFC 9112 §5 makes optional**. So a header written without that
space lost its value's first byte — and a single-digit value lost everything:

```rust
// tmp/fixme.yo — probe the shared wire helpers directly
{ println } :: import("std/fmt");
{ find_header_end, find_content_length, is_chunked } :: import("std/http/wire.yo");
open(import("std/string"));

probe :: (fn(raw : String) -> unit)({
  b := raw.as_bytes();
  he := find_header_end(b);
  println(`content_length=${find_content_length(b, he)} chunked=${is_chunked(b, he)}`);
});

main :: (fn() -> unit)({
  probe(`HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello`);        // canonical
  probe(`HTTP/1.1 200 OK\r\nContent-Length:5\r\n\r\nhello`);         // no OWS
  probe(`HTTP/1.1 200 OK\r\nContent-Length:15\r\n\r\nhello`);        // no OWS, two digits
  probe(`HTTP/1.1 200 OK\r\nContent-Length: -5\r\n\r\nhello`);       // negative
  probe(`HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\nhello`);      // garbage
  probe(`HTTP/1.1 200 OK\r\nX-Content-Length: 3\r\n\r\nhello`);      // a DIFFERENT field
  probe(`HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 9\r\n\r\nhello`);
});
export(main);
```

Observed, before the fix (`content_length` is the returned `i32`):

```
--- Content-Length: 5 (canonical) ---        content_length=5     chunked=false
--- Content-Length:5 (no OWS) ---            content_length=-1    chunked=false
--- Content-Length:15 (no OWS) ---           content_length=5     chunked=false
--- Content-Length: -5 ---                   content_length=-5    chunked=false
--- Content-Length: +5 ---                   content_length=5     chunked=false
--- Content-Length: abc ---                  content_length=-1    chunked=false
--- Content-Length: 99999999999999999999 --- content_length=-1    chunked=false
--- X-Content-Length: 3 only ---             content_length=3     chunked=false
--- two disagreeing Content-Lengths ---      content_length=5     chunked=false
```

Expected (and what it prints now):

```
--- Content-Length: 5 (canonical) ---        content_length=length 5
--- Content-Length:5 (no OWS) ---            content_length=length 5
--- Content-Length:15 (no OWS) ---           content_length=length 15
--- Content-Length: -5 ---                   content_length=INVALID ("-5" is not a non-negative integer)
--- Content-Length: +5 ---                   content_length=INVALID ("+5" is not a non-negative integer)
--- Content-Length: abc ---                  content_length=INVALID ("abc" is not a non-negative integer)
--- Content-Length: 99999999999999999999 --- content_length=INVALID ("99999999999999999999" is not a non-negative integer)
--- X-Content-Length: 3 only ---             content_length=absent
--- two disagreeing Content-Lengths ---      content_length=INVALID (repeated with different values (5 and 9))
```

Three distinct failures are in that table, and `-1` means "no such header" to
the only caller:

1. **`Content-Length:5` → `-1`.** A server drops the body of the POST; a
   client on a kept-alive connection never sees the message end at all.
2. **`Content-Length:12000` → `2000`** — worse, because it is silent. The read
   stops 10 000 bytes early and the handler is handed a truncated body.
3. **`X-Content-Length: 3` → `3`.** `index_of` matched a substring anywhere in
   the header block, so a *different* field supplied the framing. The sibling
   `is_chunked` shared that: `X-Transfer-Encoding: chunked` turned on chunked
   decoding for a body that is not chunked, and the request died with
   `HttpError.MalformedChunkedBody` instead of being served.

And every unreadable value — `-5`, `+5`, `abc`, an overflowing number, an empty
value, `5, 5`, two field lines that disagree — was silently read as "there is
no Content-Length here", which RFC 9112 §6.3 explicitly forbids: invalid
framing is an unrecoverable error, never a body-less message.

The client's own tests never caught any of it because they all send
`Connection: close`, and close-delimiting supplies the body that the broken
framing could not.

## Mechanism

`std/http/wire.yo`, before the fix:

- **`wire.yo:60`** — `val_start := (pos + usize(16));`. `content-length:` is
  15 bytes; the sixteenth is the OWS that RFC 9112 §5 spells
  `field-line = field-name ":" OWS field-value OWS`, where `OWS = *( SP / HTAB )`
  — zero or more. Skipping it unconditionally works only for the one-space
  spelling. (`Content-Length:  5`, `Content-Length:\t5` and a trailing-OWS
  value all survived by accident: the `.trim()` on `wire.yo:66` cleaned up
  whatever the jump left behind, as long as the jump landed *before* the
  digits.)
- **`wire.yo:58` / `wire.yo:99`** — `header_str.index_of("content-length:")`
  and `index_of("transfer-encoding:")` search the whole lower-cased header
  block for a substring. A field name is not a substring: RFC 9112 §5 says it
  starts a line and is followed immediately by the colon. Anything ending in
  the name (`X-Content-Length`, `X-Transfer-Encoding`) matched.
- **`wire.yo:68`** — `val_str.parse_i32()`. `parse_i32` accepts a leading `-`
  and `+`, and reports "not a number", "overflow" and "empty" as the same
  `.None`. Both the accepted junk and the collapsed rejections then funnelled
  into `.None => i32(-1)` (`wire.yo:70`), which the reader at `wire.yo:298`
  reads as `cl < 0` — the same state as "no header" — and for a REQUEST
  `wire.yo:308` ends the message right there, at the end of its headers.

## Fix

`std/http/wire.yo` now walks the header section as field LINES.

- `_header_values(data, header_end, name)` scans bytes, not a lower-cased copy
  of the block, and returns every value of one field: the name must START a
  line (the start-line is skipped, so a request target spelling
  `/transfer-encoding:chunked` is not a header), the colon must follow it
  immediately, the value's leading OWS is *any* run of SP/HTAB, and its
  trailing OWS is stripped. `find_content_length` and `is_chunked` are both
  layered on it, so the two lookups can no longer disagree about what a header
  is. It also allocates less than the code it replaces, which built a full copy
  of the header block plus a lower-cased `String` on every 8 KiB read — twice.
- `find_content_length` returns `ContentLength :: enum(Absent, Length(n : usize), Invalid(msg : String))`
  instead of an `i32` with a `-1` sentinel, so "no header" and "a header I
  could not read" are different answers. The value is parsed as RFC 9112 §6.2's
  `1*DIGIT` — no sign, no trailing junk, no comma list, and an overflow guard —
  and repeated field lines must all agree.
- `read_http_message` throws the new `HttpError.MalformedContentLength(msg)` on
  `.Invalid`, the way it already throws `MalformedChunkedBody` on broken chunk
  framing.

`is_chunked` still asks whether the LAST listed coding is `chunked`
(RFC 9112 §6.1); with more than one `Transfer-Encoding` field line the codings
concatenate in order, so it reads the last line's value.

**BREAKING**: `HttpError` has a new variant (`MalformedContentLength`), so an
exhaustive `match` over it needs a new arm; and `find_content_length`, exported
from the std-internal `std/http/wire.yo`, returns `ContentLength` rather than
`i32`. A response whose `Content-Length` is unreadable now throws instead of
being delivered with a close-delimited body.

## Tests

`tests/http/server.test.yo` (10 pass, was 8):

- `Content-Length framing: OWS after the colon is optional, and only a real
  field line counts` — six POSTs with a **12 000-byte** body (past the 8 KiB
  `read_http_message` reads at a time, so a mis-parse stops the read early and
  the handler sees a short body): `Content-Length:12000`, three spaces, a tab,
  trailing `SP HTAB SP`, an `X-Content-Length: 3` decoy ahead of the real
  header, and the canonical spelling. RED before the fix with
  `unexpected exception: connection reset by peer` — the server had finished on
  the mis-read length of 2000 and closed while the client was still writing.
- `only a real Transfer-Encoding field line turns on chunked decoding` — a
  request target spelling `transfer-encoding:chunked` (this one already
  passed: the ` HTTP/1.1` that follows a target defeated the old `ends_with`),
  and `X-Transfer-Encoding: chunked`, which did not. RED before the fix with
  `unexpected exception: Malformed chunked body: chunk size is not hex (byte
  122 at offset 0)` (122 is `z`, the first byte of the body).

`tests/http/http.test.yo` (24 pass, was 21) — the client half, on connections
the server holds OPEN, since every older test closes and close-delimiting hides
the defect:

- `a kept-alive response is framed by a Content-Length written without OWS` —
  RED with `a single-digit Content-Length with no space after the colon must
  end the message`.
- `only a real Content-Length field line frames a kept-alive response` —
  `X-Content-Length: 99` ahead of the real `Content-Length: 5`. RED with
  `X-Content-Length must not frame the message`.
- `an unreadable Content-Length is a typed HttpError, not a silent absence` —
  `abc`, `-5`, and two disagreeing field lines. RED with `"abc" is not a length
  and must throw (task unwound → None)`.

The multiple-space, tab and trailing-OWS cases passed before the fix too, so
they are a real baseline against over-rejection.

**Test-design note (this is what made the first attempts vacuous):** a
loopback framing test only goes RED when the body cannot arrive in ONE read.
`read_http_message` reads 8 KiB at a time and nothing truncates the buffer to
`Content-Length`, so for a small single-shot request the correct and the
broken framing produce byte-identical bodies. Either push the body past 8 KiB
(the server tests) or hold the connection open and give the client a deadline
(the client tests).

## Not fixed here

RFC 9112 §5.1 also forbids whitespace BETWEEN a field name and its colon, and
tells a server to answer 400 for a request that contains any. `Content-Length : 5`
is therefore not a field line, and this scan reports it as `Absent` rather than
rejecting the whole message — rejecting it needs a message-level validity
channel that applies to every field name, not just these two. Filed as
`issues/http-whitespace-before-header-colon-not-rejected.md`.

`HttpError.MalformedContentLength` escapes `HttpServer.serve_once` as a thrown
exception (the connection closes with no response), exactly as
`MalformedChunkedBody` already does. RFC 9112 §6.3 asks a server for a 400
instead. Turning both into a 400 is a server-policy change covering the two
framing errors together, not part of this parse fix.
