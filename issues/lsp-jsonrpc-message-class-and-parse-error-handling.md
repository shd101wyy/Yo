# The server answers client RESPONSES with MethodNotFound and swallows unparseable bodies silently

**Severity:** S3 — two JSON-RPC message-class violations found 2026-09-30 by
the closeout review of the 2026-09-29 audit's lifecycle fix (which landed as
`issues/fixed/lsp-jsonrpc-lifecycle-and-dollar-requests.md`), plus one
arm-ordering divergence from the LSP lifecycle rules.

## Reproduction

Drive `yo lsp` with:

1. `{"jsonrpc":"2.0","id":41,"result":{}}` — a RESPONSE (id, no method; the
   reply to a server→client request). The dispatch has no arm for a missing
   method, so it falls into the unknown-method catch-all and the server
   WRITES an error response `{"id":41,"error":{"code":-32601,...}}` — a reply
   to a reply, under the client's own id. Harmless today only because the
   server never issues requests; the first server→client request (progress,
   showMessageRequest, registration) would make every client's answer trip
   it.
2. A frame whose body is not JSON (`Content-Length: 5` + `{oops`). The
   handler logs to stderr and unwinds — JSON-RPC 2.0 requires a `-32700`
   ParseError response with `id: null`; a strict client that sent a request
   with a corrupt body waits forever.
3. A `$/` REQUEST before `initialize` (or after `shutdown`): the `$/` arm sat
   BEFORE the lifecycle-state arms, so it answered `-32601` where the
   lifecycle rules prescribe `-32002` / `-32600` — the connection-phase
   violation is the earlier error, whatever the method name.

## Root cause

The dispatch's cond arms were ordered `initialize` / `exit` / `$/` /
lifecycle-states / methods, with no arm for the no-method message class, and
the parse-failure path predates the JSON-RPC conformance pass.

## Fix

- A `method == ""` arm (id and no id alike — a response, or a malformed
  no-method notification) now ignores the message in every lifecycle state,
  placed before the state arms.
- The parse-failure handler answers
  `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,...}}` before
  unwinding.
- The `$/` arm moved BEHIND the lifecycle-state arms: pre-initialize
  requests answer `-32002`, post-shutdown requests `-32600`, and the
  feature-probing `-32601` applies to the initialized session (its purpose).

Pinned by the `lsp-lifecycle` cli-case (a `$/` request before initialize, a
malformed body, and a client response after shutdown are all in its stdin).
