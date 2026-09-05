# `textDocument/definition` builds its `file://` URI by concatenation, so a `#`, space or `%` in the path yields a URI that resolves elsewhere

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: wrong-value** (go-to-definition navigates to a path the
user does not have, or silently does nothing). Reproduced at runtime against
`yo lsp` from v0.2.24.

The LSP server percent-**decodes** incoming document URIs and never
percent-**encodes** the ones it emits. The decode side even says why it is
needed:

```rust
// src/lsp/server.yo:69-71
/// file:// URI → filesystem path: strip the scheme and percent-decode
/// (editors escape spaces and non-ASCII in document URIs).
uri_to_fs_path :: (fn(uri : String) -> String)({
```

while the encode side is a bare concatenation:

```rust
// src/lsp/definition.yo:26-33
/// A token's module_path as an LSP file:// uri. Module paths arrive either
/// as `file:///abs` (import-resolved) or plain `/abs`.
_module_path_to_uri :: (fn(mp : String) -> String)(
  cond(
    mp.starts_with(String.from("file://")) => mp,
    true => `file://${mp}`
  )
);
```

## Reproducer

Drive `yo lsp` over stdio (`drive.py`) — the document text is supplied in
`didOpen`, so the path need not exist:

```python
import json, subprocess, sys
uri = sys.argv[1]
text = "{ println } :: import(\"std/fmt\");\nmain :: (fn() -> unit)({\n  greeting := `hello`;\n  println(greeting);\n});\nexport(main);\n"
p = subprocess.Popen(["yo","lsp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def send(o):
    b = json.dumps(o).encode()
    p.stdin.write(b"Content-Length: %d\r\n\r\n" % len(b) + b); p.stdin.flush()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":None,"rootUri":None,"capabilities":{}}})
send({"jsonrpc":"2.0","method":"initialized","params":{}})
send({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"yo","version":1,"text":text}}})
send({"jsonrpc":"2.0","id":2,"method":"textDocument/definition","params":{"textDocument":{"uri":uri},"position":{"line":3,"character":12}}})
send({"jsonrpc":"2.0","id":3,"method":"shutdown","params":{}})
send({"jsonrpc":"2.0","method":"exit","params":{}})
out, _ = p.communicate(timeout=300)
for chunk in out.decode().split("Content-Length: "):
    if '"id":2' in chunk: print(chunk.strip())
```

Symptom 1 — a workspace folder named `w s#1`, whose correct URI is
`file:///virtual/w%20s%231/t.yo`:

```
$ python3 drive.py "file:///virtual/w%20s%231/t.yo"
145

{"jsonrpc":"2.0","id":2,"result":{"uri":"file:///virtual/w s#1/t.yo","range":{"start":{"line":2,"character":2},"end":{"line":2,"character":10}}}}
```

The returned `uri` carries a raw space and a raw `#`. Per RFC 3986 §3.5 the
`#` starts the fragment, so a conformant client splits it as:

```
$ python3 -c "from urllib.parse import urlsplit; r=urlsplit('file:///virtual/w s#1/t.yo'); print(r.path, '|', r.fragment)"
/virtual/w s | 1/t.yo
```

— it navigates to `/virtual/w s`, a path that does not exist, and
go-to-definition does nothing.

Symptom 2 — a folder whose name literally contains `%20` (correct URI
`file:///virtual/a%2520b/t.yo`):

```
$ python3 drive.py "file:///virtual/a%2520b/t.yo"
145

{"jsonrpc":"2.0","id":2,"result":{"uri":"file:///virtual/a%20b/t.yo","range":{"start":{"line":2,"character":2},"end":{"line":2,"character":10}}}}
```

The server decoded `a%2520b` to the path `a%20b` correctly, then emitted it
unencoded, and the client decodes that back to `a b` — the round trip
`encode(decode(uri)) == uri` fails. Expected in both cases: the response `uri`
is the input `uri`.

## Root cause

`src/lsp/definition.yo:28` is the exact inverse of `src/lsp/server.yo:71`, but
only implements half of it. `uri_to_fs_path` strips `file://` **and**
percent-decodes (`src/lsp/server.yo:60-112`, with its own `_hex_val` at :60);
`_module_path_to_uri` only prepends `file://`. Every path byte outside the
RFC 3986 `pchar` set — space, `#`, `?`, `%`, and every non-ASCII byte — is
emitted raw.

The value being wrapped is `def_tok.module_path` (`src/lsp/definition.yo:102`),
which for an open document is `uri_to_fs_path`'s decoded output, so the
asymmetry is a straight round-trip loss.

The tree hand-rolls `file://` handling in four places —
`src/lsp/server.yo:71`, `src/lsp/definition.yo:28`, `src/expr_info.yo:876`
(`_mg_canon`) and `src/evaluator/memory_safety.yo:143` (`_lex_abs_path`) — and
only the first does any percent handling at all. `std/encoding/percent.yo`
exists (`percent_encode` at :45, `percent_decode` at :108) and is imported by
nothing but its own test — `grep -rn "encoding/percent" std src tests
--include='*.yo'` finds only `tests/encoding/percent.test.yo:6`.

## Fix

Add component encoders to `std/encoding/percent.yo` and use one of them here.
`percent_encode` (`std/encoding/percent.yo:45`) keeps only the unreserved set,
so applying it to a whole path would escape the `/` separators too; what is
needed is a per-segment encoder:

- `encode_path_segment` — keeps `pchar` minus `/`: unreserved, sub-delims,
  `:` and `@`;
- and, while the module is open, `encode_query_component`, `encode_fragment`,
  `encode_userinfo` for the sibling call sites.

Then rewrite `_module_path_to_uri` (`src/lsp/definition.yo:28-33`) to split
the path on `/`, encode each segment, and rejoin — leaving an input that
already starts with `file://` alone, as it does today (those come from the
loader and are already URIs).

Preferred longer-term shape: build the URI from a `Url` value once
`std/url` grows a builder, so the compiler stops carrying four private
`file://` handlers. That is the same `std/url`/`std/encoding/percent` wiring
the `url` audit row calls for; this defect is one of its consumers.

## Regression test

A new `tests/cli-cases/lsp-definition-encoded-uri` case, modelled on the
existing `tests/cli-cases/lsp-completion` case (a `cmd` of `lsp`, a scripted
`stdin`, and a golden `expected_stdout`): `didOpen` a document at
`file:///virtual/w%20s%231/t.yo`, request `textDocument/definition`, and pin a
golden whose `uri` is byte-identical to the URI that was opened. Recording the
golden requires `scripts/cli-diff-test.sh --record`, and fixture files must be
`yo fmt`-clean before recording (the CI fmt gate scans
`tests/cli-cases/`).

## Breaking change

No — the change only affects URIs the server emits, and the emitted form
becomes the conformant one. The `lsp-completion` / `lsp-handshake` goldens use
`file:///virtual/comp.yo`, which encodes to itself, so they are unaffected.
