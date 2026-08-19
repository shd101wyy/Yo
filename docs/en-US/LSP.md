# Language Server Protocol (LSP) Support

> **Not currently shipping.** The server described here was a TypeScript
> program that called the TypeScript evaluator directly, and it was deleted
> together with the rest of the TypeScript compiler when Yo became
> self-hosted. The VS Code extension is syntax highlighting only today, and
> there is no `yo lsp` subcommand. A Yo-native replacement built on the
> self-hosted evaluator is planned; this document is kept as the specification
> of the behaviour it has to restore.

Yo's LSP server gives `.yo` files rich editor support. It reuses the Yo evaluator rather than a separate parser, so the types and values it reports are exactly the compiler's.

## Architecture

```
VS Code Extension (thin client)
  ↕ stdio JSON-RPC
LSP Server
  ↕ direct function calls
Yo Evaluator
```

The VS Code extension is a thin `LanguageClient` wrapper (~80 lines). All intelligence lives in the LSP server, which calls the evaluator directly for type resolution, completion, and diagnostics.

## Features

### 1. Hover Information

Hover over any identifier to see its type, value (if compile-time known), and doc comment.

- **Variables**: Shows type and value
- **Functions**: Shows full signature with parameter names and types
- **Struct fields**: Shows field type and doc comment
- **Impl method labels**: Shows method signature and doc comment
- **Type-level access**: `Point.origin` shows the method's type

### 2. Auto-Completion

#### Dot-completion (`expr.`)

Type a `.` after an expression to see available members:

- **Struct fields**: All fields with types and doc comments
- **Enum variants**: Variant names with field types (e.g., `Some(T)`, `None`), auto-inserted as snippets with parameter placeholders
- **Module members**: Exported functions and types with doc comments
- **Impl methods**: Methods from `impl` blocks with parameter snippet placeholders (e.g., `add(${1:other})`)
- **Array/str**: `.len` property
- **Type-level**: `Point.` shows static methods and constructors
- **Pointer auto-deref**: `ptr.field` automatically dereferences
- **Nested structs**: `outer.inner.` shows fields of the inner struct

#### Enum variant dot-prefix (`.Variant`)

In typed contexts, type `.` to see enum variants:

```rust
(x : Option(i32)) = .  // Shows: .Some, .None
match(color,
  .  // Shows: .Red, .Green, .Blue
)
```

#### Identifier completion

Type any prefix to see matching variables, functions, and keywords in scope. This includes:

- **Prelude types**: `Option`, `Result`, `Box`, `Io`, and other types available without imports
- **Imported types**: Types and functions from `open import` statements
- **Local variables**: Variables declared earlier in the same scope
- **Internal names filtered**: `__yo_*` and `___*` compiler-internal symbols are hidden

### 3. Go to Definition

`Ctrl+Click` or `F12` on any identifier to jump to its definition.

- **Variables**: Jump to the declaration site
- **Import paths**: Click on `"std/string"` to open the imported file
- **Struct/enum/function names**: Jump to the type or function definition
- **Enum variants**: `.Red`, `.Some(...)` — jump to the variant definition in the enum

### 4. Document Symbols

`Ctrl+Shift+O` to see all top-level declarations in the current file.

### 5. Find References

`Shift+F12` to find all references to a symbol across the current file.

### 6. Rename Symbol

`F2` to rename a symbol and all its references.

### 7. Signature Help

Type `(` after a function name to see parameter hints as you type.

### 8. Folding Ranges

Code folding for function bodies, struct definitions, impl blocks, and other multi-line constructs.

### 9. Diagnostics

Real-time error reporting as you type, powered by the Yo evaluator.

## Setup

There is nothing to set up at the moment — no server binary exists to point an editor at.

Installing the Yo extension from the VS Code marketplace still gives you syntax highlighting, and the extension is built with `npm run package` inside `vscode-extension/` (it is a deliberate npm-only carve-out). But it no longer bundles a language client, and the old stdio entry point — `node out/cjs/yo-lsp.cjs --stdio`, for editors other than VS Code — went away with the TypeScript build.

## Implementation Details

### Dirty Buffer Support

When the buffer has unsaved/incomplete code (e.g., `p.` or `Option(i32).`), the LSP uses a multi-level fallback strategy:

1. **Current module** — attempt evaluation of the latest text
2. **Last good module** — fall back to the most recent successful evaluation
3. **Text-based resolution** — parse the text before the cursor to resolve types without evaluation

This ensures completions and hover remain available even while typing incomplete expressions.

### Module Caching

The LSP maintains a "last good module" cache. When the user is typing (e.g., `p2.`), the incomplete expression may cause evaluation errors. The server falls back to the last successful evaluation to provide completions.

### Trait Field Snapshots

When a module is re-evaluated, `deleteModule` mutates shared type objects (clearing impl-added trait fields). The LSP snapshots all trait field arrays before deletion and restores them for the cached module, ensuring method completions remain available.

### Generic Impl Resolution

Methods from generic `impl` blocks (e.g., `impl(generic(T), Option(T), ...)`) are resolved through the global `genericImplRegistry`. The LSP enumerates these to provide completions for types like `ArrayList`, `Option`, `Result`, and `HashMap`.

### Doc Comment Propagation

Doc comments (`///`) are extracted during lexing, associated with declarations via `docCommentLookup`, and propagated through:

- Struct field evaluation → `TypeField.docComment`
- Module field evaluation → `TypeField.docComment`
- Impl field evaluation → `TraitField.docComment`
- `attachTraitToReceiverType()` → copies doc comments to receiver types

## Testing

The LSP test suite lived in `src/tests/lsp.test.ts` and was deleted with the TypeScript tree; nothing covers this surface today. The cases below are the coverage a replacement has to reproduce:

- Struct field completion
- Enum variant completion (value and type level, with snippet insertions)
- Module member completion (with doc comments)
- Array `.len` completion
- Impl method completion (with parameter snippet placeholders)
- Type-level completion (static methods)
- Self-completion inside methods
- Prelude type completion (e.g., `Option` methods)
- Result type completion (methods and enum variants)
- Nested struct field completion
- Dirty buffer dot-completion (type constructors, simple variables)
- Keyword completion
- Variable, type, and function hover
- Impl field label hover
- Hover fallback on dirty buffers
- Go-to-definition for variables, import paths, and enum variants
- Import path completion (std library and subdirectories)
- Environment-based identifier completion (prelude types, imported symbols)
- Generic type method completion (`Option(i32).`, `Result(T,E).`)
