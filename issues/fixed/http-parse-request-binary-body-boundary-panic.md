# `parse_request` panicked on a binary request body starting with a UTF-8 continuation byte

**Status: FIXED** (2026-08-29, `std/http/http.yo`). Found writing the
binary-bodies pin (plans/STD_API_AUDIT.md, http row).

`parse_request` sliced the body with the boundary-checked
`raw.substring(header_end + 4, raw.len())`; a body whose first byte is
`0x80..0xBF` (a UTF-8 continuation byte) is not a "character boundary", so the
server died "String.substring: start is not on a UTF-8 character boundary".
The body is now sliced as BYTES (`as_bytes` walk → `String.from_bytes`) —
bodies are byte-transparent end to end. The client side already was: its
response body is reassembled from byte buffers, and
`parse_response` splits/rejoins without offset slicing.

Pins: `tests/http/http.test.yo` "fetch round-trips a binary body
byte-for-byte" (NULs, lone continuation byte, 0xFF, embedded CRLFs) and
`tests/http/server.test.yo` "the server round-trips a binary request body
byte-for-byte".
