# A `.yo-version`-dispatched command exits 0 when it fails

**Severity:** S1 — in a project that pins another Yo version, every failing `yo test` / `check` / `build` / `compile` exits 0, so CI goes green on failing code

**Status:** FIXED 2026-10-16 (`fix/version-dispatch-exit-code`). Found 2026-10-16 while running markdown_yo's tests for
`issues/fixed/vendor-markdown-punycode-encode-reads-past-the-buffer.md`:
markdown_yo pins `.yo-version` 0.2.58, and a failing `yo test ./tests` under
the installed `yo 0.2.63` printed `1 failed` and exited 0.

## Reproducer

In any directory whose `.yo-version` names a version other than the running
binary's (here markdown_yo, pinning 0.2.58, with `yo 0.2.63` on `PATH`):

```sh
$ yo check ./nonexistent.yo >/dev/null 2>&1; echo $?
0
$ YO_VERSION_DISPATCHED=1 ~/.cache/yo/versions/0.2.58/bin/yo check ./nonexistent.yo >/dev/null 2>&1; echo $?
1
```

The dispatched child exits 1; the dispatcher reports 0. The same happens for
`yo test` with a failing test (`yo: error: 1 test(s) failed`, rc 0), so
markdown_yo's CI (`yo test ./tests --parallel 1` after installing the latest
`yo`) cannot fail on a unit-test failure.

## Root cause

The pre-dispatch in `src/main.yo` (the `.yo-version PRE-DISPATCH` block, in
place since the self-hosted port) exits with the raw `waitpid` status:

```yo ignore
dst := io.await(dcmd.status(io), IoExn(io : io, exn : exn));
unsafe(exit(int(dst.raw)));
```

`ExitStatus.raw` is the encoded wait status (`code << 8` for a normal exit),
and `exit` keeps only the low 8 bits, so every normal exit code 1..255 becomes
0. Only a signal death (raw = the signal number) comes through non-zero.

## Fix

Exit with the decoded status: `dst.code()` for a normal exit, `128 + dst.signal()`
for a signal death (the shell convention), e.g.

```yo ignore
unsafe(exit(int(match(dst.code(), .Some(c) => c, .None => (i32(128) + dst.signal())))));
```

Regression test: a `tests/cli-cases/` case whose fixture pins `.yo-version` to
a version that the sandbox `HOME` already has "cached" (a stub `bin/yo` that
exits 3, laid out where `is_version_cached` looks), with `expected_rc` 3. It
fails today (rc 0) and passes after the fix.

## Resolution

`src/main.yo`'s pre-dispatch exits with `dst.code()`, or `128 + dst.signal()`
after a signal death. `tests/cli-cases/version-dispatch-exit-code` pins
`.yo-version` to 0.0.1, lays a stub `bin/yo` that exits 3 under
`YO_CACHE_DIR=<PROJ>/cache/versions/0.0.1`, and expects rc 3: the v0.2.63 seed
exits 0 on it, the fixed binary exits 3.
