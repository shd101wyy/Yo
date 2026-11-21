---
applyTo: "docs/**,src/doc/**"
description: "Use when writing or editing documentation files, or working on the doc generation system. Covers bilingual requirements, code block formatting, yo doc CLI, and the doc pipeline."
---

# Documentation Conventions

## User docs

- Every doc under `docs/` exists in both `docs/en-US/` and `docs/zh-CN/`; update both together.
- User-facing text describes only the current language: `docs/`, both READMEs (`README.md`, `docs/zh-CN/README.md`), `pack/context.md`, diagnostic messages and `yo explain` text. No history, no removed features, no migration or upgrade guidance (Yo has no external users). `plans/` and `issues/` stay historical.

## Code block language tag

- Fence Yo code ` ```yo `, in Markdown and in `///` / `//!` doc comments alike. Never ` ```rust ` for Yo code.
- `yo fmt` formats every ` ```yo ` block (`yo fmt docs`; a `.yo` file's doc comments with the file). CI runs `yo fmt --check` over `docs/`, `plans/`, `.github/`, `README.md` and the Markdown under `issues/` (not `issues/repros/`), so a block must parse and be laid out the way `yo fmt` writes it.
- A fragment, an intentionally invalid "WRONG:" example or an error demo (`a + b * c`) is fenced ` ```yo ignore `: the tag stays, the check is skipped.
- `yo doc --format markdown` emits ` ```rust ` in its generated pages (GitHub has no Yo highlighting). That is the renderer's translation, not a convention for hand-written docs.

## Docs checks (`scripts/check-docs.py`)

CI's `docs-checks` job (`test.yml`) runs three checks over `docs/en-US`, `docs/zh-CN` and the READMEs. It is REPORT-ONLY for now (findings in the job log and summary, not on merge-gate's needs); the docs plan's last step makes it blocking.

- **examples**: a ` ```yo ` block containing `export(`, `test(` or `main ::` (comments aside) is a complete program and must pass the compiler: `yo test` when it has a top-level `test(` (`yo check` swallows test-body errors; its `--test-bodies` mode has known false positives), `yo check` otherwise. Each block is checked alone in an empty directory against the tree's `std`, so it imports what it uses (a test block imports `assert` from `std/assert`) and cannot import a sibling file. Other blocks are fragments: counted, not checked. ` ```yo ignore ` blocks are skipped and counted; a rising count gets questioned in review.
- **Expected errors**: a block demonstrating a compile error declares its codes in the fence (` ```yo expect=E0917 `, ` ```yo expect=E0917,E0901 `). It is always checked, and passes only if the compiler rejects it AND reports every listed code. It must still parse (`yo fmt` formats it); a snippet that does not parse or cannot stand alone stays ` ```yo ignore `.
- **links**: every relative link in `docs/**`, `README.md` and `CONTRIBUTING.md` resolves, and every `#anchor` names a heading (GitHub slug rules) or an `<a id>`. A link from `docs/en-US` to anything outside it is flagged: only that directory ships in a release bundle (`yo context --doc` prints it). Cite std as a code span (`std/collections/array-list`); do not cite plans or issues.
- **parity**: `docs/en-US` and `docs/zh-CN` hold the same pages, each pair with the same number of ` ```yo ` blocks and H2 headings; `docs/zh-CN/README.md` and `CONTRIBUTING.md` are compared with the root files.

```bash
python3 scripts/check-docs.py --checks links,parity        # seconds
python3 scripts/check-docs.py --changed origin/develop     # examples of the Markdown your branch changed
python3 scripts/check-docs.py --yo yo-out/x86_64-unknown-linux-gnu/bin/yo --jobs 6   # everything; take a heavy-lock slot
```

Each distinct block is checked once (en/zh copies share a result), about 10–20 s per block. Pass `--yo` a tree-built binary when the docs describe a language change the seed lacks.

## API documentation

### Doc comment syntax

`///` (or `/** ... */`) documents an item; `//!` (or `/*! ... */`) documents a module. Sections are parsed by `src/doc/sections.yo`.

````yo
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
/// ```yo
/// my_fn(42)
/// ```
fn_name :: (fn(name: i32) -> i32)(...);
````

```yo
//! Module for handling collections.
//!
//! Provides efficient list and map implementations.
```

Prefer `///` in new code. A block comment is still a doc comment, so a coverage script must not count only `///` lines.

### `yo doc` CLI

```bash
yo doc [path]                       # file or directory (default: cwd)
yo doc -o docs                      # output directory (default: yo-out/doc)
yo doc --title "My Project"         # site title
yo doc --format html|markdown|json  # default: html
yo doc --version v1.0.0             # release version (default: from git)
yo doc --document-private           # include non-exported items
yo doc --logo <path> --favicon <path>
yo doc ./std --std-path ./std       # document THIS tree's std
```

- **Pass `--std-path ./std` when documenting this tree's `std/`.** Otherwise the installed `yo` evaluates against its bundled std; a module that fails to evaluate makes `yo doc` exit non-zero (`doc: N of M module(s) failed to evaluate ...`) and write nothing. `--allow-token-only` accepts the degraded token-only docs instead. Never answer a coverage question from a degraded run; read the source.
- `--format html` imports `markdown-yo`, a `yo.toml` dependency: a fresh clone needs `yo install` first.

### Reading `yo doc` output for coverage

- A `///` on an impl member attaches to that type's member (`T.member`), so same-named members of two types keep their own prose.
- A trait-impl method without its own comment inherits the trait method's doc (`_inherit_trait_method_docs`, `src/doc/builder.yo`).
- A re-exported TYPE takes its docs from the declaring module (`_fill_re_exported_docs`, matched on name and signature). A re-exported function or constant does not: a barrel module (`std/string/index.yo`, …) lists it with no doc.

### `build.doc()` build step

```yo
build :: import("std/build");

docs :: build.doc(.{ name : "docs", root : "./src" });
doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);
```

Then run `yo build doc`.

### Pipeline and key files

Source → lexer → `src/doc/extractor.yo` (doc comments) → `src/doc/builder.yo` (comments + evaluator type info → `DocModel`, `src/doc/model.yo`) → a renderer.

| File                            | Role                                     |
| ------------------------------- | ---------------------------------------- |
| `src/doc-command.yo`            | `yo doc` CLI entry point                 |
| `src/doc/sections.yo`           | Parses `## Returns`, `## Examples`, etc. |
| `src/doc/render-html.yo`        | Static HTML site (Markdown via `markdown-yo`) |
| `src/doc/render-html-assets.yo` | Inlined CSS/JS assets                    |
| `src/doc/render-markdown.yo`    | Markdown output                          |
| `src/doc/render-json.yo`        | JSON export                              |

### What the docs include

- Filtered out: `__yo_*` symbols (compiler builtins), `___`-prefixed symbols, non-exported items (unless `--document-private`).
- Functions returning `comptime(Trait)` and direct module values are listed under **Traits / Modules**; functions returning `comptime(Type)` with type parameters are **type-functions**.
