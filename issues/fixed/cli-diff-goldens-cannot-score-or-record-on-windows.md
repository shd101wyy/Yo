# cli-diff goldens cannot be scored or recorded on Windows (path spelling, `.exe` suffixes, `.pdb` noise)

**Severity:** S3 — on Windows Git Bash the corpus could neither score nor
record three families of golden: every assertion anchored on a
`<PROJ>`/`<HOME>` token scored as a vacuous NO-GOLDEN (the assertion never
ran), a golden recorded on Windows would poison the Linux CI gate with
`bin/app.exe` artifact spellings, and any case running `yo build test` pinned
`.pdb` hashes that change every link.

**Status: FIXED 2026-10-04** (see Fix below). Found 2026-10-04 while
re-recording the `init-*` goldens for
[`init-agentsmd-template-omits-the-verify-recipe.md`](./init-agentsmd-template-omits-the-verify-recipe.md).

## Symptom

Three separate walls, all hit re-recording the `init-*` goldens on Windows:

```
$ YO_SELF_BIN=yo-out/x86_64-pc-windows-msvc/bin/yo.exe \
    bash scripts/cli-diff-test.sh init-existing
── NO-GOLDEN  init-existing  (stdout_keep_match matched nothing — vacuous)
```

```
$ ... --record build-stamp-dotted-dir && git diff
-Building app → yo-out/<TARGET>/bin/app          # the Linux-recorded golden
+Building app → yo-out/<TARGET>/bin/app.exe      # what Windows records
```

```
$ ... init-build-test    # immediately after recording it
    content-differs (vs recorded golden hash): ./tests/.yo_selftest_batch_1_0.pdb
```

## Root cause

Three Windows-only gaps in `scripts/cli-diff-test.sh`, each a no-op on the
POSIX hosts that record and score the goldens in CI:

1. **`<PROJ>`/`<HOME>` substitution.** `normalize_stream` substituted the
   sandbox dirs in the spelling the harness holds them — MSYS
   `/tmp/tmp.X/run/proj` (`mktemp -d` + `pwd -P` in Git Bash) — while the
   sandboxed child is a native exe printing
   `C:/Users/<user>/AppData/Local/Temp/tmp.X/run/proj`. The sed never matched,
   so `<PROJ>` never appeared in the filtered stream and the
   `stdout_keep_match` patterns of `init-existing` and
   `install-offline-empty-cache` (the only two anchored on it) filtered to
   zero lines; `--record` then (correctly) refused the vacuous run.
2. **`.exe` artifact suffix.** `yo build` prints
   `yo-out/<target>/bin/app.exe` on Windows and `bin/app` on POSIX; a record
   on Windows wrote the suffix into `expected_stdout`, which the Linux
   `gates_fast.sh` GATE 7 run would then GOLDEN-DIFF on forever.
3. **`.pdb` link noise.** a Windows `build test` leaves PDBs beside the batch
   binaries; a PDB embeds a fresh GUID per link, so the recorded hash never
   matched the very next run — the case could not pass twice in a row.

## Fixed

**2026-10-04, branch `s3/batch-0-fixes`.** Three small convergences in
`scripts/cli-diff-test.sh`, each inert on POSIX: `normalize_stream` also
substitutes the `cygpath -m` (forward-slash Windows) spellings of the two
sandbox dirs when `cygpath` exists; it strips a trailing `.exe` from
`yo-out/` paths at a word boundary (`s#(yo-out/[^[:space:]]*)\.exe(...)#
#\1\2#g`, applied after the `<TARGET>` rewrite); and `*.pdb` joined
`DEFAULT_IGNORES` beside `*.o`/`*.bin` as a link artifact. Verified on Windows
with the tree-built binary: `init-existing` went NO-GOLDEN(vacuous) →
GOLDEN-DIFF(tree — the real scaffold change of the verify-recipe fix) →
`--record` + PASS with `expected_stdout`/`expected_rc` byte-identical to the
Linux-recorded pair; the two build-stamp cases re-recorded with their
`expected_stdout` byte-identical to the previous Linux goldens (only
`expected_tree` gained the scaffolded files); `init-build-test` passes twice
in a row. Remaining known Windows blocker, unchanged by this fix:
`install-offline-empty-cache` still scores NO-GOLDEN(vacuous) because the yo
store lives under `%LOCALAPPDATA%` outside the sandbox HOME (documented in the
explain-registry fix, commit `0ec4163ab`) — the case stays recordable only
from POSIX hosts.
