# Every `didChange` triggers a synchronous full-document re-analysis; requests queue behind it

**Severity:** S3 — IDE responsiveness, not correctness: hover/completion/definition wait for the newest keystroke's full evaluation to finish, seconds on large files.

## Reproduction

No exotic probe needed — read the dispatch (`src/lsp/server.yo`):
`textDocument/didChange` → `_analyze_and_publish` → `mm_invalidate_document`
+ `analyze_document` (fresh parse + full evaluation, imports included) +
`publishDiagnostics`, all inline in the single-threaded message loop. The
server advertises `textDocumentSync: 1` (Full), and vscode-languageclient
delivers one `didChange` per keystroke with no client-side debounce. With a
compiler-sized document (`src/evaluator/*.yo`, thousands of lines), one
analysis takes seconds (the same work `yo check` does per file); every
request arriving mid-analysis (hover at the next cursor stop, completion on
the next trigger character) sits in the pipe until it finishes.

This is the latency face of the same per-round cost the memory plateau work
measures (`issues/lsp-memory-grows-per-open-edit-close-round.md`; its driver
reports 4.3–7.5 s/round on stage-2 compilers for std-sized files).

## Why S3 and not higher

It works, it is eventually consistent, small projects feel instant, and the
fix is a design change (below), not a one-liner. But it caps how good the IDE
can feel on the compiler's own sources, which is the dogfood that matters.

## Fix direction (design, sequenced in plans/archive/LSP_AUDIT_2026-09-29.md §7)

1. **Debounce analysis** on a short idle window (the classic 200–500 ms):
   a didChange only updates `DocState.text/lines` immediately (so position
   conversion and token matching stay current) and schedules the analysis;
   a pending request (hover/completion/signatureHelp) cancels the timer and
   runs against the retained outcome, which is exactly the last-parsed
   semantics already in place — mid-edit requests must ALREADY tolerate a
   stale outcome, so debouncing makes no request worse.
2. Publishing stays per-analysis (publishDiagnostics is a notification; the
   client debounces display on its own).
3. Sequence AFTER the memory plateau flattens per-round growth: a debounce
   that keeps MORE stale copies around while a fresh analysis runs interacts
   with exactly the holders that campaign is closing.
