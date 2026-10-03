# Language Server Protocol (LSP) Support

`yo lsp` is a language server built into the `yo` binary. It speaks LSP over
stdio and reuses the Yo evaluator rather than a separate parser, so the types
and values it reports are exactly the compiler's. The VS Code extension bundles
a client for it; any other LSP-capable editor can spawn `yo lsp` directly.

## Architecture

```
Editor (VS Code extension, or any LSP client)
  ↕ stdio JSON-RPC
yo lsp  (src/lsp/, one module per feature)
  ↕ direct function calls
Yo evaluator (module_manager: cached prelude, demand-loaded imports)
```

The server is written in Yo and lives in `src/lsp/`. The VS Code extension is a
thin `LanguageClient` wrapper (`vscode-extension/extension.js`, plain
JavaScript, no build step). All intelligence lives in the server.

## Setup

### VS Code

Install the [Yo extension](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang)
and have a `yo` binary on your `PATH` (see the install guides for
[macOS](./INSTALL_MACOS.md), [Linux](./INSTALL_LINUX.md) and
[Windows](./INSTALL_WINDOWS.md)). The extension starts `yo lsp` when a `.yo`
file is opened.

Settings:

| Setting            | Default | Meaning                                                                                        |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `yo.binPath`       | `"yo"`  | Path to the `yo` binary used for the server, when it is not on `PATH`.                          |
| `yo.lsp.enabled`   | `true`  | Start the language server. With `false` the extension is syntax highlighting only.             |
| `yo.trace.server`  | `"off"` | `messages` or `verbose` logs the JSON-RPC traffic to the "Yo Language Server" output channel.  |

The command **Yo: Restart Language Server** stops and restarts the server (for
example after installing a new `yo` version). Changing `yo.binPath` or
`yo.lsp.enabled` restarts it automatically.

### Other editors

Point the editor's LSP client at the command `yo lsp` (no arguments, stdio
transport) for the `yo` language / `.yo` files. For example, with Neovim's
built-in client:

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = "yo",
  callback = function()
    vim.lsp.start({ name = "yo", cmd = { "yo", "lsp" } })
  end,
})
```

The server locates the standard library the same way the compiler does
(`--std-path` is not available here; set `YO_STD` if `yo` cannot find `std/`
next to itself).

## Features

### 1. Diagnostics

Errors are published on open and after each change settles (a short idle
window — see "Behaviour while editing"), at the exact range the
compiler's own diagnostic renderer underlines, with the diagnostic's severity
(`error`, `warning`, `note`, `help`) and its code (`E0401`, …) when it has one.
Errors in an imported file surface at the top of the importing document with
the location in the message.

The evaluator stops at the first error, so a document shows at most one primary
diagnostic (plus its notes) at a time. A diagnostic's notes and helps point
elsewhere — into the standard library for a failed `where` clause, at the
other end of a mismatch — as `relatedInformation` entries, so the Problems
panel shows them as working links on the primary, not as separate 0:0 rows.

### 2. Hover

Hover over an identifier to see its type, its value when it is known at
compile time, and its doc comment:

```
add_one
: fn(x : i32) -> i32
```

On a member access (`p.x`, `list.len`) the hover shows the member's type.
Instantiated generics render as written — `ArrayList(i32)`, `Option(String)`,
`?(*(T))` — never as an internal id.

### 3. Completion

- **Import paths**: inside `import("std/…` or `import("./…` the directory's
  modules and subdirectories are listed.
- **Import lists**: with the cursor inside the braces of
  `{ … } :: import("mod")`, the module's exports are offered (minus the names
  already listed), whether or not the document parses at that moment.
- **Dot completion** (`expr.`): struct fields, enum variants, union fields,
  module members, trait methods, inherent and generic-impl methods, with
  parameter snippets. Type-valued receivers work too (`Point.`, `Option(i32).`);
  pointers are auto-dereferenced.
- **Enum variant prefix** (`.` after `=`, `(`, `,`, `{`, `;`, `=>`, `:=` or
  `return`): the variants of the expected enum, inferred from a typed
  declaration or the subject of the enclosing `match`.
- **Identifiers**: names already used in the document, everything visible in
  the deepest enclosing scope (prelude types such as `Option` and `Result`,
  imports), and keywords. Identifier and import-list matching is by PREFIX
  (`Poi` offers `Point`, not `JoinHandle`); dot completion matches the same
  way.

### 4. Go to Definition / Declaration / Implementation

**Definition** jumps to the declaration of a variable, function, type or
imported name — across files when the name was imported — and of members: a
field access or struct-literal label (`p.x`, `Point(x : …)`) lands on the
field inside `struct(...)`, a variant (`Color.Red`, a `.Red` pattern) on the
variant inside `enum(...)`, a method (`p.dist()`, `list.push`) on its
`label : value` pair in the declaring `impl(...)` block (inherent, trait or
generic, in this file or in the standard library), and `mod.f` on the
`f ::` binding of the imported module.

**Declaration** answers exactly what definition does — in yo a binding has
one site, no separate header shape — so editors that map "go to declaration"
to its own request keep working.

**Implementation** (`textDocument/implementation`) lists this file's
`impl(...)` blocks for the type or trait under the cursor: a trait name
offers every impl of it in the file, a type name offers its inherent and
trait impls (same-file today, like references and rename).

### 5. Document Symbols

Every top-level `name :: value` binding, classified by the value's shape
(function, struct, enum, trait, impl, constant), plus the declaration forms
`(name : T) = value`, `name := value;` and `thread_local(name) := init;`,
listed as variables. Works while the document has evaluation errors. Clients
that did not declare `hierarchicalDocumentSymbolSupport` receive the flat
`SymbolInformation[]` shape instead of the hierarchical one.

### 6. Find References and Rename

Both follow the **binding** under the cursor, not its spelling: renaming a
local `x` leaves a struct field `x`, the label in `Point(x : …)` and the access
`p.x` untouched. Inside a `generic(...)` function body that has not been
specialized, occurrences are matched by name (the evaluator has not visited
them). References and rename are same-file.

`context.includeDeclaration` is honored (a request from the declaration
itself — right-click a definition — still drops it when false). Rename
validates the new name first: an identifier that is not a legal binding name,
a keyword, or a name reserved for a compiler builtin is refused with an error
message in the rename box instead of splicing broken text into the buffer;
`prepareRename` answers only on symbols that can actually be renamed.

### 7. Signature Help

After `(` or `,` inside a call, the callee's parameters with the active one
highlighted.

### 8. Folding Ranges

Multi-line `{ … }` / `( … )` regions and multi-line block comments.

### 9. Formatting

Whole-document formatting through `yo fmt`'s formatter. A document that does
not parse is left untouched. The VS Code extension enables format-on-save for
`.yo` files by default.

### 10. Code Actions (quickfixes)

`textDocument/codeAction` answers one `quickfix` per diagnostic on the
requested lines that carries a compiler `Repair` — the unique mechanical fix
`yo fix` applies (a rename to the one close candidate, the missing std import
line, the `;` before a `}`; see `ERROR_DIAGNOSTICS.md`). The action's edit is
byte-for-byte the CLI's, so the editor and `yo fix` never disagree. A
diagnostic whose message names two possible fixes carries no repair and
therefore no action.

### 11. Document Highlights

Selecting an identifier highlights every occurrence of its **binding** in the
file — the declaration is highlighted as a write, every use as plain text;
members and labels highlight nothing (same identity rule as references and
rename).

### 12. Go to Type Definition

On a value, jumps to the declaration of its type (`p` in `p := Point(…)` lands
on `Point :: struct(…)`; an instantiated generic lands on its binding, shown
as written — `ArrayList(usize)` jumps to `ArrayList`). Labels, function-typed
names and primitives answer nothing.

### 13. Workspace Symbols

`workspace/symbol` searches the top-level symbols of every OPEN document
(case-insensitive substring; an empty query lists them all). Closed files are
not indexed — cross-module search wants an index-shape decision first.

### 14. Document Links

`textDocument/documentLink` turns every `import("path")` string literal into
a link to the file it names — `std/…` paths through the standard library,
`./…`/`../…` through the importing document's directory. Only links whose
target exists are answered; a dependency name (resolved through the nearest
manifest by the compiler) carries no link.

### 15. Semantic Tokens

`textDocument/semanticTokens/full` colors the document beyond what a TextMate
grammar can know: keywords, strings, numbers and comments from the lexer, and
identifiers classified by the analysis — types, functions, plain variables,
and struct fields / labels / variants as properties. Identifiers the current
analysis cannot classify keep their fallback coloring rather than being
guessed. Positions and lengths are in the negotiated position encoding, and a
token spanning lines (a block comment) is emitted as one segment per line.

## Behaviour while editing

Most keystrokes leave a document that does not parse. The server keeps the
**last parsed** analysis of each document for hover, completion, symbols,
references and rename, so those keep answering mid-edit; positions are matched
against the current text by token, so a stale analysis answers only where the
two still agree. A document that parses but fails to evaluate keeps its full
program and every type the evaluator recorded before the error.

A `didChange` retains the new text at once but does not re-analyze inline:
the full analysis (and with it `publishDiagnostics`) is debounced to a short
idle window (300 ms) after the last edit, so a burst of keystrokes costs one
analysis instead of one per key, and a request arriving mid-edit — hover,
completion, signature help — is answered immediately from the retained
analysis rather than queueing behind a fresh evaluation (which takes seconds
on compiler-sized files). Diagnostics therefore lag the last keystroke by
the window, never more; a conversation that ends while a window is still
open still delivers the final diagnostics before the server exits.

Edits to an open imported file are visible to the next analysis of any
document that imports it (the server overlays open buffers on the module
loader and invalidates the dependents). Edits to an imported file made
**outside** the editor arrive as `workspace/didChangeWatchedFiles` (editors
watch the workspace): the module is purged from the cache and every open
document is re-analyzed — the VS Code extension watches `**/*.yo`. Edits to
`std/prelude.yo` still need a server restart (the prelude environment is
cached once).

## Position encoding

The compiler's columns are Unicode scalar values (one column per rune). At
`initialize` the server negotiates the wire encoding against the client's
offered `general.positionEncodings`: `utf-32` when offered (the server's
native unit, so nothing is converted), else `utf-16` (the protocol default),
else `utf-8` — never an encoding the client did not offer. Under `utf-16` or
`utf-8` every column the server sends or receives is converted — an emoji or
other astral-plane character occupies two UTF-16 units, one rune (and up to
four UTF-8 bytes).

## Protocol behavior

The server follows the JSON-RPC 2.0 / LSP 3.17 lifecycle: requests before
`initialize` are refused with `ServerNotInitialized`, a second `initialize`
and anything after `shutdown` with `InvalidRequest`, unknown `$/` requests
with `MethodNotFound` (so clients can feature-probe) while `$/` notifications
are ignored, and an unparseable body is answered with `-32700` under a null
id. `exit` terminates the process — exit code 0 after a `shutdown`, 1
without one.

## Source layout

| File                          | Serves                                              |
| ----------------------------- | --------------------------------------------------- |
| `src/lsp/server.yo`           | JSON-RPC dispatch, `initialize`, document sync       |
| `src/lsp/transport.yo`        | `Content-Length` framing over stdio                  |
| `src/lsp/protocol.yo`         | JSON builders, position encoding, `file:` URIs       |
| `src/lsp/diagnostics.yo`      | document analysis and `publishDiagnostics`; diagnostics carry the `Repair` that `textDocument/codeAction` (in `server.yo`) serves |
| `src/lsp/hover.yo`            | hover, shared token/candidate helpers, atom roles    |
| `src/lsp/completion.yo`       | `textDocument/completion`                            |
| `src/lsp/definition.yo`       | `textDocument/definition`, `typeDefinition`, `declaration` and `documentLink` |
| `src/lsp/references.yo`       | `textDocument/references`, `documentHighlight` and the occurrence walker |
| `src/lsp/rename.yo`           | `textDocument/rename` and `prepareRename`            |
| `src/lsp/symbols.yo`          | `textDocument/documentSymbol`, `workspace/symbol` and `implementation` |
| `src/lsp/signature_help.yo`   | `textDocument/signatureHelp`                         |
| `src/lsp/folding.yo`          | `textDocument/foldingRange` and `semanticTokens`     |

## Testing

The server is driven exactly as an editor drives it: the `lsp-*` cases under
`tests/cli-cases/` feed framed JSON-RPC to `yo lsp` over stdin and compare the
framed replies against recorded goldens (`scripts/cli-diff-test.sh`) — and
assert the RAW stream's framing is strictly `Content-Length: N` + exactly
`CRLF CRLF` + N body bytes (`framing=strict` in each case's `opts`), the
class of bug that once killed every Windows client.
`scripts/lsp-strict-handshake.py` drives the same strict session against any
`yo` binary and runs in the release workflow's Windows bundle smoke legs.
The pure helpers (URI conversion, position encoding) and the analysis-state
guarantees are covered by `tests/internal/lsp_protocol.test.yo`; module
invalidation by `tests/internal/module_invalidation.test.yo`.
