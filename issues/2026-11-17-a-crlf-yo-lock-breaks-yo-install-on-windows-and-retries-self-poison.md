# A CRLF `yo.lock` breaks `yo install` on Windows and the retry self-poisons

**Severity:** S3 (a fresh clone with `core.autocrlf=true` — the Windows git default — cannot install
until the lock is rewritten with LF endings by hand)

Filed from the v0.2.79 README-projects sweep (tetris_yo's fresh clone), 2026-11-17. Measured on the
v0.2.78 seed (the lock blob itself is LF; the working-copy checkout is CRLF).

## Repro

```text
$ git clone <any yo project with a yo.lock>   # on Windows, core.autocrlf=true
$ yo install
Note: yo.lock: TOML error: unexpected character 13 at byte 83 — regenerating it.
yo: error: file or directory already exists        # a yo.lock.tmp is left behind
```

Deleting `yo.lock.tmp` does not help (the retry regenerates and fails the same way). Rewriting the
working copy's `yo.lock` with LF endings fixes install immediately.

## Fix shape

Read `yo.lock` with CR stripped (or write the regenerated lock atomically and mark the tree's lock
`.gitattributes`-clean in `yo init`); the failure path should also remove its own `yo.lock.tmp`.
