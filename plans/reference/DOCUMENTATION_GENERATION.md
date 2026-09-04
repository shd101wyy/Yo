# Documentation Generation for Yo

## Problem

Yo has no standard way to generate API documentation from source code. Developers writing libraries and applications need a way to:

1. Write structured doc comments in `.yo` files
2. Extract those comments and associate them with declarations
3. Generate browsable HTML documentation (like Rust's `rustdoc` or TypeScript's `typedoc`)

The standard library already uses `///` and `/** */` comment conventions informally, but these are discarded during parsing and never reach the AST.

## Current State

### What we have

- **Lexer** preserves comments as tokens (`SingleLineComment`, `MultiLineComment`) with full text and position info
- **Parser** skips all comments via `skipWhitespace()` — they never reach the AST
- **AST** has an unused `comment?: string` field on `EvaluatedExprData` (expr.ts:281)
- **Standard library** already uses doc comment conventions:
  - `///` triple-slash for single-line doc comments (prelude.yo traits, builtins)
  - `/** ... */` JSDoc-style blocks for multi-line descriptions (array_list.yo, hash_map.yo, etc.)
- **BUILD_SYSTEM.md** section 11.2.6 already proposes this feature with output to `yo-out/doc/`

### What's missing

- No doc comment extraction or association with declarations
- No documentation data model
- No rendering pipeline (HTML/Markdown)
- No CLI command or build system integration

## Design Decisions

### Doc comment syntax

Use both existing conventions, consistent with what the std library already does:

````rust
//! This module provides core collection types.
//! It is part of the Yo standard library.

/// Single-line doc comment (outer — attaches to next declaration).
/// Multiple consecutive lines are merged into one doc block.
Comptime :: trait(id := "Comptime");

/**
 * Multi-line doc comment block (outer).
 *
 * Supports **Markdown** formatting:
 * - Lists
 * - `code spans` and auto-linked types like `Option`
 * - [links](https://example.com)
 *
 * ## Examples
 *
 * ```rust
 * (x : i32) = i32(42);
 * ```
 */
ArrayList :: (fn(comptime(T): Type) -> comptime(Type))(...);
````

**Outer doc comments** (attach to the next declaration):

- `///` — single-line outer doc comment. `//` is a regular comment (ignored).
- `/** ... */` — multi-line outer doc comment. `/* ... */` is a regular comment (ignored).

**Inner doc comments** (attach to the enclosing item — module, struct, trait):

- `//!` — single-line inner doc comment. Used at the top of a file for module-level docs.
- `/*! ... */` — multi-line inner doc comment. Also for module-level docs.

This matches Rust's doc comment syntax exactly.

**Rules:**

- Outer doc comments attach to the **next** declaration (forward association).
- Inner doc comments attach to the **enclosing** item (the module/file itself, or a struct/trait body).
- Content is parsed as Markdown (like rustdoc).
- Leading `*` and whitespace in `/** */` / `/*! */` blocks are stripped (JSDoc convention).
- Backtick references (`` `TypeName` ``) auto-link to the referenced item's doc page (cross-module linking).

### `yo doc` CLI command vs build system step

**Decision: Both — `yo doc` as primary, build system for advanced configuration.**

#### Evaluation

| Criterion             | `yo doc` CLI            | `build.doc()` step              |
| --------------------- | ----------------------- | ------------------------------- |
| Zero-config           | ✅ Just works           | ❌ Requires build.yo            |
| Discoverability       | ✅ `yo --help` shows it | ❌ Hidden in build config       |
| Customization         | ⚠️ CLI flags only       | ✅ Full programmatic control    |
| Build DAG integration | ❌ Standalone           | ✅ Can depend on/be depended on |
| Works on single files | ✅ `yo doc file.yo`     | ❌ Project-level only           |

#### Approach

1. **`yo doc`** — The primary command. Works on any project or file with zero configuration. Produces HTML documentation in `yo-out/doc/` by default.

2. **`build.doc()` step (future)** — For projects needing custom output directories, filtered modules, themes, or integration with other build steps. Invokes the same underlying doc engine. This is a follow-up enhancement.

3. **No `yo build doc` alias initially** — Avoid confusion. `yo doc` is the command. Build system integration comes later via `build.doc()` step kind.

### Output format

- **Primary**: Fully offline static HTML site (self-contained, zero external dependencies)
  - All CSS/JS inlined or bundled — no CDN links, no external fonts, no network requests
  - Module index page
  - Per-module pages with all exported declarations
  - Search (client-side, JSON index embedded in the page)
  - Sidebar navigation
  - Works from `file://` URLs (open `index.html` directly in browser)
- **Secondary**: JSON intermediate representation (allows custom renderers)
- **Style**: Clean, minimal — inspired by Rust docs but simpler. System font stack only.

### Markdown rendering: `markdown_yo` (WASM)

Doc comments are Markdown. We use **[markdown_yo](https://github.com/shd101wyy/markdown_yo)** — a high-performance Markdown-to-HTML converter written in Yo, compiled to WASM and published as `npm install markdown_yo@0.0.4`.

**Build-time rendering** (primary):

- `yo doc` imports `markdown_yo` as an npm dependency
- Calls `createRenderer()` → `md.render(docComment, { html: true, fullFeatures: true })` to pre-render all doc comments to HTML
- Output pages contain fully rendered HTML — no JS required to read docs
- This is Yo dogfooding its own ecosystem!

**Client-side bundle** (for interactive features):

- The `markdown_yo_wasm_api.js` + `.wasm` files (~383 KB) are bundled in the doc site
- Powers live search result previews and rendering
- Future: interactive code examples, editable doc preview

This means:

- No external Markdown library needed (no `marked`, `markdown-it`, etc.)
- Full CommonMark compatibility (98.7% spec) + extensions (math, emoji, admonitions, etc.)
- Syntax highlighting for code blocks in doc comments (via `markdown_yo`'s built-in support or a separate pass)

### Scope of documented items

Only **exported** declarations are documented by default. Internal declarations can be included with `--document-private` flag.

Documentable items:

- Functions (`fn`)
- Types (`struct`, `object`, `enum`, `newtype`, `union`)
- Traits (`trait`)
- Modules (`module`)
- Constants (top-level `::` bindings with comptime values)
- Trait implementations (`impl`) — listed on the type's page
- Re-exports (`export`)

## Architecture

```
.yo source files
       │
       ▼
  ┌─────────────┐
  │   Lexer      │  ← Already tokenizes comments
  └──────┬──────┘
         │ tokens (with comment tokens)
         ▼
  ┌─────────────┐
  │  Doc Comment │  ← NEW: Extract & associate doc comments
  │  Extractor   │    with declarations from token stream
  └──────┬──────┘
         │ DocItem[]
         ▼
  ┌─────────────┐
  │  Evaluator   │  ← Existing: provides type info
  │  (type info) │    for documented declarations
  └──────┬──────┘
         │ enriched DocItem[] with types
         ▼
  ┌─────────────┐
  │  Doc Model   │  ← NEW: Structured documentation IR
  │  Builder     │    (modules, types, functions, traits)
  └──────┬──────┘
         │ DocModel (JSON-serializable)
         ▼
  ┌─────────────┐
  │  Renderer    │  ← NEW: Generates HTML/Markdown
  │  (HTML)      │    from DocModel
  └─────────────┘
         │
         ▼
    yo-out/doc/
```

### Key components

#### 1. Doc Comment Extractor (`src/doc/extractor.ts`)

Operates on the **token stream** (before parsing). Scans for doc comment tokens (`///` and `/** */`) and associates them with the next non-comment, non-whitespace token's position.

```typescript
interface RawDocComment {
  content: string; // Stripped markdown content
  position: TokenPosition; // Source location
  kind: "line" | "block"; // /// vs /** */
}

interface DocAssociation {
  comment: RawDocComment;
  declarationName: string; // The identifier that follows
  declarationPosition: TokenPosition;
}
```

The extractor doesn't need to understand the full AST — it does a lightweight token-level scan:

1. Find doc comment tokens
2. Skip whitespace tokens forward
3. Record the next identifier token as the associated declaration

#### 2. Doc Model (`src/doc/model.ts`)

The intermediate representation for documentation, produced by combining doc comments with evaluator type information.

```typescript
interface DocModule {
  name: string;
  path: string; // Module file path
  description?: string; // Module-level doc comment (top of file)
  functions: DocFunction[];
  types: DocType[];
  traits: DocTrait[];
  constants: DocConstant[];
  reExports: DocReExport[];
}

interface DocFunction {
  name: string;
  doc?: string;
  signature: string; // Human-readable type signature
  parameters: DocParam[];
  returnType: string;
  effects?: string[]; // using(...) effect parameters
  typeParams?: string[]; // forall(...) type parameters
  isExported: boolean;
}

interface DocType {
  name: string;
  doc?: string;
  kind: "struct" | "object" | "enum" | "newtype" | "union";
  typeParams?: string[];
  fields?: DocField[]; // For struct/object
  variants?: DocVariant[]; // For enum
  methods: DocFunction[]; // From impl blocks
  traitImpls: string[]; // Names of implemented traits
}

interface DocTrait {
  name: string;
  doc?: string;
  typeParams?: string[];
  associatedTypes?: DocAssociatedType[];
  methods: DocFunction[]; // Required methods
  implementors: string[]; // Types that implement this trait
}
```

#### 3. Type Info Integration

After extraction, the doc generator runs the evaluator on each module to get type information. This provides:

- Resolved type signatures (with generics expanded)
- Impl block association (which methods belong to which type)
- Trait implementation lists
- Export visibility

The evaluator already computes all of this. We need a mode that evaluates types without generating C code — effectively the existing evaluator with codegen skipped.

#### 4. HTML Renderer (`src/doc/render-html.ts`)

Generates static HTML pages. Uses template strings (no external templating library — keep dependencies minimal).

Page structure:

- `index.html` — Module index with search
- `module/<name>.html` — Per-module page
- `type/<name>.html` — Per-type page (with methods, trait impls)
- `trait/<name>.html` — Per-trait page (with implementors)
- `search-index.json` — Client-side search data
- `style.css` — Styling
- `search.js` — Minimal search script

#### 5. Markdown Renderer (`src/doc/render-markdown.ts`)

Alternative output for embedding in READMEs or other docs.

### CLI interface

```
yo doc [path]              # Generate docs for project or file
  --output, -o <dir>       # Output directory (default: yo-out/doc)
  --format <html|markdown|json>  # Output format (default: html)
  --version <version>      # Release version (auto-detects from git if omitted)
  --document-private       # Include non-exported declarations
  --no-deps                # Don't document dependencies
  --open                   # Open in browser after generation
  --module <name>          # Document specific module only
```

## Implementation Plan

### Phase 1: Doc Comment Extraction ✅

- Define doc comment syntax rules (distinguish `///` from `//`, `/** */` from `/* */`, plus inner `//!` and `/*! */`)
- Build token-level doc comment extractor
- Associate outer doc comments with declarations via token position
- Associate inner doc comments (`//!`, `/*! */`) with their enclosing module/item
- Strip comment syntax (`///`, `//!`, `/** */`, `/*! */`, leading `*`) and produce clean Markdown
- Handle consecutive `///` lines merging into a single doc block
- Handle module-level doc comments (top-of-file `///!` or `/**! */`, or just the first `/** */` before any declaration)
- Unit tests for extraction (29 tests)

### Phase 2: Doc Model & Type Integration ✅

- Define `DocModule`, `DocFunction`, `DocType`, `DocTrait` etc. data model
- Run evaluator on source files to get type information
- Walk evaluated declarations and match with extracted doc comments
- Resolve type signatures to human-readable strings via `typeToString`
- Collect impl blocks and associate methods with their types
- Build cross-references (trait → implementors, type → traits)
- Handle generic types, effects, associated types in signatures
- Unit tests for model building (15 tests)

### Phase 3: HTML Renderer ✅

- Added `markdown_yo@0.0.4` as npm dependency
- Page templates: module index (card grid), per-module detail page
- HTML generation from DocModel with all item types
- `markdown_yo` WASM API renders Markdown doc content to HTML at build time
- Client-side search via embedded JSON index
- Fully offline: all CSS/JS inlined, system fonts, no CDN
- Dark mode via `prefers-color-scheme` media query
- Responsive design with mobile breakpoint
- Unit + integration tests (22 tests)

### Phase 4: CLI Integration ✅

- Added `yo doc [path]` command to `src/yo-cli.ts`
- `src/doc-command.ts` orchestrates file discovery → evaluation → extraction → rendering
- Options: `-o` output dir, `--name` project name, `--document-private`, `-v` verbose
- Auto-discovers `.yo` files (skips test files, build files, hidden dirs)
- Infers project name from package.json, build.yo, or directory name
- Reports timing and item counts

### Phase 5: Additional Output Formats ✅

- Markdown renderer: `src/doc/render-markdown.ts` → `README.md` + `module/<name>.md`
- JSON renderer: `src/doc/render-json.ts` → `doc.json`
- `--format` / `-f` CLI flag: `html` (default), `markdown`, `json`
- Format field added to `DocConfig` in `std/build.yo` and `BuildDocConfig` interface
- 19 new tests (15 markdown + 4 JSON)

### Phase 6: Build System Integration ✅

- Added `StepKind.Documentation` to `std/build.yo`
- `build.doc(config)` function with `DocConfig` struct
- Handle doc step in `build-runner.ts` (serialized with artifacts)
- `yo build doc` runs the configured doc step
- `yo init` generates `build.yo` with doc step included

#### `build.doc()` API design

Following the existing patterns in `std/build.yo` (config structs with defaults, returns `Step`):

```rust
// ── Doc output formats ───────────────────────────────────────────────

DocFormat :: enum(
  Html,
  Markdown,
  Json
);
export DocFormat;

// ── Doc config struct ────────────────────────────────────────────────

DocConfig :: struct(
  name : comptime_string,                        // Step name (e.g., "doc")
  root : comptime_string,                        // Root source file or directory
  (output : comptime_string) ?= "yo-out/doc",    // Output directory
  (format : DocFormat) ?= DocFormat.Html,         // Output format
  (include_private : bool) ?= false,             // Document non-exported items
  (include_deps : bool) ?= false,                // Document dependencies too
  (title : comptime_string) ?= "",                // Custom site title (default: project name)
  (version : comptime_string) ?= "",              // Release version (auto-detects from git if empty)
  (logo : comptime_string) ?= "",                 // Path to logo image
  (favicon : comptime_string) ?= ""               // Path to favicon
);
export DocConfig;

// Register a documentation generation step.
doc :: (fn(comptime(config) : DocConfig) -> comptime(Step)) {
  fmt_str :: match(config.format,
    .Html => "html",
    .Markdown => "markdown",
    .Json => "json"
  );
  __yo_build_doc(
    config.name, config.root, config.output, fmt_str,
    config.include_private, config.include_deps,
    config.title, config.logo, config.favicon,
    config.version
  );
  Step(name: config.name, kind: StepKind.Documentation)
};
export doc;
```

**Usage in `build.yo`:**

```rust
build :: import "std/build";

// Minimal — just works with defaults
doc_step :: build.doc({ name: "doc", root: "./src/lib.yo" });

// Full customization
doc_step :: build.doc({
  name: "doc",
  root: "./src/lib.yo",
  output: "docs/api",
  format: build.DocFormat.Markdown,
  include_deps: true,
  title: "My Library API",
  version: "v1.0.0",
  logo: "./assets/logo.png"
});

// Wire into build DAG
install :: build.step("install", "Build all artifacts");
install.depend_on(doc_step);  // Docs generated as part of install

// Or standalone
// yo build doc
```

**Relationship with `yo doc`:**

- `yo doc` is the zero-config CLI command (no `build.yo` needed). It auto-discovers source files and uses sensible defaults.
- `build.doc()` is for projects that want custom doc generation integrated into their build pipeline.
- Both use the same underlying doc engine (`src/doc/`).
- `yo build doc` invokes the `build.doc()` step. `yo doc` invokes the engine directly.

**`StepKind.Documentation` vs `StepKind.Custom`:**

Adding a dedicated `StepKind.Documentation` (rather than reusing `Custom`) lets `build-runner.ts` dispatch to the doc generation engine directly, with typed config. Custom steps are opaque; Documentation steps carry `DocConfig` metadata that the build runner interprets.

## Open Questions

1. **Doc comment sections**: Should we support Rust-style sections like `# Examples`, `# Panics`, `# Errors`, `# Safety`? Or keep it freeform Markdown?

2. **Inline type rendering**: For complex generic types like `fn(forall(T: Type), x: T, using(io: Io)) -> Impl(Future(Result(T, E), Io))`, how much should we simplify in the rendered signature?

3. **Doc tests**: Should code blocks in doc comments be extractable as tests (like Rust's `cargo test` running doc examples)? This could be a future phase.

## References

- Rust `rustdoc`: https://doc.rust-lang.org/rustdoc/
- TypeScript `typedoc`: https://typedoc.org/
- Go `godoc`/`pkgsite`: https://pkg.go.dev/
- Zig `autodoc`: https://ziglang.org/documentation/
- BUILD_SYSTEM.md section 11.2.6
