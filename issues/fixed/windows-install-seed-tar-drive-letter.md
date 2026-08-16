# `install-seed` fails on windows-latest: GNU tar reads `D:\...` as a remote host

**Status: FIXED** 2026-08-15 (found on PR #126, runs 31851051908 and
31854018190 — reproduced identically in both).

## Symptom

The `test (windows-latest)` leg failed at "Install the seed compiler
(previous release)", making the seed look absent on Windows:

```
\e3c1d47dd94e3934ce7ba784b8888f882c7508f5ac533d01c1ce6f2074cb5298 *D:\\a\\_temp/yo-seed.tar.gz
tar (child): Cannot connect to D: resolve failed
gzip: stdin: unexpected end of file
tar: Child returned status 128
tar: Error is not recoverable: exiting now
```

## Root cause

`$RUNNER_TEMP` on a Windows runner is `D:\a\_temp`, so the extraction ran as:

```bash
tar -xzf "D:\a\_temp/yo-seed.tar.gz" -C "D:\a\_temp/yo-seed" --strip-components=1
```

GNU tar — the tar that Git Bash provides, and the shell this composite action
runs under is `C:\Program Files\Git\bin\bash.EXE` — parses an argument to `-f`
containing a colon as a **remote `host:path` specification**. It therefore
treated `D:` as a hostname and tried to reach it over rmt.

The download was fine (the `sha256sum` line above prints the real digest of a
real file). **Only extraction broke**, which is what made this present as
"missing seed" rather than "corrupt archive" — and the action's hard-fail
message pointed at a missing/draft release bundle, none of which applied:
`yo-v0.2.4-windows-x64.tar.gz` is present on the release.

This surfaced now because P2.5 step 18 put `install-seed` on the Windows leg
for the first time; every earlier consumer was Linux-only.

## Fix

Extract with bare relative paths from inside `$RUNNER_TEMP`, so no drive
letter ever reaches tar:

```bash
mkdir -p "$RUNNER_TEMP/yo-seed"
(cd "$RUNNER_TEMP" && tar -xzf yo-seed.tar.gz -C yo-seed --strip-components=1)
```

**Do not use `--force-local` instead.** It is a GNU extension; macOS runners
have bsdtar and would break. The relative form works on both.

Verified locally with GNU tar 1.35 (the same flavor Git Bash ships): rc=0 and
the bundle extracts to `bin/ std/ vendor/ LICENSE.md`.
