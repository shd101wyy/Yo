# `yo version install` fails with "cross-device link" when /tmp is tmpfs

**Status: OPEN** (hit 2026-09-08 installing the v0.2.28 seed on a normal
Linux desktop — Steam Deck, /tmp tmpfs, /home ext4).

## Error

```
$ yo version install 0.2.28
Downloading Yo v0.2.28 (yo-v0.2.28-x86_64-unknown-linux-musl) from GitHub Releases...
yo: error: cross-device link
```

Install succeeds with a same-device temp dir:
`TMPDIR=$HOME/.cache/tmp yo version install 0.2.28`.

## Root cause

`ensure_cached_version` (`src/version_cache.yo`) downloads the tarball
into a `TempDir` — which lives under the SYSTEM temp root (`std/fs/temp`
`temp_dir()` → `$TMPDIR`/`/tmp`) — extracts there, and then moves the
extracted bundle into `~/.cache/yo/versions/…` with `rename(2)`
(`std/fs/dir`'s `rename`). On any system where the temp root and the
cache root are on DIFFERENT filesystems (tmpfs `/tmp` + disk `$HOME` —
systemd's default on most distros), `rename(2)` fails with `EXDEV`
("cross-device link") and the whole install aborts after the download
completes.

## Fix direction (LANDED 2026-09-08, on the V3 branch)

Extract into a STAGING DIR INSIDE the versions cache
(`TempDir.new_in(~/.cache/yo/versions)`), so the final move is a
same-filesystem `rename(2)` — structural, no cross-device fallback
needed. Two fallback designs were tried and are recorded as dead ends:

- A recursive-copy fallback on rename failure cannot be expressed:
  `unwind` from an exception handler ABORTS the io.async closure rather
  than resuming it with a value, so catch-and-continue does not exist
  inside async closures (the pre-check idiom the std uses everywhere is
  the only supported shape).
- A module-level flag written by the rename's inner handler is invisible
  to the closure: the async state machine captures module globals as
  per-SM copies (`sm->var_N`), so the handler's write to the module
  global never reaches the closure's read — the move silently no-ops.

## Notes

- The same shape exists in `src/verifier/z3.yo`'s `_install_z3`, but it
  deliberately avoids it: `unzip` extracts straight into the solvers
  cache root (no cross-device move at all).
- CI never sees this (runners have one filesystem).
