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

## Fixed

Root cause: `textDocument/didChange` called `_analyze_and_publish` inline in
the single-threaded message loop (`src/lsp/server.yo`), so every keystroke ran
a synchronous full parse + evaluation (2.9–3.2 s on
`src/evaluator/exprs/begin.yo`, 2,916 lines) before the next message was
read — a hover arriving behind it waited out the whole analysis (measured
3,344 ms against a 54 ms idle baseline, diagnostics-then-hover), and three
rapid changes ran three full analyses.

Fix: a didChange now only records the change — `DocState.text`/`lines` are
updated at once (position conversion and token matching stay current) and the
open-buffer overlay is refreshed — and the analysis is debounced to a 300 ms
idle window (`PendingAnalysis`, `_note_document_change` /
`_flush_pending_analyses` in `src/lsp/server.yo`). While a window is open the
loop waits in `wait_lsp_input` (`src/lsp/transport.yo`): a non-blocking stdin
probe (`PeekNamedPipe`/`WaitForSingleObject` on Windows, `poll(2)` on POSIX,
none on wasm where the wait sleeps to the deadline) lets a message be served
the moment it arrives — from the retained last-parsed outcome, the contract
mid-edit requests already run under — and only a stream that stays silent past
the deadline pays for the deferred analysis, which then publishes. A
conversation that ends while a window is still open (EOF or `exit`) flushes
once more before the server goes, so a piped/redirected client still receives
the last edit's diagnostics. Measured on the same document: hover behind a
didChange 3,344 ms → 51 ms (order hover-then-diagnostics), three rapid
changes 3 analyses → 1. The per-round memory profile is unchanged — the same
analysis runs, one per settled window instead of one per keystroke, and the
flush replaces the retained outcome rather than adding a holder.

Test: `tests/cli-cases/lsp-debounced-didchange` — the hover sent straight
after a didChange is answered before any publishDiagnostics for the change,
and the final diagnostics still arrive at conversation end (before the fix the
change's diagnostics published ahead of the hover reply and nothing followed
the shutdown reply). Four existing lsp cases whose goldens interleaved
per-change publishes were re-recorded (`lsp-analysis-resilience`,
`lsp-handshake`, `lsp-position-encoding-utf16`, `lsp-position-encoding-utf32`);
their diffs are exactly the publish repositioning plus post-change requests
answering from the retained outcome. docs/en-US/LSP.md and docs/zh-CN/LSP.md
document the debounced diagnostics timing.

Fixed 2026-10-03 on branch s3/batch-3-fixes.
