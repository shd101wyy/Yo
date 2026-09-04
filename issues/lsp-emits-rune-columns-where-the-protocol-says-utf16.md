# `yo lsp` emits and accepts RUNE columns where LSP specifies UTF-16 — `textDocument/rename` rewrites the wrong span

**Status:** OPEN — found 2026-09-04 during the std-API-audit re-measurement of
the D4 PR 9 / LSP row. Reproduced at runtime against `yo 0.2.24`.
**Severity:** wrong-value, and **destructive** on the rename path: the client
applies the returned `TextEdit` to a span the server did not mean, silently
corrupting the user's buffer. Everything else on the list mis-highlights or
mis-navigates.

**Scope — read this before re-filing it wider.** This is *not* "every non-ASCII
line is wrong". `src/lsp/` serves **rune (UTF-32) columns**
(`src/token.yo:37-43`, `src/diagnostics.yo:86-87` both document the basis), and
one rune is exactly one UTF-16 code unit across the whole Basic Multilingual
Plane. CJK, accented Latin, Greek, Cyrillic and em dashes are already correct on
the wire. Breakage needs an **astral-plane** character (U+10000+: emoji, CJK
ext-B and later, math alphanumerics) *earlier on the same line*, and the error
is one UTF-16 unit per such character.

## Symptom

Document (`file:///virtual/doc.yo`, opened with `textDocument/didOpen`):

```rust
/// Adds one.
add_one :: (fn(x : i32) -> i32)(x + i32(1));
main :: (fn() -> unit)({
  emoji := "😀"; y := add_one(i32(41));
  ()
});
export(main);
```

On line 3, `add_one` starts at **rune** column 21 and at **UTF-16** column 22
(the `😀` is one rune but two UTF-16 code units).

### 1. `textDocument/rename` returns a range one unit short

Request (the position is the UTF-16 column a spec-conformant client sends):

```json
{"jsonrpc":"2.0","id":2,"method":"textDocument/rename","params":{"textDocument":{"uri":"file:///virtual/doc.yo"},"position":{"line":3,"character":22},"newName":"add_uno"}}
```

Observed response, verbatim:

```json
{"jsonrpc":"2.0","id":2,"result":{"changes":{"file:///virtual/doc.yo":[{"range":{"start":{"line":1,"character":0},"end":{"line":1,"character":7}},"newText":"add_uno"},{"range":{"start":{"line":3,"character":21},"end":{"line":3,"character":28}},"newText":"add_uno"}]}}}
```

Expected: the second range is `{"line":3,"character":22}` → `{"line":3,"character":29}`.

A UTF-16 client resolves `[21, 28)` on that line to `" add_on"`, not
`"add_one"`, so applying the edit produces:

```
before:   emoji := "😀"; y := add_one(i32(41));
after :   emoji := "😀"; y :=add_unoe(i32(41));
```

The file is now broken, and nothing in the exchange reported an error.

### 2. `textDocument/publishDiagnostics` underlines the wrong span

Document:

```rust
main :: (fn() -> unit)({
  emoji := "😀"; undefined_fn_xyz();
});
export(main);
```

Observed, verbatim:

```json
"diagnostics":[{"range":{"start":{"line":1,"character":16},"end":{"line":1,"character":32}},"severity":1,"source":"yo","message":"Variable \"undefined_fn_xyz\" not found."}]
```

Expected `17` → `33`. The squiggle in the editor covers `; undefined_fn_xy`.

### 3. Inbound: the server only answers on the wrong basis

Hover on the one-rune local `y`, which sits at rune column 16 / UTF-16 column 17
on line 3 of the first document:

```
id 2 — position.character = 17 (UTF-16, what a conformant client sends)
  {"jsonrpc":"2.0","id":2,"result":null}

id 3 — position.character = 16 (rune, what this server wants)
  {"jsonrpc":"2.0","id":3,"result":{"contents":{"kind":"markdown","value":"```\ny\n: i32\n```"},"range":{"start":{"line":3,"character":16},"end":{"line":3,"character":17}}}}
```

The correct request gets no hover at all; the incorrect one works. Hover,
definition, references and rename all hit-test with the same comparison
(`src/lsp/hover.yo:52`), so all four go blind on the affected columns;
`src/lsp/completion.yo:878` *slices* with the column, so it computes the wrong
prefix and offers the wrong candidate set.

### 4. The server never says which encoding it means

The `initialize` result carries no `positionEncoding`, so per LSP 3.17 the
server is asserting the spec default — **utf-16** — which is exactly the thing
it does not emit:

```json
{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"textDocumentSync":1,"hoverProvider":true,"definitionProvider":true,"documentSymbolProvider":true,"referencesProvider":true,"foldingRangeProvider":true,"renameProvider":true,"documentFormattingProvider":true,"signatureHelpProvider":{"triggerCharacters":["(",","]},"completionProvider":{"triggerCharacters":[".","\"","/"]}},"serverInfo":{"name":"yo-lsp"}}}
```

(That response is pinned byte-for-byte as the 405-byte first frame of
`tests/cli-cases/lsp-handshake/expected_stdout`.) The structural reason the
server cannot negotiate its way out of this is filed separately as
`issues/lsp-initialize-discards-the-clients-params.md`.

## Root cause

The lexer materializes an `ArrayList(rune)` and indexes it, so `Token.column`
and `Token.character` are codepoint offsets — `src/token.yo:37-43` says so
explicitly ("RUNE offset … served straight to the LSP as a `character`
position"), as does `src/diagnostics.yo:86-87` for `Span.col` / `Span.len`.
`j_position` (`src/lsp/protocol.yo:40-41`) serialises whatever it is handed, and
every producer hands it a rune column. No conversion exists anywhere:
`grep -rn positionEncoding src` has exactly one hit and it is the comment at
`src/lsp/protocol.yo:86` saying the conversion is missing.

**Outbound — 6 sites, each emitting `rune column` + `rune width`:**

| site | expression |
| --- | --- |
| `src/lsp/server.yo:156` | `j_diagnostic(d.row, d.col, d.row, d.end_col, d.message)` (`end_col` is a caret count, one per rune — `src/diagnostics.yo`) |
| `src/lsp/hover.yo:294` | `j_range(target.row, target.column, target.row, target.column + target.value.chars().count())` |
| `src/lsp/definition.yo:105` | same shape |
| `src/lsp/references.yo:35`, `:99` | `_push_location(out, uri, tok.row, tok.column, tok.value.chars().count())` → `j_range(row, col, row, col + len)` at `:22` |
| `src/lsp/rename.yo:37` | `j_range(tok.row, tok.column, tok.row, tok.column + old_name.chars().count())` |
| `src/lsp/symbols.yo:94-99` | `name_tok.column + name_tok.value.chars().count()` |

**Inbound — 6 sites**, all reading `params.position.character` straight into a
`usize` that the handlers treat as a rune column:
`src/lsp/server.yo:292, 352, 438, 521, 607, 667`.

**Already safe, leave alone:** `src/lsp/folding.yo` (no `character` at all —
`startLine`/`endLine` only), whole-document formatting (`src/lsp/server.yo:219`
emits a range at character 0), and `signatureHelp` (its result carries no
positions).

The comments at `src/lsp/rename.yo:35-36`, `definition.yo:104`,
`references.yo:34`, `hover.yo:50-51` and `symbols.yo:98` all say "RUNE column + RUNE width" on purpose: D4 PR 3
(`plans/STD_API_AUDIT_D4_PLAN.md` §5.4) made the server's *internal* basis
coherent and deliberately deferred the protocol-visible correction. The seam it
promised is in place — `rune_col_to_byte_offset` (`src/lsp/protocol.yo:90-108`)
and `byte_offset_to_rune_col` (`:114-131`) — and this issue is the follow-up
that never happened. Note that `plans/archive/P4_LSP.md`'s "Remaining quality
items" paragraph does not mention it, so the LSP's own plan of record does not
carry its one known protocol-correctness defect.

## Fix

Implement real UTF-16 conversion. **Do not** implement `utf-8` negotiation as
the fix: Yo's own client cannot use it —
`vscode-extension/node_modules/vscode-languageclient/lib/common/client.js:1370`
hardcodes `generalCapabilities.positionEncodings = ['utf-16']`, and
`vscode-extension/package.json:70` pins `vscode-languageclient` at `^9.0.1`. So
negotiation buys the shipped extension exactly nothing while doubling the state
space every position test must cover.

1. **`src/lsp/protocol.yo` — add the UTF-16 sibling pair beside `:90-131`** and
   export it. Each is a `line.char_indices()` walk accumulating
   `1 + (if r.char > 0xFFFF then 1 else 0)`; `src/lexer.yo:331-364` already does
   exactly this arithmetic for char-literal validity and is the in-tree
   reference. Do **not** reach for `std/encoding/utf16.yo` — it exports only
   whole-string `utf8_to_utf16` / `utf16_to_utf8` (`:48`, `:97`), the wrong
   granularity.

   ```rust
   /// UTF-16 code-unit column of the rune at RUNE column `col` in `line`.
   rune_col_to_utf16_col :: (fn(line : String, col : usize) -> usize)({ … });
   /// RUNE column of the rune starting at UTF-16 code-unit column `u16col`.
   utf16_col_to_rune_col :: (fn(line : String, u16col : usize) -> usize)({ … });
   ```

   Both must clamp past-the-end the way the existing pair does, and
   `utf16_col_to_rune_col` must round a column that lands *inside* a surrogate
   pair down to the pair's start (a client can legally send one; the spec says
   to snap to the nearest boundary).

2. **Convert the 6 outbound sites.** Every one of them computes
   `tok.column + tok.value.chars().count()`, so the converter needs the LINE
   TEXT of `tok.row`. `handle_hover`, `handle_definition`, `handle_references`
   and `handle_rename` already receive `st.text` (`src/lsp/server.yo:308, 368,
   454, 537`); `handle_document_symbols(st.outcome.exprs)`
   (`src/lsp/server.yo:398`, signature at `src/lsp/symbols.yo:73-75`) does not.
   Two options: **(a)** add a `text : String` parameter to
   `handle_document_symbols`, matching every sibling handler — recommended, it
   keeps one uniform shape; **(b)** convert off `Token.input` +
   `Token.byte_offset` (`src/token.yo:44-56`), which needs a guard for the
   `?= usize(0)` default that synthetic tokens carry. Prefer (a).

3. **Convert the 6 inbound sites** (`src/lsp/server.yo:292, 352, 438, 521, 607,
   667`) at the parse point, so every handler keeps speaking runes internally
   and `completion.yo`'s existing rune⟷byte conversions stay correct untouched.

4. **Declare it.** Add `positionEncoding: "utf-16"` to the capability object at
   `src/lsp/server.yo:193`. That is the honest statement of what is then true,
   and it is what turns an implicit claim into an explicit one.

Defer `utf-8` negotiation as a pure optimisation for Neovim/Helix/Zed; it is
~15 lines once the initialize params are threaded in (see the companion issue)
and lands later without reopening any of this.

## Regression test

New cli-case `tests/cli-cases/lsp-position-utf16`, shaped like
`tests/cli-cases/lsp-handshake` (`cmd` = `lsp`, framed JSON-RPC in `stdin`,
`expected_stdout` golden, `timeout=240` in `opts`). It must:

- open a fixture document whose lines carry `😀` (U+1F600 — 1 rune, 2 UTF-16
  units, 4 bytes) inside a doc comment and a string literal **before** the
  identifiers under test;
- drive hover, definition, references, rename **and** completion at
  hand-computed UTF-16 columns, and pin the returned ranges;
- assert the diagnostics range on a line with an emoji before the error token.

Four mechanics that will otherwise waste a cycle:

- **Land it RED first.** Measure and record that it fails against today's
  `develop` before any conversion code is written.
- Run `yo fmt` on the fixture `.yo` files **before** `--record` — the CI fmt
  gate scans `tests/cli-cases`, and the fixture hash is baked into
  `expected_tree`.
- Keep the emoji out of *identifiers*:
  `issues/async-effect-setter-emits-a-raw-non-ascii-identifier-as-a-c-member-name.md`
  is open, and a fixture that trips it tests the wrong bug.
- Assert the golden contains real responses, not just the handshake — the
  cli-diff harness fed `/dev/null` to stdin until 2026-08-22
  (`issues/fixed/cli-diff-stdin-relative-cdir-vacuous.md`), and a case that
  reproduces that shape is vacuously green.

`tests/cli-cases/lsp-handshake/expected_stdout` must be re-recorded in the same
change: its 405-byte initialize frame grows the moment `positionEncoding` is
declared. `tests/cli-cases/lsp-completion` is all-ASCII and should diff nowhere.

## Breaking change

Protocol-visible. The positions this server emits and accepts move for any line
containing an astral-plane character, and the `initialize` result gains a
`positionEncoding` field. The `lsp-handshake` cli-case golden changes with it
(`lsp-completion` is all-ASCII and should not move). Call it out in the release
notes: an editor integration that had been compensating for the rune basis would
need its workaround removed.
