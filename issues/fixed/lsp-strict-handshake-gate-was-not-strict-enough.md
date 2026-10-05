# The strict-handshake gate's parser was not strict enough for the job it was about to be given

**Severity:** S3 (polish). **Status:** FIXED in #1064 (the LSP audit closeout); filed under `issues/fixed/` 2026-10-05. Original severity line: polish — two holes in `scripts/lsp-strict-handshake.py`, found
2026-09-30 while wiring it into the release workflow's Windows legs (audit
§6.2) — a gate about to gate every release should not be passable by a
sloppy stream:

1. **Header-name matching stripped leading whitespace**
   (`name.strip().lower() == b"content-length"`): a stray byte run before a
   header line — an inter-frame `\n`, a doubled terminator — still parsed as
   `Content-Length` and the gate passed, while vscode-jsonrpc splits headers
   on `\r\n` and exact-matches the name, so a real client would reject the
   stream. Exactly the regression class the gate exists to catch.
2. **The first frame read was assumed to be the reply being awaited** — both
   for `initialize` and `shutdown`. Harmless while the server emits nothing
   before the reply, but the first `window/logMessage` or telemetry note
   would fail the gate with a misleading "initialize was not answered" on a
   healthy server.

Also: the per-read timeout was 120 s where the lsp cli-cases budget 240 s
for the same first-analysis (prelude evaluation) cost — a flake margin a
slow Windows runner could trip.

## Fix

Header names now match with NO leading-whitespace strip (only spaces/tabs
around the VALUE are tolerated, per the spec's spelling), `await_reply`
skips frames until the expected id arrives, and `TIMEOUT_S` matches the
cli-case budget (240 s). The same strictness class went into the
cli-case harness's `framing=strict` opt (raw-stream validation before any
normalization — see `check_strict_lsp_framing` in `scripts/cli-diff-test.sh`),
which fails on junk before a header and on declared-length/body mismatches.
