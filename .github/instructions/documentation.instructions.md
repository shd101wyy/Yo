---
applyTo: "docs/**,src/doc/**,src/doc/**"
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
  → Extractor (src/doc/extractor.yo) — extracts /// and //! comments
  → Builder (src/doc/builder.yo) — combines comments + evaluator type info → DocModel
  → Renderer — converts DocModel to output:
      render_html.yo     → static HTML site
      render_markdown.yo → Markdown files
      render_json.yo     → JSON export
```

### Key files

| File                              | Role                                             |
| --------------------------------- | ------------------------------------------------ |
| `src/doc_command.yo`          | `yo doc` CLI entry point                         |
| `src/doc/extractor.yo`        | Extracts doc comments from source tokens         |
| `src/doc/builder.yo`          | Builds DocModel from comments + evaluator output |
| `src/doc/model.yo`            | DocModel type definitions                        |
| `src/doc/sections.yo`         | Parses ## Returns, ## Examples, etc.             |
| `src/doc/render_html.yo`      | Renders DocModel to static HTML site             |
| `src/doc/render_html_assets.yo` | Inlined CSS/JS assets for the HTML site        |
| `src/doc/render_markdown.yo`  | Renders DocModel to Markdown                     |
| `src/doc/render_json.yo`      | Exports DocModel as JSON                         |

### Internal symbol filtering

Doc generation automatically filters:

- `__yo_*` prefixed symbols (compiler builtins)
- `___` prefixed symbols (internal implementation details)
- Non-exported items (unless `--document-private`)

### Type classification in docs

- Functions returning `comptime(Trait)` → classified under **Traits / Modules**
- Functions returning `comptime(Type)` with type params → classified as **type-function**
- Direct module values → classified under **Traits / Modules**
