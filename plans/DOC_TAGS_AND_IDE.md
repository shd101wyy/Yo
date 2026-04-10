# Doc Comments & IDE Integration

## Problem

Yo's doc generation pipeline (Phases 1-6) extracts and renders doc comments, but:

1. **No structured parameter/field/variant docs** — the doc comment text is treated as opaque markdown. There's no way to document individual function parameters, struct fields, or enum variants.
2. **No IDE integration** — the VS Code extension shows type/value info on hover but ignores doc comments entirely. Completions have no documentation.
3. **Doc renderers can't create per-parameter docs** — the HTML/Markdown renderers show function signatures but can't annotate individual parameters with descriptions.

## Approach: Inline `///` Everywhere

We use **inline `///` doc comments** as the single, unified mechanism for documenting everything — function parameters, struct fields, enum variants, trait methods. No `@tags` (no `@param`, `@field`, `@variant`). This matches Rust's approach but extends it to work inside `fn(...)` parameter lists too.

The Yo parser already skips doc comment tokens as whitespace everywhere (including inside `struct(...)`, `enum(...)`, and `fn(...)` definitions), so inline `///` compiles without changes today.

### Function parameters

```rust
/// Creates a connection pool.
///
/// ## Returns
///
/// A pool instance, or error if configuration is invalid.
///
/// ## Panics
///
/// Panics if the global allocator is exhausted.
createPool :: (fn(
  /// Maximum number of connections (must be > 0).
  max_size: u32,
  /// Connection timeout in milliseconds.
  timeout: u32
) -> Result(Pool, PoolError))( ... );
```

### Struct fields

```rust
/// A 2D point in Cartesian space.
Point :: struct(
  /// The x coordinate.
  x : f64,
  /// The y coordinate.
  y : f64
);
```

### Enum variants

```rust
/// Represents a geometric shape.
Shape :: enum(
  /// A circle with the given radius.
  Circle(
    /// The radius of the circle.
    radius : f64
  ),
  /// A rectangle defined by width and height.
  Rectangle(
    /// The width.
    width : f64,
    /// The height.
    height : f64
  )
);
```

### Trait methods

```rust
/// An iterator over a collection.
Iterator :: trait(
  /// The type of elements yielded by this iterator.
  Item : Type,
  /// Advances the iterator and returns the next value.
  next : (fn(self: *(Self)) -> Option(Self.Item))
);
```

### Module-level docs

```rust
//! This module provides string manipulation utilities.
//!
//! ## Examples
//!
//! (code examples here)
```

### Free-form markdown sections

The outer doc comment (on the declaration) uses standard markdown headings for structured content:

- `## Returns` — return value description
- `## Errors` — error conditions (for Result-returning functions)
- `## Panics` — panic conditions
- `## Safety` — safety requirements
- `## Examples` — code examples
- `## Deprecated` — deprecation notice and migration guide

These sections are parsed by splitting on `##` headings, which is simple and reliable.

### Design decisions

- **No `@tags` at all** — inline `///` is the single mechanism. Simpler, consistent, no tag parser needed.
- **Types not documented in comments** — types are already in the signature. Doc comments describe semantics, not types.
- **Markdown sections for function-level docs** — `## Returns`, `## Errors`, etc. are parsed by heading, not by tag prefix.
- **First paragraph is the summary** — used in search results, completion items, and index pages.

---

## Architecture

```
Token stream (from lexer)
        │
        ▼
  Inline Doc Extractor (enhanced src/doc/extractor.ts)
        │
        ├──▶ Outer doc → declaration name mapping (existing)
        ├──▶ Inner doc → module doc (existing)
        └──▶ Inline doc → field/param/variant mapping (NEW)
                │
                ▼
          Section Parser (src/doc/sections.ts)    ← NEW: parse ## headings
                │
                ▼
          ParsedDocComment                         ← summary + sections
                │
                ├──▶ DocModel builder              ← populate per-param/field/variant docs
                ├──▶ HTML renderer                 ← render sections, param tables
                ├──▶ Markdown renderer             ← render sections
                └──▶ JSON renderer                 ← include sections in JSON

Evaluator (initialization-assignment.ts)
        │
        ├──▶ EvaluatedExprData.docComment          ← attach doc to AST nodes
        │
        └──▶ Variable.docComment                   ← attach doc to env variables
                  │
                  ▼
           VS Code extension
                  │
                  ├──▶ Hover provider              ← show doc in hover tooltip
                  └──▶ Completion items            ← show doc in autocomplete
```

---

## Phases

### Phase 1: Inline Doc Extraction for Fields/Params/Variants

Enhance `src/doc/extractor.ts` to extract `///` doc comments from inside `struct(...)`, `enum(...)`, and `fn(...)` definitions.

**New types**:

```typescript
interface InlineDocComment {
  /** Cleaned doc comment content */
  content: string;
  /** Name of the field/param/variant this documents */
  targetName: string;
  /** Position of the doc comment token */
  position: Token["position"];
}

interface InlineDocResult {
  /** Per-field/param/variant doc comments, keyed by name */
  docs: Map<string, string>;
}
```

**New function**: `extractInlineDocs(tokens: Token[], startIndex: number, endIndex: number): InlineDocResult`

- Scans tokens between matching `(` `)` of a struct/enum/fn definition
- For each `DocLineComment` or `DocBlockComment` token found, associates it with the next `Identifier` token
- Handles consecutive `///` lines (joins them)
- Returns a map of name → doc content

**How it works**:

1. Given a token range (e.g., the tokens inside `struct(...)`), iterate through
2. When a `DocLineComment` is found, accumulate consecutive doc comment lines
3. Skip whitespace tokens
4. The next `Identifier` token is the field/param/variant name
5. Associate the accumulated doc comment with that name

**Tests**: Add to `src/doc/extractor.test.ts`

### Phase 2: Section Parser (`src/doc/sections.ts`)

Create a lightweight section parser that splits doc comment markdown by `##` headings.

```typescript
interface ParsedDocComment {
  /** First paragraph — used as summary */
  summary: string;
  /** Full description (everything before first ## heading) */
  description: string;
  /** Named sections keyed by heading (lowercase) */
  sections: Map<string, string>;
}
```

**Parsing rules**:

- Everything before the first `##` heading is the description
- The first paragraph of the description (up to the first blank line) is the summary
- `## Returns`, `## Errors`, `## Panics`, `## Examples`, `## Safety`, `## Deprecated` are parsed as named sections
- Section content continues until the next `##` heading or end of text
- Section keys are lowercased for lookup: `sections.get("returns")`

This is much simpler than a full tag parser — just split on `##` headings.

**Tests**: `src/doc/sections.test.ts`

### Phase 3: Integrate into DocModel + Renderers

**DocModel changes** (`src/doc/model.ts`):

```typescript
// Add to DocParam:
interface DocParam {
  // ... existing fields ...
  doc?: string; // NEW: from inline /// above parameter
}

// DocField.doc already exists
// DocVariant.doc already exists

// Add to DocFunction:
interface DocFunction {
  // ... existing fields ...
  returns?: string; // NEW: from ## Returns section
  errors?: string; // NEW: from ## Errors section
  deprecated?: string; // NEW: from ## Deprecated section
  examples?: string[]; // NEW: from ## Examples section
  parsedDoc?: ParsedDocComment; // NEW: full parsed doc
}

// Add to DocType, DocTrait, DocConstant:
interface DocType {
  // ... existing fields ...
  deprecated?: string; // NEW
  examples?: string[]; // NEW
}
```

**Builder changes** (`src/doc/builder.ts`):

- When building `DocFunction`, call `extractInlineDocs()` on the fn parameter tokens to get per-param docs
- When building `DocType` (struct/enum), call `extractInlineDocs()` on the struct/enum body tokens to get per-field/variant docs
- Parse the outer doc comment with `parseDocComment()` to extract sections
- Populate the new model fields

**Renderer changes**:

HTML renderer (`render-html.ts`):

- Show parameter docs in a styled table alongside parameter types
- Show `## Returns` / `## Errors` / `## Deprecated` as rendered sections
- Show `## Examples` code blocks with syntax highlighting
- Show deprecated items with a warning banner

Markdown renderer (`render-markdown.ts`):

- Add "Parameters" table with doc descriptions
- Render sections naturally (they're already markdown)
- Prefix deprecated items with ⚠️

JSON renderer (`render-json.ts`):

- Include all new fields in JSON output

### Phase 4: Evaluator Doc Comment Propagation

Make the evaluator attach doc comments to AST nodes and variables during evaluation, so the VS Code extension can access them.

**Changes to `src/expr.ts`**:

- Repurpose existing unused `comment?: string` field on `EvaluatedExprData` for doc comments (rename to `docComment` for clarity)

**Changes to `src/env.ts`**:

```typescript
interface Variable {
  // ... existing fields ...
  docComment?: string; // Doc comment for this declaration
}
```

**Evaluator changes** (`src/evaluator/exprs/initialization-assignment.ts`):

- When evaluating a declaration (`x :: expr` or `x := expr`), scan backwards from the declaration token in the token stream
- Find immediately preceding `DocLineComment` / `DocBlockComment` tokens
- Strip and clean using existing `stripDocLineComment` / `stripDocBlockComment`
- Store on `variable.docComment`

**Key approach**: The evaluator already has access to tokens via `getTokens()`. For each declaration, we scan backwards from `variable.token` (or `variable.initializedAtToken`) to find doc comment tokens. The existing strip functions from `src/doc/extractor.ts` handle cleaning.

### Phase 5: VS Code Hover + Completion Integration ✅

Update the VS Code extension to display doc comments.

**Hover provider changes** (`vscode-extension/src/extension.ts`):

- Added `varDocComment` tracking alongside other variable fields (`varType`, `varValue`, etc.)
- After the closing code block, appends doc comment markdown with a horizontal rule separator
- Falls back to `expr.$?.docComment` if variable lookup has no doc comment

**Completion provider changes**:

- `createCompletionItem` now looks up `variable.docComment` from the environment
- Falls back to `bestCandidate.$?.docComment` from the expression
- Shows doc comment as `MarkdownString` with `supportHtml = true`
- Falls back to value display when no doc comment is available

---

## Phase Summary

| Phase | Description                                      | Files                                  | Tests                       | Status |
| ----- | ------------------------------------------------ | -------------------------------------- | --------------------------- | ------ |
| 1     | Inline doc extraction for fields/params/variants | `src/doc/extractor.ts`                 | `src/doc/extractor.test.ts` | ✅     |
| 2     | Section parser (## headings)                     | `src/doc/sections.ts`                  | `src/doc/sections.test.ts`  | ✅     |
| 3     | DocModel + renderer integration                  | `model.ts`, `builder.ts`, renderers    | Update existing tests       | ✅     |
| 4     | Evaluator doc propagation                        | `src/expr.ts`, `src/env.ts`, evaluator | New tests                   | ✅     |
| 5     | VS Code hover/completion                         | `vscode-extension/src/extension.ts`    | Manual testing              | ✅     |

---

## Notes

- The existing `comment?: string` field on `EvaluatedExprData` (line 281 of `expr.ts`) is declared but never populated. We'll repurpose it as `docComment`.
- The VS Code extension does NOT use LSP — it directly imports the evaluator. Doc comment data flows through the same `EvaluatedExprData` objects.
- The evaluator already preserves doc comment tokens in the token stream (Phase 1 of doc generation added `DocLineComment`, `InnerDocLineComment`, `DocBlockComment`, `InnerDocBlockComment` token types).
- The parser's `skipWhitespace()` already skips all doc comment token types, so inline `///` inside any `(...)` block works today without parser changes.
- Inline `///` inside `fn(...)` parameter lists has been verified to compile and run correctly.
