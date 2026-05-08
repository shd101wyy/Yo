---
applyTo: "docs/**,src/doc/**"
description: "Use when writing or editing documentation files, or working on the doc generation system. Covers bilingual requirements, code block formatting, yo doc CLI, and the doc pipeline."
---

# Documentation Conventions

## Bilingual documentation

All documentation in `docs/` must exist in both languages:

- English: `docs/en-US/`
- Chinese: `docs/zh-CN/`

When creating or updating a doc, always update both versions.

## Code block language tag

Use ` ```rust ` (not ` ```yo `) for Yo language code blocks in Markdown files. Rust syntax highlighting renders better on GitHub.

## API Documentation Generation

### Doc comment syntax

**Outer doc comments (`///`) — for items:**

````rust
/// Brief description of this function.
///
/// More detailed explanation here.
///
/// ## Parameters
/// - `name` — description of the parameter
///
/// ## Returns
/// Description of return value.
///
/// ## Examples
/// ```rust
/// my_fn(42)
/// ```
fn_name :: (fn(name: i32) -> i32)(...);
````

**Inner doc comments (`//!`) — for modules:**

```rust
//! Module for handling collections.
//!
//! Provides efficient list and map implementations.
```

### `yo doc` CLI command

```bash
yo doc [path]                    # Document file or directory (default: cwd)
yo doc ./src/                    # All .yo files in directory
yo doc -o docs                   # Custom output directory (default: yo-out/doc)
yo doc --title "My Project"      # Set doc site title
yo doc --format html|markdown|json  # Output format (default: html)
yo doc --version v1.0.0          # Release version (auto-detects from git if omitted)
yo doc --document-private        # Include non-exported items
```

### `build.doc()` build step

In `build.yo`, use `build.doc()` to add a documentation generation step:

```rust
build :: import("std/build");

docs :: build.doc({ name: "docs", root: "./src" });
doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);
```

Then run: `yo build doc`

### Doc pipeline architecture

```
Source .yo files
  → Lexer (tokenize)
  → Extractor (src/doc/extractor.ts) — extracts /// and //! comments
  → Builder (src/doc/builder.ts) — combines comments + evaluator type info → DocModel
  → Renderer — converts DocModel to output:
      render-html.ts   → static HTML site
      render-markdown.ts → Markdown files
      render-json.ts   → JSON export
```

### Key files

| File                         | Role                                             |
| ---------------------------- | ------------------------------------------------ |
| `src/doc-command.ts`         | `yo doc` CLI entry point                         |
| `src/doc/extractor.ts`       | Extracts doc comments from source tokens         |
| `src/doc/builder.ts`         | Builds DocModel from comments + evaluator output |
| `src/doc/model.ts`           | DocModel TypeScript interfaces                   |
| `src/doc/sections.ts`        | Parses ## Returns, ## Examples, etc.             |
| `src/doc/render-html.ts`     | Renders DocModel to static HTML site             |
| `src/doc/render-markdown.ts` | Renders DocModel to Markdown                     |
| `src/doc/render-json.ts`     | Exports DocModel as JSON                         |

### Internal symbol filtering

Doc generation automatically filters:

- `__yo_*` prefixed symbols (compiler builtins)
- `___` prefixed symbols (internal implementation details)
- Non-exported items (unless `--document-private`)

### Type classification in docs

- Functions returning `comptime(Trait)` → classified under **Traits / Modules**
- Functions returning `comptime(Type)` with type params → classified as **type-function**
- Direct module values → classified under **Traits / Modules**
