# `yo context` describe views duplicate byte-identical rows

**Severity:** S3 — the module and bare-name views print the same
indistinguishable row several times, padding the one-screen index an agent
reads.

**Status: OPEN.** Found 2026-10-03 while fixing
`issues/fixed/yo-context-search-duplicates-rows-and-multiword-queries-hit-nothing.md`
(that fix deduped the `--search` hit stream only; these renderers build
their own lists).

## Symptom

`yo context std/async/channel` (any tree whose std matches this checkout):

```text
$ yo context std/async/channel --std-path ./std | grep close
  close                   method  (fn(self : Self) -> unit)
  close                   method  (fn(self : Self) -> unit)
  close                   method  (fn(self : Self) -> unit)
  is_closed               method  (fn(self : Self) -> bool)
  is_closed               method  (fn(self : Self) -> bool)
  is_closed               method  (fn(self : Self) -> bool)
```

The same shape repeats in the bare-name view (`yo context close`) and in
both views' `--format json`.

## Root cause

`std/async/channel.yo` defines `close` on three types (Channel, Sender,
Receiver); each method indexes as its own `index.txt` line keyed only by
`(module, name, kind)` — the receiver lives in the signature, which prints
`Self` and so is byte-identical across the three (`src/doc/context_index.yo`,
`_module_entries`). The describe renderers — `_run_context_describe_module`
(src/context_command.yo) and `_run_context_describe_bare` — filter
`world.entries` by module/name without collapsing byte-identical rows, so
every copy prints. (The index carries 125 byte-identical full lines across
295 duplicated `(module, name)` pairs in this checkout's std.)

Distinguishability is the real gap: rows that differ in signature (array_list's
`next` on different iterator types) are legitimately separate rows; rows that
differ in nothing cannot be told apart and are noise.

## Fix direction

The `--search` fix (2026-10-03) deduped its hit stream by full entry identity
(module, name, kind, signature, doc, origin) in `_search_entries`. The same
key collapses the describe views' lists — ideally as one shared helper, with
`context-describe`, `context-json` and `context-item-barrel` cli-case goldens
re-recorded. Rendering the receiver type in the index (`Channel.close` /
`(fn(self : Channel) ...)`) would fix distinguishability at the source and
let the three `close` rows stay as genuinely different entries; that is an
`INDEX_FORMAT_VERSION` bump in `src/doc/context_index.yo`.
