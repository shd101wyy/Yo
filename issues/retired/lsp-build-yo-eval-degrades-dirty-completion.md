# LSP: project build.yo evaluation degrades dirty-buffer completion

**Status: OPEN** (found 2026-08-10 by PR #92 CI after the repo-root build.yo
landed — the P2.2 dogfood build made the compiler repo itself a build.yo
project, and `src/tests/lsp.test.ts`'s dirty-buffer fixtures suddenly sat
inside one).

## Symptom

With a `build.yo` anywhere above the edited file,
`LspDocumentManager.analyzeDocument` runs `ensureBuildImportsResolved`,
which evaluates the project's build.yo through the same module manager
mid-analysis. For a DIRTY buffer (current text has an eval error), the
completion path then falls back to a degraded module: a
`Type(args).`-constructor dot-completion loses the impl methods and offers
only the enum variants (`["None","Some"]`, no `unwrap`). The same buffer
OUTSIDE any project completes fully.

Repro: the "should suggest methods for type constructor call on dirty
buffer" test in `src/tests/lsp.test.ts`, with its module path pointed
anywhere under a directory containing a build.yo (it now uses os.tmpdir()
precisely to stay hermetic).

## Suspected mechanism

The last-good-module fallback (`lastGoodModules` + trait-field snapshots)
is captured before re-evaluation, but the build.yo evaluation between the
good load and the analyze mutates shared evaluator/type state
(`deleteModule` invalidates std modules; snapshots don't cover the build.yo
pass), so the fallback module's impl-trait fields are stale when the dirty
buffer needs them.

## Why it matters

Any USER project (which by definition has a build.yo) hits this shape while
typing — methods vanish from completion until the buffer parses again. Not
a P1/P2 gate blocker, but a real editor-UX regression to fix in the LSP
work.

---

**RETIRED 2026-08-22.** This snapshot describes the retired TypeScript
server's mechanics (`LspDocumentManager.ensureBuildImportsResolved`,
`lastGoodModules` + trait-field snapshots) — all deleted with `src/` in
P2.5. The Yo-native server (`src/lsp/`, P4) never evaluates the project's
build.yo during analysis: `analyze_document` rides `module_manager`
directly (cached prelude env + demand-loaded imports only), so the
degradation mechanism does not exist. If build.yo-aware analysis is ever
added (project-level import roots), guard against re-introducing this
shape.
