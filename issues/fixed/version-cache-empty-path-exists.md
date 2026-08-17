# `Path.new("")` normalizes to `.` — the version cache's hoisted-await placeholder "existed", so every version reported "already cached"

**Status: FIXED 2026-08-17.** Found by the new `version-install-pinned`
differential case (the first exercise of P3 item 2's GitHub-Releases cache
under the corpus): in a fresh sandbox HOME, the self-hosted arm printed

```
$ yo version install 0.2.1
Yo v0.2.1 is already cached.
$ yo version list
No cached versions. …
```

— install skipped (claiming cached), list agreed nothing was cached, and the
TS arm meanwhile downloaded and listed 0.2.1 (a clean DIFF).

## Root cause

`yo-self/version_cache.yo`'s async helpers hoist their `io.await(exists(…))`
calls out of match arms (an `io.await` may not sit in a `cond` condition or a
later branch), so "no path to check" still has to be awaited as a REAL path.
The placeholder was `String.new()` with the comment "An empty path simply
does not exist" — but `Path.new("")` NORMALIZES to `.`, which exists
(measured: a standalone `exists(Path.new(String.new()))` prints `true`). So:

- `is_version_cached`: no install root → `exists("")` → TRUE → "already
  cached" for EVERY version;
- `_scan_versions_root("")`: `exists("")` TRUE → `read_dir("")` scanned the
  CWD (harmlessly finding no `*/bin/yo`, which is why `list` still said
  "No cached versions" — the two commands disagreed through two different
  wrong paths);
- `resolve_version_dir`: milder — the empty dir went through
  `cached_binary_path("")` first, producing a relative `bin/yo` that
  happened not to exist.

TS is unaffected: its `isVersionCached` has no install-root check (that
check is the P3 item-1 unification extension, currently yo-self-only — TS
is being retired, so the extension is the forward behavior).

## Fix

`_never_path()` — `/nonexistent/.yo-version-never`, a path that genuinely
cannot exist — replaces `String.new()` at all three `.None` arms. The
hoisted-await shape is untouched (it exists for a real async-codegen
restriction).

Verified: the `version-install-pinned` case passes differentially (install →
list → clean, network-gated), and `version-list-empty` stays green.
