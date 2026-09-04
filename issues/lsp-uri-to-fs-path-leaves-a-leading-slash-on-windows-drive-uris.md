# `uri_to_fs_path` strips exactly 7 bytes, so every Windows `file:///C:/…` document URI becomes the path `/C:/…`

## Status

**OPEN** — found 2026-09-04 during the std-API audit re-measurement of the
`url` row. **Severity: wrong-value** (on Windows: a document key that no other
part of the compiler agrees with, so open-buffer overlays and cache
invalidation silently miss). **Confirmed by code reading**, not by a Windows
run — the measurement host is macOS. The tree already documents this exact
failure mode elsewhere, see "Precedent" below.

## The defect

```rust
// src/lsp/server.yo:71-75
uri_to_fs_path :: (fn(uri : String) -> String)({
  (s : String) = uri.clone();
  if(s.starts_with(String.from("file://")), {
    s = s.substring(usize(7), s.len());
  });
```

A `file:` URI for an absolute path has an **empty authority**, so it carries
three slashes: `file:///home/u/a.yo` and `file:///C:/w/a.yo`. Stripping the
7-byte `file://` prefix leaves the leading `/` of the path, which is right on
POSIX (`/home/u/a.yo`) and wrong on Windows (`/C:/w/a.yo` — not a path any
Win32 call accepts).

`uri_to_fs_path` is on every document path: `src/lsp/server.yo:129`
(`_analyze_and_publish`, reached from `didOpen` and `didChange`) and
`src/lsp/server.yo:762` (`didClose`).

## Consequences (Windows)

The bad path is used as a **key**, and the two keys derived from it do not
match what the rest of the compiler produces:

- `mm_set_open_document(fs_path, text)` (`src/module_manager.yo:328`) records
  the editor's unsaved text under `/C:/w/a.yo`, while the loader looks the
  overlay up under the path it derives from its own canonical module URI —
  `fs_path := abs.replace("file://", "")` (`src/module_manager.yo:456`),
  i.e. `C:/w/a.yo`. The keys differ by one byte, `_open_doc_index`
  (`src/module_manager.yo:312`) compares them with `==`, and the overlay never
  hits: an edit to an imported file stays invisible until it is saved and the
  server restarted.
- `mm_invalidate_document(fs_path)` (`src/module_manager.yo:364`) builds
  `file://${fs_path}` = `file:///C:/w/a.yo` and asks `invalidate_module` for
  it, while the module cache is keyed `file://C:/w/a.yo`. The invalidation is
  a no-op, so Phase B1's "an edit to an imported file is visible to the next
  analysis" guarantee does not hold on Windows.

Paths that reach `Path.new` recover by accident — `Path` treats `C:` as a
drive segment and `ToString` re-emits it without the leading slash
(`std/path.yo:571-600`) — which is why a `file:///C:/…` document produces a
plausible-looking `file://C:/…` in an error message while the keys above stay
broken. Observed on macOS, where the same string handling runs.

Feed `yo lsp` a `didOpen` for `file:///C:/tmp/t.yo` whose text is
`{ helper } :: import("./missing.yo"); …` (the stdio driver in
`lsp-definition-uri-is-built-without-percent-encoding.md` does it in ten
lines) and it answers:

```
{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":"file:///C:/tmp/t.yo",
 "diagnostics":[{...,"message":"Failed to import module \"./missing.yo\":\nmodule not preloaded: file://C:/tmp/missing.yo"}]}}
```

Note the two spellings in one exchange. That message prints the module
cache's own lookup key (`src/evaluator/module_loader.yo:214`,
`module not preloaded: ${path}`), so it is direct evidence that the loader
keys this file `file://C:/tmp/…` — no leading slash — while
`mm_invalidate_document` would ask for `file:///C:/tmp/…`.

## Precedent — the compiler already knows this failure

`_mg_canon` (`src/expr_info.yo:876-897`) carries the same problem's fix and
documents it verbatim:

```rust
// Windows mixed forms measured diverging
// (2026-09-03, PR #396's windows legs): `file:///C:/a/b` strips to
// `/C:/a/b` while the CLI spelling `./x` prepends a backslashed cwd
// (`C:\a\b/x`) — the module-global registry (the capture exclusion and
// the C-name mangling both key on this) then missed on windows only.
```

with an explicit `has_drive` branch (`src/expr_info.yo:887`). A third copy,
`_lex_abs_path` (`src/evaluator/memory_safety.yo:141-155`), was bitten by a
neighbouring Windows path bug and now delegates to `Path`
(`issues/windows-lex-abs-path-voids-std-exemption.md`). `uri_to_fs_path` was
never given either treatment.

## Fix

Make `uri_to_fs_path` a real `file:` URI decoder rather than a 7-byte strip:

1. strip `file://`;
2. percent-decode (already done, `src/lsp/server.yo:76-111`);
3. **if what remains matches `/<letter>:` (optionally `/<letter>|`, the
   legacy spelling), drop the leading `/`** and normalize the drive letter's
   case;
4. return it.

Step 3 is the whole fix and is three lines; the `has_drive` test at
`src/expr_info.yo:887` is the shape to copy so both agree.

The better end state, and what the `url` audit row is for: one shared
`file:` URI ↔ path converter in `std/url` (or `std/path`) that all four
private copies — `src/lsp/server.yo:71`, `src/lsp/definition.yo:28`,
`src/expr_info.yo:876`, `src/evaluator/memory_safety.yo:141` — call. They
currently disagree about the scheme prefix, the drive letter and
percent-encoding, and every disagreement is a Windows-only key mismatch.

## Regression test

`tests/internal/` — a new `lsp_uri.test.yo` importing the exported
`uri_to_fs_path` from `src/lsp/server.yo` and asserting, on every platform
(the function is pure string handling, so the cases need no Windows runner):

- `file:///home/u/a.yo` → `/home/u/a.yo`
- `file:///C:/w/a.yo` → `C:/w/a.yo`
- `file:///c:/w/a.yo` → `c:/w/a.yo` (or the normalized `C:` — pin whichever
  the fix chooses)
- `file:///home/u/a%20b.yo` → `/home/u/a b.yo` (the existing decode, so the
  fix cannot regress it)
- a path that merely *contains* a colon (`file:///home/u/a:b.yo`) must keep
  its leading `/`.

## Breaking change

No — internal to the compiler.
