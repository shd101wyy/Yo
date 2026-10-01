# `textDocument/rename` accepts any `newName` and rewrites the buffer into something unlexable

**Status:** FIXED 2026-09-29 (audit §2 PR, plans/archive/LSP_AUDIT_2026-09-29.md): `rename_rejection` (src/lsp/rename.yo) validates `newName` before any edit is built — the parser is the authority on identifier SHAPE (``${name} :: i32;`` must parse as that binding), the keyword half is the curated list completion.yo serves (the language technically parses a keyword-named binding, so the parser alone cannot reject it), and `is_reserved_builtin_binding_name` catches the plain-named builtins; the dispatch answers RequestFailed (-32803) with the reason. `textDocument/prepareRename` is served alongside (`renameProvider.prepareProvider`). Was: **Severity:** S2 — a rename through the editor (F2) with a reasonable typo ("1 bad name", "x y", the keyword `fn`, a reserved builtin like `clone`) produces a WorkspaceEdit that lands in the buffer; found 2026-09-29 by the `plans/archive/LSP_AUDIT_2026-09-29.md` probes.

## Reproduction

Against the installed v0.2.45 binary (any platform; framing aside this is
platform-independent). Document:

```rust
Point :: struct(x : i32, y : i32);
(p : Point) = Point(x : 1, y : 2);
answer :: (fn() -> i32)({ return(((p.x) + (p.y))); });
```

`textDocument/rename` at the `p` declaration (1:1), `newName` = `1 bad name`:

```json
{"changes":{"…probe.yo":[{"range":{…1:1…},"newText":"1 bad name"},
                          {"range":{…2:35…},"newText":"1 bad name"},
                          {"range":{…2:43…},"newText":"1 bad name"}]}}
```

Same for `newName` = `"fn"` (a structural keyword) — three occurrences
rewritten to a keyword. `handle_rename` (`src/lsp/rename.yo`) rejects only an
EMPTY name; every other string is accepted verbatim. VS Code does not validate
the input (the extension provides no `validateInput`), so the edit applies and
the document stops parsing. Blast radius is bounded (one buffer, undo works),
which is what keeps this S2 rather than S1.

## Fix

Validate before building the edit, answering a JSON-RPC error so clients show
it in the rename input box instead of applying a broken edit:

1. identifier shape — `tokenize(new_name)` must produce exactly one token,
   of kind Identifier, covering the whole string (this rejects `1 bad name`,
   `x y`, `foo-bar`, and — because structural keywords never lex as
   identifiers — `fn`, `while`, `return`, …);
2. reserved names — reject `is_reserved_operator_name(name)` and
   `is_reserved_builtin_binding_name(name)` (both exported by
   `src/token.yo`; the latter exists precisely because a user binding spelled
   like a builtin is silently hijacked).

While in the area: advertise `renameProvider` as
`{"prepareProvider" : true}` and implement `textDocument/prepareRename`
returning the identifier's range (members/labels answer nothing), so VS Code
only opens the rename box on renameable symbols.

## Test

Extend the `lsp-rename-identity` cli-case stdin (and hand-author the golden
frames; the harness refits `Content-Length`): one rename request with
`newName: "1 bad name"` expecting an error response, one with `newName: "fn"`
expecting an error response, plus the existing valid rename unchanged.
