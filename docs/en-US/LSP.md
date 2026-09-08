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

Errors are published on open and on every change, at the exact range the
compiler's own diagnostic renderer underlines, with the diagnostic's severity
(`error`, `warning`, `note`, `help`) and its code (`E0401`, …) when it has one.
Errors in an imported file surface at the top of the importing document with
the location in the message.

The evaluator stops at the first error, so a document shows at most one primary
diagnostic (plus its notes) at a time.

### 2. Hover

Hover over an identifier to see its type, its value when it is known at
compile time, and its doc comment:

```
add_one
: fn(x : i32) -> i32
```

On a member access (`p.x`, `list.len`) the hover shows the member's type.

### 3. Completion

- **Import paths**: inside `import("std/…` or `import("./…` the directory's
  modules and subdirectories are listed.
- **Dot completion** (`expr.`): struct fields, enum variants, union fields,
  module members, trait methods, inherent and generic-impl methods, with
  parameter snippets. Type-valued receivers work too (`Point.`, `Option(i32).`);
  pointers are auto-dereferenced.
- **Enum variant prefix** (`.` after `=`, `(`, `,`, `{`, `;`, `=>`, `:=` or
  `return`): the variants of the expected enum, inferred from a typed
  declaration or the subject of the enclosing `match`.
- **Identifiers**: names already used in the document, everything visible in
  the deepest enclosing scope (prelude types such as `Option` and `Result`,
  imports), and keywords.

### 4. Go to Definition

Jumps to the declaration of a variable, function, type or imported name —
across files when the name was imported. Member names and labels (`p.x`,
`Point(x : 1)`) have no definition target yet.

### 5. Document Symbols

Every top-level `name :: value` binding, classified by the value's shape
(function, struct, enum, trait, impl, constant). Works while the document has
evaluation errors.

### 6. Find References and Rename

Both follow the **binding** under the cursor, not its spelling: renaming a
local `x` leaves a struct field `x`, the label in `Point(x : …)` and the access
`p.x` untouched. Inside a `generic(...)` function body that has not been
specialized, occurrences are matched by name (the evaluator has not visited
them). References and rename are same-file.

### 7. Signature Help

After `(` or `,` inside a call, the callee's parameters with the active one
highlighted.

### 8. Folding Ranges

Multi-line `{ … }` / `( … )` regions and multi-line block comments.

### 9. Formatting

Whole-document formatting through `yo fmt`'s formatter. A document that does
not parse is left untouched. The VS Code extension enables format-on-save for
`.yo` files by default.

## Behaviour while editing

Most keystrokes leave a document that does not parse. The server keeps the
**last parsed** analysis of each document for hover, completion, symbols,
references and rename, so those keep answering mid-edit; positions are matched
against the current text by token, so a stale analysis answers only where the
two still agree. A document that parses but fails to evaluate keeps its full
program and every type the evaluator recorded before the error.

Edits to an open imported file are visible to the next analysis of any
document that imports it (the server overlays open buffers on the module
loader and invalidates the dependents). Edits to an imported file made
**outside** the editor, and edits to `std/prelude.yo`, need a server restart.

## Position encoding

The compiler's columns are Unicode scalar values (one column per rune). At
`initialize` the server negotiates the wire encoding: when the client lists
`utf-32` in `general.positionEncodings` the server picks it and columns pass
through unchanged; otherwise it uses the protocol default `utf-16` and converts
every column it sends or receives — an emoji or other astral-plane character
occupies two UTF-16 units, one rune.

## Source layout

| File                          | Serves                                              |
| ----------------------------- | --------------------------------------------------- |
| `src/lsp/server.yo`           | JSON-RPC dispatch, `initialize`, document sync       |
| `src/lsp/transport.yo`        | `Content-Length` framing over stdio                  |
| `src/lsp/protocol.yo`         | JSON builders, position encoding, `file:` URIs       |
| `src/lsp/diagnostics.yo`      | document analysis and `publishDiagnostics`           |
| `src/lsp/hover.yo`            | hover, shared token/candidate helpers, atom roles    |
| `src/lsp/completion.yo`       | `textDocument/completion`                            |
| `src/lsp/definition.yo`       | `textDocument/definition`                            |
| `src/lsp/references.yo`       | `textDocument/references` and the occurrence walker  |
| `src/lsp/rename.yo`           | `textDocument/rename`                                |
| `src/lsp/symbols.yo`          | `textDocument/documentSymbol`                        |
| `src/lsp/signature_help.yo`   | `textDocument/signatureHelp`                         |
| `src/lsp/folding.yo`          | `textDocument/foldingRange`                          |

## Testing

The server is driven exactly as an editor drives it: the `lsp-*` cases under
`tests/cli-cases/` feed framed JSON-RPC to `yo lsp` over stdin and compare the
framed replies against recorded goldens (`scripts/cli-diff-test.sh`). The pure
helpers (URI conversion, position encoding) and the analysis-state guarantees
are covered by `tests/internal/lsp_protocol.test.yo`; module invalidation by
`tests/internal/module_invalidation.test.yo`.
