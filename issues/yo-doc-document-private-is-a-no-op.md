# `yo doc --document-private` parses, is advertised in `--help`, and does nothing

**Severity:** S3 — a documented CLI flag (and a `build.doc({ include_private })`
option) that no code path reads; users reasonably believe private items were
included in the output

**Status:** open. Found 2026-10-03 while fixing
`yo-doc-without-std-path-silently-emits-token-only-docs.md` (the export filter
added there had to decide whether `include_private` gates it — it cannot,
because the flag is currently inert in the EVALUATED path too, and the two
paths must count the same way).

## Symptom

```
$ yo doc . --document-private --format json
# identical doc.json to the run without the flag
```

`yo doc --help` advertises:

```
  --document-private        Include underscore-private items
```

and `build.doc({ include_private : true })` carries the same promise
(`std/build.yo`'s `DocConfig`, `--include-private` defaulted to `false`).

## Root cause

`include_private` is threaded end to end and read nowhere:

- `src/main.yo` `run_doc_cmd` parses `--document-private` into the local
  (line ~7859) and passes it as `DocCommandOptions.include_private`.
- `src/build_runner.yo` passes `doc_cfg.include_private` the same way.
- `src/doc_command.yo` declares the field (line 41) and never reads it —
  neither does `document_one_file`, `build_doc_module`, nor
  `build_doc_module_from_tokens`.

The evaluated path cannot honor it today either: its items are the module
TYPE's fields — the module's `export(...)` set — so "private" members are not
in the input to begin with. Making the flag real means deciding what counts as
private (an exported `_name`? a top-level binding absent from `export(...)`?)
and teaching `build_doc_module` to reach past the export set, which is a
design decision, not a wiring fix.

## Fix

Decide the semantics (likely: a top-level declaration not named by any
`export(...)` statement, plus `_`-prefixed exported names), then read
`options.include_private` in the evaluated path (module-level source scan for
non-exported top-level declarations — the evaluator's module value does not
keep them) and pass it through to the token-only path's export filter
(`src/doc/builder.yo`, `build_doc_module_from_tokens`). Until then the honest
shape is to drop the flag and the `DocConfig` field — but that is a
seed-frozen builtin signature for the build-step spelling, so it waits for the
same two-generation rollout as any `__yo_build_doc` change.
