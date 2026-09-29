# `yo lsp` JSON-RPC lifecycle deviations: pre-initialize and post-shutdown requests served, unknown `$/` requests never answered

**Severity:** S3 — three protocol-conformance deviations, none data-corrupting, but the third leaves a REQUEST permanently unanswered (a client may wait on it, and probing clients use `$` requests to feature-detect).

## Reproductions

All three from `plans/LSP_AUDIT_2026-09-29.md` probe session B against the
installed v0.2.45 binary:

1. `textDocument/hover` (id 1) sent BEFORE `initialize` → answered
   `{"result":null}`. The spec (3.17, "initialize"): requests before
   `initialize` (other than `initialize` itself) must be rejected with error
   code `-32002` (ServerNotInitialized).
2. After `shutdown`, `textDocument/hover` (id 4) → still answered
   `{"result":null}`. The spec ("shutdown"): after a shutdown request, only
   `exit` may be answered; other requests should get InvalidRequest
   (`-32600`).
3. `$/unknownProbe` (a REQUEST, id 2) → **no response ever**. The spec
   ("$/ Requests"): "If a server or client receives a request starting with
   `$/` it must error the request with error code MethodNotFound (e.g.
   -32601)." Unknown `$/` NOTIFICATIONS must stay ignored — the current
   `method.starts_with("$/")` arm in `_handle_message` (`src/lsp/server.yo`)
   drops both, and dropping the request half also means ANY future internal
   throw that reaches the outer skip handler strands a request the same way
   (JSON-RPC requires every request to be answered).

Related shape, same file: a second `initialize` is served (re-negotiates the
position encoding) instead of answering InvalidRequest; harmless in practice,
fix it in the same arms.

## Fix

One lifecycle state (`Uninitialized | Running | Shutdown`) threaded through
`_handle_message` (module-level like `g_shutdown_requested`), plus one `$`
arm split:

- before `initialize`: requests (id present, method ≠ `initialize`) →
  `-32002`; notifications → ignore.
- after `shutdown`: any request → `-32600`; `exit` → current behavior.
- `$`-prefixed: requests → `-32601`; notifications → ignore (unchanged).

## Test

Probe session B's three exchanges become a new `lsp-lifecycle` cli-case
(stdin + hand-authored golden); assert the error codes, not the messages.
