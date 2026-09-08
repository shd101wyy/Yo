# `docs/*/LSP.md` and both READMEs say the language server "is not currently shipping" — 17 days after `yo lsp` became feature-complete

**Status:** FIXED 2026-09-08. Found 2026-09-08 during the LSP audit.
**Severity:** docs (a user following the docs concludes there is no editor
support to set up).

## Symptom

`docs/en-US/LSP.md` and `docs/zh-CN/LSP.md` opened with "**Not currently
shipping.** … there is no `yo lsp` subcommand" and described the deleted
TypeScript server's internals (`deleteModule`, `genericImplRegistry`,
`src/tests/lsp.test.ts`); their Setup section said "There is nothing to set
up". The root `README.md` and `docs/zh-CN/README.md` "Editor Support"
sections said the same. `yo lsp` has served the full feature set since
2026-08-22 (`plans/archive/P4_LSP.md`), and the VS Code extension has bundled
its client since the same day.

## Fix

Both LSP pages rewritten for the live server: setup for VS Code (settings
`yo.binPath`, `yo.lsp.enabled`, the new `yo.trace.server`, the new
**Yo: Restart Language Server** command) and for other editors (`yo lsp` over
stdio, a Neovim snippet), the feature list as implemented, the mid-edit
behaviour (last parsed analysis, partial ExprInfo), the position-encoding
negotiation, the `src/lsp/` layout and where the tests live. Both README
sections now describe the shipped server and link to the page.
