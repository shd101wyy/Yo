# `yo context --search` duplicates every row and multi-word queries hit nothing

**Severity:** S3 — the recall surface of the agent toolchain fails its own
motivating query: "which module do I import to hash a string?"
(`plans/reference/YO_CONTEXT.md` §1) returns zero rows as typed.

**Status: OPEN.** Found 2026-10-01 during the agent-loop audit's CLI probes
(yo 0.2.47); both defects reproduced from the shipped binary.

## Symptom

Two independent defects, one code path (`src/context_command.yo:946–964`,
the `--search` scorer):

1. **Every result row is printed twice** — the world-entry list carries the
   same (module, name) once per export aliasing, and the renderer does not
   dedup:

   ```
   $ yo context --search hash
     std/hash.hash            …
     std/hash.hash            …        (same row, again)
   ```

2. **A multi-word query is matched as ONE literal substring**, so
   natural-language recall queries return nothing (even with `--deep`):

   ```
   $ yo context --search "hash string"      → 0 results
   $ yo context --search "read file"        → 0 results
   $ yo context --search "spawn thread"     → 0 results
   $ yo context --search hash               → strong ranked results
   ```

An agent that phrases recall queries the way the YO_CONTEXT plan itself
phrases them concludes the API does not exist.

## Root cause (narrowed, not fixed)

- The scorer builds one substring pattern from the whole query instead of
  tokenizing on whitespace and requiring all tokens (AND semantics); a
  single-token query works because the whole string is one token.
- The results list is rendered from `world.entries` without deduping by
  (module, name) — an item exported through several paths scores once per
  path.

## Fix direction

Tokenize the query (whitespace-split, lowercase, require every token to
match somewhere in the entry's module+name+doc line — module and name
matches weighted over doc matches, per the existing ranking), and dedup the
entry stream by (module, name) keeping the best score. Both are local to
`src/context_command.yo`; the `context-search`, `context-search-miss` and
`context-deps` cli-case goldens re-record.

## Interim mitigation (shipped with this issue)

`pack/context.md` v3 and the yo-verification skill now state the grammar:
match ONE keyword per query. That converts a silent zero-result into a
documented limitation, but the tokenizer fix is the real answer.
