# `parse_request` / `parse_response` returned `Result(_, String)`

**Status: FIXED** (2026-09-06, `std/http/http.yo`, `std/http/server.yo`,
`std/http/client.yo`). The HTTP half of `plans/STD_API_STABILIZATION.md` §3
item 15 (the `env` half — `cwd` / `current_exe` / `chdir` — is still open).

## Symptom

Both decoders reported failure as a bare `String` — the one std shape a caller
can neither match on nor tell apart from any other string. The server
forwarded it as a `400` body, the client wrapped it in `HttpError.Other`, and
tests could only `contains(...)` substrings of prose.

## Fix

`HttpParseError :: enum(Empty, InvalidStatusLine(line), InvalidStatusCode(text),
InvalidRequestLine(line), UnknownMethod(name), UnsupportedVersion(version),
InvalidHeaderLine(line))`, each variant carrying the offending text, with
`ToString` rendering the same lines as before (`Unknown method: BREW`, …) and
`Error`. `parse_request` / `parse_response` return `Result(_, HttpParseError)`
(D13: pure decoders return `Result`). The server's `400` body is
`err.to_string()`; the client still throws `HttpError.Other(err.to_string())`,
so `fetch`'s error surface is unchanged.

## Regression tests

`tests/http/server.test.yo` — the parse-error cases now match on the variant
and its payload (`UnknownMethod("BREW")`, `UnsupportedVersion("HTTP/2")`,
`InvalidRequestLine`, `Empty`), plus a header line without a colon rendered
for a `400` body.
