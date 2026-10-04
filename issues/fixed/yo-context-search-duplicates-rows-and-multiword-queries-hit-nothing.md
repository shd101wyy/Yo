# `yo context --search` duplicates every row and multi-word queries hit nothing

**Severity:** S3 — the recall surface of the agent toolchain fails its own
motivating query: "which module do I import to hash a string?"
(`plans/reference/YO_CONTEXT.md` §1) returns zero rows as typed.

**Status: FIXED 2026-10-03 (branch s3/batch-1-fixes).** Found 2026-10-01
during the agent-loop audit's CLI probes (yo 0.2.47); both defects
reproduced from the shipped binary.

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

## Fixed

**2026-10-03, branch `s3/batch-1-fixes`.** Both defects were local to
`src/context_command.yo`, and both are fixed there:

- **Multi-word queries hit nothing** — `search_score` and `_deep_score`
  matched the whole query as ONE literal substring. They now tokenize it
  (`_query_tokens`: whitespace-split, lowercased, empty pieces dropped) and
  require EVERY token to match somewhere (AND). Each token scores on an
  extended ladder — exact name 400 > name prefix 300 > name substring 200 >
  **module substring 150** (new tier; the module is what answers "which
  module do I import to …?") > signature 100 > doc 50 — and the entry
  scores its WEAKEST token's tier, so a hit's score stays one rung of the
  ladder. `--search "hash string"` now returns `std/string hash
  (String) fn(… inout(self) : String …)` first (rc=0, 5 hits; was rc=1
  "no matches"); `--search "read file"` and `--search "spawn thread"`
  likewise return the std/fs/file and std/thread surfaces.
- **Duplicated rows** — the index carries one line per method receiver
  keyed by (module, name, kind); the receiver lives in the signature, which
  prints `Self`, so a module defining the same method name on several types
  yields byte-identical lines (std/async/channel's `close` ×3; this
  checkout's std has 125 byte-identical full lines across 295 duplicated
  (module, name) pairs), and `_search_entries` pushed one hit per line.
  It now collapses byte-identical entries — keyed on
  module, name, kind, signature, doc, origin (a tab cannot occur in any
  field, so the join cannot alias) — to ONE hit before scoring; entries
  differing in signature (array_list's `next` on distinct iterator types)
  stay, as genuinely distinct rows. `--search close` prints the trio once.

Test: two cases in `tests/internal/context_index.test.yo` — the
multi-token ladder (red before the fix: `the weaker token's tier 150, got
0`) and the dedup + hit stream (red before: `2 close rows, got 5`); the
file is 7/7 green built from the fixed tree (2026-10-03). No cli-case
golden moved: the context cases' fixture queries are single-token and
their corpora hold no duplicate rows — verified by running all 24 context
cases against the fixed binary and against the pre-fix control binary
(identical hunks, all of them this Windows box's `<PROJ>` path-substitution
gap in `scripts/cli-diff-test.sh`, present with and without the fix; CI's
Linux legs normalize correctly). The pack's "match ONE keyword"
mitigation, `docs/en-US/CONTEXT.md` + `docs/zh-CN/CONTEXT.md`, the
subcommand help and the YO_CONTEXT.md §C4 contract now describe AND
keywords and the row collapse. The describe views (`yo context <module>`,
bare `<name>`) still print byte-identical duplicate rows — filed as
`issues/yo-context-describe-views-duplicate-byte-identical-rows.md`.
