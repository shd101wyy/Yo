# Yo Language Server Protocol (LSP) Implementation Plan

> **SUPERSEDED for the self-hosting era — see [`P4_LSP.md`](P4_LSP.md).**
> This document planned (and delivered) the **TypeScript** LSP under `src/lsp/`,
> which retires with `src/` in P2.5. It is kept because the feature analysis
> and the problem statement below still hold — the Yo rewrite has to deliver
> the same surface. What has changed: the server is rewritten in Yo as a
> `yo lsp` subcommand, and the first slice is NOT diagnostics but fixing the
> def-eval swallow, since `yo-self check` currently accepts code the TS
> compiler rejects (P4_LSP.md, spike 2).

## Problem

The VS Code extension (`vscode-extension/src/extension.ts`, ~1700 lines) directly imports the Yo evaluator and implements IDE features (hover, completion, go-to-definition, diagnostics) using VS Code-specific APIs. This has several problems:

1. **Editor lock-in** — only VS Code gets IDE support. Neovim, Helix, Zed, Emacs users get nothing.
2. **Tight coupling** — the extension directly uses internal evaluator types (`Environment`, `Expr`, `AtomExpr`, `Type`, etc.), making both the extension and evaluator harder to change.
3. **No incremental analysis** — every file save re-evaluates from scratch via `moduleManager.loadModule()`.
4. **Duplicated logic** — the extension re-implements scope resolution, type lookup, and symbol search that the evaluator already knows how to do.

## Approach: TypeScript LSP Server → Thin VS Code Client

### Architecture

```
┌─────────────────────┐       JSON-RPC        ┌──────────────────────────┐
│  VS Code Extension  │◄─────(stdio)─────────►│  yo-lsp (TypeScript)     │
│  (thin LSP client)  │                       │                          │
│  ~50 lines          │                       │  ModuleManager           │
└─────────────────────┘                       │  ├── Evaluator (per file)│
                                              │  ├── Token[]             │
┌─────────────────────┐       JSON-RPC        │  ├── Expr[] (AST)        │
│  Neovim / Helix /   │◄─────(stdio)─────────►│  └── Environment (scope) │
│  other editors      │                       └──────────────────────────┘
└─────────────────────┘
```

**The LSP server is a standalone Node.js process** launched by the editor. It:

- Spawns with `node yo-lsp.js --stdio` (or TCP)
- Reuses the existing `ModuleManager`, `Evaluator`, and all type/value infrastructure
- Translates evaluator data → LSP protocol responses
- Lives in `src/lsp/` alongside the compiler source (same TypeScript codebase)

**The VS Code extension becomes a thin client** that:

- Starts the LSP server process
- Registers the language with `vscode-languageclient`
- Keeps only TextMate grammar and language configuration
- No more direct evaluator imports

### Why TypeScript (not Yo) for the LSP

1. **The evaluator IS the LSP backend.** The whole point is to expose existing evaluator data via LSP. Writing a new evaluator in Yo means bootstrapping — a separate, much larger project.
2. **LSP libraries exist for Node.js** (`vscode-languageserver`, `vscode-languageclient`) — battle-tested, handles all protocol details.
3. **Same build toolchain** — `bun run build` already builds the compiler; the LSP server is just another entry point.
4. **Bootstrapping is orthogonal.** When Yo becomes self-hosted, the LSP can be rewritten in Yo. But that's a future milestone, not a prerequisite.

## LSP Capabilities to Implement

### Phase 1: Core (migrate existing features)

These map 1:1 to what `extension.ts` already does:

| LSP Capability   | Current extension code                                             | LSP method                               |
| ---------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Diagnostics      | `analyzeYoFile()` → `diagnosticCollection.set()`                   | `textDocument/publishDiagnostics` (push) |
| Hover            | `provideHover()` — shows type, value, doc comment                  | `textDocument/hover`                     |
| Completion       | `provideCompletionItems()` — identifiers, keywords, dot-completion | `textDocument/completion`                |
| Go-to-definition | `provideDefinition()` — token → env → variable.token               | `textDocument/definition`                |

### Phase 2: New capabilities

Features the current extension doesn't have but the evaluator can support:

| LSP Capability    | Data source                               | LSP method                    |
| ----------------- | ----------------------------------------- | ----------------------------- |
| Document symbols  | `evaluator.getProgram()` top-level exprs  | `textDocument/documentSymbol` |
| Find references   | Walk all module ASTs for matching tokens  | `textDocument/references`     |
| Rename            | Find references + apply edits             | `textDocument/rename`         |
| Signature help    | Function type parameters from expr.$.type | `textDocument/signatureHelp`  |
| Semantic tokens   | Token types + evaluator type info         | `textDocument/semanticTokens` |
| Code actions      | Quick fixes from diagnostic info          | `textDocument/codeAction`     |
| Workspace symbols | Cross-module symbol search                | `workspace/symbol`            |

### Phase 3: Advanced

| Feature             | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| Incremental parsing | Only re-evaluate changed regions (requires evaluator changes) |
| Inlay hints         | Show inferred types inline                                    |
| Code lens           | Show test run buttons, impl count                             |
| Folding ranges      | Based on AST structure                                        |
| Document formatting | Yo formatter (needs to be built)                              |

## Implementation Plan

### 1. Create LSP server scaffold (`src/lsp/`)

Files to create:

- `src/lsp/server.ts` — LSP server entry point, initializes connection, registers handlers
- `src/lsp/document-manager.ts` — wraps `ModuleManager` with LSP document sync (open/change/close)
- `src/lsp/diagnostics.ts` — converts `YoError`/`YoLexerError` → LSP `Diagnostic[]`
- `src/lsp/hover.ts` — extracts hover info from evaluator (port of `provideHover`)
- `src/lsp/completion.ts` — completion logic (port of `provideCompletionItems` + dot completion)
- `src/lsp/definition.ts` — go-to-definition (port of `provideDefinition`)
- `src/lsp/symbols.ts` — document symbols from AST
- `src/lsp/utils.ts` — shared helpers (token finding, expr matching, position conversion)

Dependencies to add:

- `vscode-languageserver` (server-side LSP protocol)
- `vscode-languageserver-textdocument` (text document model)

### 2. Port existing features to LSP handlers

Each handler follows the same pattern:

1. Get document URI from LSP request
2. Look up module in `ModuleManager`
3. Extract evaluator data (tokens, AST, environment)
4. Convert to LSP response types

The conversion is mechanical — the logic already exists in `extension.ts`.

### 3. Add build entry point

- Add `src/lsp/server.ts` as a separate build target in `build.js`
- Output: `out/yo-lsp.js` (standalone Node.js script)
- Add `yo lsp` subcommand to `yo-cli.ts` that launches the server

### 4. Rewrite VS Code extension as thin client

Replace the 1700-line `extension.ts` with ~50 lines:

```typescript
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

export function activate(context) {
  const serverModule = context.asAbsolutePath("../out/yo-lsp.js");
  const client = new LanguageClient(
    "yo",
    "Yo Language Server",
    {
      run: { module: serverModule, transport: TransportKind.stdio },
    },
    { documentSelector: [{ scheme: "file", language: "yo" }] }
  );
  client.start();
}
```

Add dependency: `vscode-languageclient` to the extension's `package.json`.

### 5. Build.yo awareness

Port the `ensureBuildImportsResolved()` logic into the LSP server's `document-manager.ts`. The server discovers `build.yo` in the workspace root, evaluates it once, and configures import resolution — same as today, but inside the server process.

### 6. Test the LSP server

- Unit tests: mock LSP requests, verify response shapes
- Integration tests: launch server process, send JSON-RPC, verify responses
- Manual testing: install updated extension, verify hover/completion/diagnostics/go-to-def work

## File Structure (after migration)

```
src/lsp/
├── server.ts              # Entry point: createConnection, register handlers
├── document-manager.ts    # ModuleManager wrapper with LSP document sync
├── diagnostics.ts         # YoError → LSP Diagnostic conversion
├── hover.ts               # textDocument/hover handler
├── completion.ts          # textDocument/completion handler
├── definition.ts          # textDocument/definition handler
├── symbols.ts             # textDocument/documentSymbol handler
├── references.ts          # textDocument/references handler (same-file)
├── rename.ts              # textDocument/rename + prepareRename handler
├── signature-help.ts      # textDocument/signatureHelp handler
├── folding.ts             # textDocument/foldingRange handler
├── inlay-hints.ts         # textDocument/inlayHint handler
└── utils.ts               # Token/position helpers

vscode-extension/
├── src/extension.ts       # Thin LSP client (~80 lines)
├── src/extension.old.ts   # Original 1700-line extension (backup)
├── syntaxes/              # TextMate grammar (unchanged)
├── language-configuration.json (unchanged)
└── package.json           # + vscode-languageclient dep
```

## Current LSP Capabilities (10 total)

| Capability       | LSP Method                      | Status     |
| ---------------- | ------------------------------- | ---------- |
| Diagnostics      | textDocument/publishDiagnostics | ✅ Phase 1 |
| Hover            | textDocument/hover              | ✅ Phase 1 |
| Completion       | textDocument/completion         | ✅ Phase 1 |
| Go-to-definition | textDocument/definition         | ✅ Phase 1 |
| Document symbols | textDocument/documentSymbol     | ✅ Phase 2 |
| Find references  | textDocument/references         | ✅ Phase 2 |
| Rename           | textDocument/rename             | ✅ Phase 2 |
| Signature help   | textDocument/signatureHelp      | ✅ Phase 3 |
| Folding ranges   | textDocument/foldingRange       | ✅ Phase 3 |
| Inlay hints      | textDocument/inlayHint          | ✅ Phase 3 |

## Future Capabilities

| Feature             | Description                                         |
| ------------------- | --------------------------------------------------- |
| Workspace symbols   | Cross-module symbol search                          |
| Semantic tokens     | Rich token classification using evaluator type info |
| Code actions        | Quick fixes from diagnostic info                    |
| Incremental parsing | Only re-evaluate changed regions                    |
| Code lens           | Show test run buttons, impl count                   |
| Document formatting | Yo formatter (needs to be built)                    |

## On Bootstrapping & Self-Hosting

The LSP is **not** the right vehicle for bootstrapping Yo. Here's the roadmap:

1. **Now**: TypeScript LSP server (this plan) — weeks of work, immediate value
2. **Later**: Self-hosted Yo compiler — requires Yo to compile itself (lexer, parser, evaluator, codegen all in Yo). This is a multi-month project tracked separately.
3. **After bootstrap**: Rewrite LSP in Yo — natural follow-on once the self-hosted compiler exists. The LSP becomes a Yo program that uses the Yo evaluator library.

The TypeScript LSP is not throwaway work — it defines the protocol contract and test suite that the future Yo LSP must satisfy. It also immediately unblocks multi-editor support.

## Notes

- The `allowPartialModule: true` option in `ModuleManager` is critical for IDE use — it allows the evaluator to produce partial results even when the file has errors.
- The current extension re-evaluates on every save (`onDidSaveTextDocument`). The LSP should switch to `onDidChangeTextContent` with debouncing for real-time feedback.
- The dot-completion logic (lines 1057-1555 in extension.ts) has a hardcoded list of common method names. The LSP should improve this by walking all impls for the receiver type.
- `getReceiverMethodsByNameFromEnv` is the key evaluator API for method completion — it already does the heavy lifting of trait resolution.
