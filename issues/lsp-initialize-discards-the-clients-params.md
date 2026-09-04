# `yo lsp`'s `initialize` handler discards the client's `params`, so the server can negotiate nothing

**Status:** OPEN — found 2026-09-04 during the std-API-audit re-measurement of
the D4 PR 9 / LSP row. Reproduced at runtime against `yo 0.2.24`.
**Severity:** api-lie. The server answers `initialize` with a fixed capability
object it computed without ever looking at the request, and the object omits
`positionEncoding`, which per LSP 3.17 means "I use the default, utf-16" — a
claim this server does not honour
(`issues/lsp-emits-rune-columns-where-the-protocol-says-utf16.md`).

## Symptom

`_initialize_result` is the only handler in the server that cannot see its own
request. Its signature takes no arguments:

```rust
// src/lsp/server.yo:192
_initialize_result :: (fn() -> JsonValue)(
  jb().put("capabilities", jb().put("textDocumentSync", jnum(usize(1))). …
```

and the `initialize` branch calls it with none, never touching `v.get("params")`:

```rust
// src/lsp/server.yo:245-251
cond(
  (method == String.from("initialize")) => {
    match(
      id_opt,
      .Some(id) => write_lsp_message(json_stringify(j_response(id, _initialize_result()))),
      .None => ()
    );
  },
```

Observable consequence: send an `initialize` that explicitly offers both
encodings —

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{"general":{"positionEncodings":["utf-8","utf-16"]}}}}
```

— and the response is byte-for-byte identical to the one produced for
`"capabilities":{}`:

```json
{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"textDocumentSync":1,"hoverProvider":true,"definitionProvider":true,"documentSymbolProvider":true,"referencesProvider":true,"foldingRangeProvider":true,"renameProvider":true,"documentFormattingProvider":true,"signatureHelpProvider":{"triggerCharacters":["(",","]},"completionProvider":{"triggerCharacters":[".","\"","/"]}},"serverInfo":{"name":"yo-lsp"}}}
```

Both are the same 405 bytes that
`tests/cli-cases/lsp-handshake/expected_stdout` pins as its first frame. There
is no `positionEncoding` key, no branch on the client's offer, and no place in
the code where one could be added without changing the function's signature.

Expected: the server reads `params.capabilities`, decides what it will do, and
says so in its answer — at minimum an explicit `positionEncoding`.

## Root cause

The handler was written as a constant. `src/lsp/server.yo:192-200` builds one
chained `jb()` expression and returns it; `src/lsp/server.yo:249` calls it with
empty parentheses. Every *other* branch of `_handle_message` reads its params —
`src/lsp/server.yo:268, 328, 388, 414, 470, 496, 557, 583, 643, 698, 715, 753`
are all `v.get(String.from("params"))` — so `initialize` is the single
exception, and it is the one request whose entire purpose is exchanging
capabilities.

Two things follow from that, and they are why this is worth its own record
rather than a line in the UTF-16 issue:

1. **The omission is a positive assertion.** LSP 3.17 defines
   `ServerCapabilities.positionEncoding` as defaulting to `"utf-16"` when
   absent. A server that declares nothing is not silent; it is claiming utf-16.
   This one emits rune (UTF-32) columns.
2. **There is no seam to hang a fix on.** `general.positionEncodings` — and
   every other client capability, e.g. `dynamicRegistration` or
   `workDoneProgress` support — is unreachable *by construction*. Any
   negotiation work starts by threading `params` in, not by writing encoding
   math.

Note both existing LSP cli-cases send `"capabilities":{}`
(`tests/cli-cases/lsp-handshake/stdin` and
`tests/cli-cases/lsp-completion/stdin`, third frame), so the absent-
`general.positionEncodings` case is the one the goldens exercise, and any
implementation must handle it.

## Fix

1. Change the signature to `_initialize_result :: (fn(params : JsonValue) -> JsonValue)`
   (`src/lsp/server.yo:192`) and pass the request's params at
   `src/lsp/server.yo:249`, using the same
   `match(v.get(String.from("params")), .Some(p) => …, .None => JsonValue.Null)`
   shape every other branch already uses. Missing/`null` params must be
   tolerated — the recorded goldens depend on it.
2. Declare `positionEncoding` in the capability object at
   `src/lsp/server.yo:193`. Land the honest constant `"utf-16"` together with
   the conversion work in
   `issues/lsp-emits-rune-columns-where-the-protocol-says-utf16.md`; declaring
   `"utf-16"` while still emitting runes only makes the lie explicit.
3. *Optional, and only after (2).* Read
   `params.capabilities.general.positionEncodings` (a JSON array of strings),
   pick `"utf-8"` when the client offers it and `"utf-16"` otherwise, store the
   choice in the per-server state next to `st.text`, and have the position
   converters consult it. This is worth ~nothing for Yo's shipped client —
   `vscode-extension/node_modules/vscode-languageclient/lib/common/client.js:1370`
   hardcodes `generalCapabilities.positionEncodings = ['utf-16']` — so schedule
   it as a Neovim/Helix/Zed nicety, not as part of the correctness fix.

## Regression test

`tests/cli-cases/lsp-handshake/expected_stdout` must be re-recorded once
`positionEncoding` is declared (its initialize frame grows past 405 bytes) —
that alone pins the declaration.

For the params threading itself, add a third frame variant: a
`tests/cli-cases/lsp-position-negotiate` case whose `initialize` sends
`{"capabilities":{"general":{"positionEncodings":["utf-8"]}}}` and whose golden
shows the server's chosen `positionEncoding`. If step 3 is not implemented, the
same case still earns its keep as the proof that an explicit client offer no
longer produces a byte-identical, offer-blind response. Keep
`tests/cli-cases/lsp-handshake` as the empty-`capabilities` control so the
default path stays covered.
