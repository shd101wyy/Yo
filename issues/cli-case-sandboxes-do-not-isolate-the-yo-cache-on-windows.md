# cli-case sandboxes do not isolate the yo cache on Windows (`LOCALAPPDATA` escapes the HOME remap)

**Severity:** S3 — CI-plumbing/goldens: `scripts/cli-diff-test.sh` sandboxes mutate the developer's REAL content-addressed cache on Windows (sandbox projects are recorded in the real index; mirrors, index and store change under it), and during a full GATE 7 corpus run on this host the checkout's own `markdown_yo` store tree disappeared, failing later gates spuriously (`check ./src`: 272/278)

**Status:** OPEN
**Found:** 2026-10-06, gating PR #1231 on a Windows host: the first `gates_fast.sh` run passed GATE 4 (`check: 278/278 file(s) passed`), was killed mid-GATE-7, and a fresh re-run of the SAME tree then failed GATE 4 with `check: 272/278 file(s) passed)`.

## Symptom

After a (partial) GATE 7 corpus run on Windows, every later `check`/`compile` in
the checkout fails on the six modules whose import chain reaches `markdown_yo`
(`src/doc_command.yo`, `src/build_runner.yo`, `src/doc/render_html.yo`,
`src/doc/context_index.yo`, …):

```
error: import("markdown_yo"): git dependency "markdown_yo" is not in the store
       (C:\Users\<user>\AppData\Local/yo/cache/store/sha256/f7b14fd8…) — run `yo install`
   --> src/doc/render_html.yo:38:58
```

Recovery is exactly what the error says: `yo install` in the checkout re-fetches
`markdown_yo → v0.0.10` into the store, after which GATE 4 passes again
(`check: 278/278 file(s) passed`, verified 2026-10-06 on the same tree, same
binary).

## What is PROVEN (all observed 2026-10-06 on this host)

1. **The cache resolution escapes the sandbox.**
   `get_global_cache_dir` (`src/cache.yo:40-64`) resolves the cache as
   `$YO_CACHE_DIR` → `$XDG_CACHE_HOME/yo` → platform default, and the platform
   default is **`%LOCALAPPDATA%\yo\cache` on Windows** (HOME is only the
   fallback when `LOCALAPPDATA` is unset) but `~/.cache/yo` (HOME-derived)
   everywhere else. `scripts/cli-diff-test.sh` sandboxes a case with **its own
   HOME** only — the harness's own comment
   (`scripts/cli-diff-test.sh:80`): "The run gets its own HOME, so
   `~/.cache/yo` mutations are part of what is [scored]". `LOCALAPPDATA` is
   inherited untouched, so on Windows every sandboxed `yo` reads and writes the
   REAL cache.
2. **Sandbox runs mutate the real cache.** After a corpus run, the real
   `cache/projects` index records four `Temp/tmp.*/run/proj` sandbox projects
   alongside the real checkouts; a single sandboxed `cache-gc` case run
   rewrote `cache/projects`, `cache/git/` and `cache/index/` (mtimes =
   the case's run time). The `cache-path` case's corpus run makes the same
   thing visible in its own scoring diff — the golden expects an isolated
   cache and the sandboxed `yo cache gc` answered about the REAL one:
   `< Kept 1 tree(s) referenced by 1 project(s); removed 0 tree(s), 0
   mirror(s), 0 tag list(s)…` vs `> Kept 1 tree(s) referenced by 10
   project(s); removed 0 tree(s), 10 mirror(s), 11 tag list(s)…` — the run
   REMOVED ten mirrors and eleven tag lists belonging to the developer's real
   cache.
3. **The checkout's store tree vanished during the corpus window.** The
   `cache/store/sha256/` directory mtime moved inside the corpus run (17:38),
   and the `markdown_yo` tree was absent when GATE 4 next ran (18:1x);
   `yo install` restored it (18:38).

## What is NOT pinned down

The exact corpus step that removed the tree. A single-case reproduction with
`cache-gc` (its `cmd` runs `install; cache gc; remove remote; cache gc` against
a sandbox lock that does not name `markdown_yo`) did NOT evict it — with the
checkout still recorded in `cache/projects`, gc's
"keep every tree a recorded project's yo.lock references" walk keeps
`markdown_yo`. The plausible remaining mechanism is a sandbox install
rewriting `cache/projects` without the checkout (dropping its record), after
which a corpus `cache gc` treats the tree as unreferenced — but that sequence
was not reproduced in isolation.

## Expected

The harness exports `YO_CACHE_DIR` into each sandbox, pointed INSIDE the
sandbox home it already creates — `get_global_cache_dir` honors `$YO_CACHE_DIR`
first, so one environment variable isolates the cache on every platform.

That change alters what POSIX CI scores too: cases whose `expected_home_tree`
golds record `~/.cache/yo` would see the cache move to the new
`YO_CACHE_DIR` path, so the fix must land together with a POSIX re-record of
the affected cases (from this Windows host neither the fix nor the re-record
can be verified — the constraint recorded in
`issues/cli-case-goldens-cannot-be-recorded-from-a-windows-host.md`).

The same gap is the second leg of that issue: the drive-letter `C:/Users/…`
spellings that leak into recorded goldens are the REAL cache and temp paths
showing through the `<PROJ>`/`<HOME>` normalization, which substitutes the
harness's own msys spellings.

## Not blocking

POSIX CI is unaffected (the HOME remap isolates the cache there); this is a
developer-host hazard for Windows gate runs, with a one-command recovery.
