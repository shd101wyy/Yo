# `yo lsp` emits `\r\r\n` framing on Windows — no LSP client can complete the handshake

**Severity:** S1 — the language server is non-functional on a first-class release target (windows-x64, windows-arm64): every conforming client hangs on `initialize` forever; found 2026-09-29 by the `plans/archive/LSP_AUDIT_2026-09-29.md` probes.

## Reproduction

Any Windows `yo` binary (verified: installed v0.2.45; the framing code is
unchanged since the Yo port landed in #208). Send one framed `initialize`
request over stdin and read raw bytes:

```
$ printf 'Content-Length: 66\r\n\r\n{...initialize...}' | yo lsp | head -c 60
Content-Length: 459\r\r\n\r\r\n{"jsonrpc":"2.0","id":1,...
```

The base protocol terminates the header block with exactly `\r\n\r\n`; the
server emits `\r\r\n\r\r\n` — every `\n` in the printed header was translated
to `\r\n` on top of the explicit `\r`.

## Why the client hangs (not merely warns)

vscode-jsonrpc's `MessageBuffer.tryReadHeaders` scans for the byte sequence
CR LF CR LF with a state machine (0 →CR→ 1 →LF→ 2 →CR→ 3 →LF→ done). On the
byte run `…459 \r \r \n \r \r \n {…}` the second `\r` resets the state (CR in
state 1 falls to `default: state = 0`), so the machine never terminates the
header section, `tryReadHeaders` keeps returning `undefined`, and no message
is ever delivered: the client's `initialize` future never resolves. A
conformant Python driver receives zero bytes of reply; a readline-based
tolerant parser (what the memory-plateau driver uses) is the only thing that
can talk to it.

Verified against `vscode-languageserver-node` `jsonrpc/src/common/messageBuffer.ts`
(2026-09-29, `main`). The VS Code extension (`vscode-extension/extension.js`)
uses vscode-languageclient → this exact reader, so **the shipped extension
cannot use the language server on Windows at all**; Neovim's built-in client
is no more tolerant of a missing `\r\n\r\n`.

## Root cause

`write_lsp_message` (`src/lsp/transport.yo`) writes the header through libc
stdio `print` and the MSVC CRT opens stdout in **text mode** by default (LF →
CRLF translation). Nothing in the server calls `_setmode(fileno(stdout),
_O_BINARY)`. Input is unaffected: reads go through `BufReader(Stdin)` → the
async runtime's raw `read` syscall path (`std/io/stdio.yo`), which does not
translate.

Broken since the Yo-language server landed (#208, P4_LSP slices) — invisible
because (1) no CI leg drives a Windows `yo lsp` over a pipe (`test.yml` is
Linux-only; the release workflow's Windows legs smoke-test compilation and
bundle properties, never an LSP session), (2) the `lsp-*` cli-case goldens
were recorded on Linux/macOS, and `refit_lsp_frames` in
`scripts/cli-diff-test.sh` would only notice on Windows, where the battery is
not run, (3) every human interop test happened on macOS/Linux.

## Fix

Put stdout in binary mode once, at server startup, on Windows — the same
windows-helper shape `src/main.yo` already uses for `GlobalMemoryStatusEx`:

```rust
_setmode(_fileno(stdout), _O_BINARY);
```

via a function-local `{ _setmode, _fileno } :: c_include("<io.h>", …)`.
`ordered_c_includes` (`src/codegen/c/collection.yo`) already hoists
`<windows.h>` first and drops `<io.h>` from non-Windows targets, so Linux and
macOS output is byte-identical (no golden churn). Also fix stderr the same way
or leave it — stderr carries only debug lines; leave it.

## Regression test

A strict-framing handshake script (spawn, `initialize`, `didOpen`,
`shutdown`, `exit`; assert every outgoing frame is exactly
`Content-Length: N\r\n\r\n` + N body bytes using a conforming parser). It
fails before the fix on Windows and passes after; on Linux it passes before
and after, so it can gate every platform once wired into the release
workflow's existing Windows smoke steps. The lsp cli-cases cannot be this
gate: the harness refits `Content-Length` and tolerates `\r?\n\r?\n`
delimiters by design (`plans/archive/LSP_AUDIT_2026-09-29.md` §6).

## Fix

Landed with the audit stack in #1020 (2026-09-30): `prepare_wire`
(`src/lsp/transport.yo`) flips Windows stdout to binary mode
(`_setmode(_fileno(stdout), _O_BINARY)`) as the first statement of
`run_lsp_server`, behind a comptime platform cond so non-Windows C is
untouched — the Linux cross-emit contains no `_setmode`, and the lsp
cli-case goldens were byte-identical after. Verified on the installed
v0.2.45 (gate FAILS) and the fixed Windows build (PASSES).

The regression gate this doc asked for is wired: the release workflow's
Windows bundle legs run `scripts/lsp-strict-handshake.py` against the
shipped `bin/yo.exe` (a full initialize/didOpen/publishDiagnostics/
shutdown/exit session through a strict `\r\n\r\n` + exact-Content-Length
parser), and the lsp cli-cases now assert `framing=strict` on their raw
streams in every battery, so the Linux/macOS framing bytes are pinned
byte-exactly too.
