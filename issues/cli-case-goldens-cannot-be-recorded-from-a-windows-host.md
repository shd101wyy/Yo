# cli-case goldens cannot be recorded from a Windows host (`<PROJ>` misses, `app.exe` diverges)

**Severity:** S3 — CI-plumbing/goldens: `scripts/cli-diff-test.sh --record` run on Windows bakes machine-specific paths and platform-specific output into the goldens, so a skills-file edit made from a Windows host cannot land without a POSIX re-record; the `init-existing` case also scores NO-GOLDEN locally for the same reason

**Status:** OPEN
**Found:** 2026-10-04, re-recording the seven skills-affected cli-cases after a
one-line edit to `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`
(the documented consequence of touching a skill file,
`.github/instructions/testing.instructions.md` "Editing ANY file under
`.github/skills/` re-records SEVEN cli-cases").

## Symptom

On Windows (git bash), with a tree-built binary:

```
YO_SKILLS="$PWD/.github/skills" YO_SELF_BIN="$PWD/tmp/yo-chunked.exe" \
  bash scripts/cli-diff-test.sh --record \
  build-stamp-dotted-dir init init-build-test init-cwd init-existing \
  skills-install skills-install-zh
── RECORDED  build-stamp-dotted-dir  (rc=0)
...
── NO-GOLDEN  init-existing  (stdout_keep_match matched nothing — vacuous)
```

Two separate defects in what got recorded / scored:

1. **The recorded goldens are machine-specific and POSIX-incompatible.**
   `git diff tests/cli-cases/` after the re-record showed, beyond the intended
   skill-hash lines:

   ```
   -Building app → yo-out/<TARGET>/bin/app
   +Building app → yo-out/<TARGET>/bin/app.exe          ← build-stamp-dotted-dir/expected_stdout
   +Initialized Yo project "probe" in C:/Users/shd10/AppData/Local/Temp/tmp.9pYecxU8n6/run/proj/probe
   -Initialized Yo project "probe" in <PROJ>/probe       ← init/expected_stdout
   +./tests/.yo_selftest_batch_1_0.bin.asan_probe.c	2ad7…  ← init-build-test/expected_tree
   ```

   The committed goldens were recorded on POSIX (`app`, `<PROJ>`), so recording
   from Windows would turn GATE 7 (`scripts/bootstrap/gates_fast.sh`, the full
   corpus) red on every POSIX leg — the opposite of what a re-record is for.

2. **`init-existing` scores NO-GOLDEN before any of this** — with the pre-change
   binary too (verified: same NO-GOLDEN with
   `s3-build/yo-out/…/yo.exe`, 5 commits older). The case's behavior is correct
   in the sandbox (kept sandbox `stdout.raw` ends with
   `yo: error: Error: …/probe/build.yo already exists. Aborting.` and `rc=1`);
   only the keep-match fails.

## Root cause

`normalize_stream` (`scripts/cli-diff-test.sh:223`) and the opts expansion
(`:405`) substitute `$proj` — the path as the HARNESS spells it. On git bash,
`mktemp -d` yields an msys path (`/tmp/tmp.XXX/run/proj`, which msys maps under
`$TMP`), while the native Windows binary prints the same directory with a
drive-letter spelling (`C:/Users/…/AppData/Local/Temp/tmp.XXX/run/proj`). The
`sed s|$proj|<PROJ>|g` rewrite never matches the binary's spelling, so:

- absolute paths reach the goldens un-rewritten (symptom 1, second hunk), and
- `stdout_keep_match=<PROJ>/probe/build\.yo already exists…` expands to the
  msys spelling, which the stdout never contains (symptom 2, the vacuous
  NO-GOLDEN).

Symptom 1's first hunk is independent of paths: the Windows binary's build
output names `bin/app.exe` where POSIX records `bin/app`; no normalization
covers the platform suffix. The third hunk (`*.bin.asan_probe.c` lines in
`init-build-test`'s tree golden) is a Windows runner difference in what
`yo build test` leaves behind.

## Consequence for skills edits

A one-line edit to ANY `.github/skills/` file requires re-recording seven
cases, and that re-record can only be done from a POSIX host. From Windows the
choice is: keep GATE 7 red everywhere (goldens reverted), or commit
Windows-contaminated goldens (GATE 7 red on POSIX). Neither is acceptable, so
the edit itself has to be deferred.

Deferred with this finding (2026-10-04): the `dyn(x)` bullet in
`.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` (~line 444) still
reads "is rejected, today with a misleading message" and cites that issue doc
by its OLD root path — the doc is now
`issues/fixed/dyn-as-a-direct-downcast-argument-reports-got-option.md` and the
message is truthful (E0605 "cannot infer the Dyn type of dyn(...)", branch
`s3/batch-2-fixes`). That citation is knowingly stale until the next POSIX
re-record; update the bullet to cite the `issues/fixed/…` path and drop
"misleading" in the same re-record.

## Expected

Either the harness grows Windows-safe normalization (rewrite the drive-letter
spelling of `$proj`/`$home` too — e.g. also `cygpath -m` forms — and normalize
the `.exe` suffix on the `yo-out/<TARGET>/bin/…` line), or the docs state
plainly that `--record` is POSIX-only and `init-existing`'s local NO-GOLDEN on
Windows is expected. Until then, `check-issue-refs.sh` will keep flagging the
deferred cheatsheet citation above.

## Not blocking

CI records and scores on POSIX, where none of this reproduces; GATE 7 is green
there. This is a host-gap with a workaround (do not record from Windows).
