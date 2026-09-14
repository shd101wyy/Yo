# `yo.lock` records the annotated TAG OBJECT, not the commit

**Status:** OPEN — found 2026-09-14 while re-pinning `markdown_yo` from a `rev`
to the semver range `^0.0.7`.

## Symptom

`yo install` resolved `markdown_yo` at tag `v0.0.7` and wrote a `commit` field
that is not a commit:

```
$ yo install
fatal: Not a valid object name 7e942fae34e3146de8503f3bf32411e8b28c0919^{commit}
Wrote yo.lock (1 package(s)).
  markdown_yo → v0.0.7 (7e942fae34e3)
```

```
yo.lock:                          commit = "7e942fae34e3146de8503f3bf32411e8b28c0919"
git cat-file -t 7e942fae…      -> tag                 <-- NOT a commit
git rev-parse v0.0.7           -> 7e942fae…           <-- the tag OBJECT
git rev-parse v0.0.7^{commit}  -> e0b57015533d17bb…   <-- the actual commit
```

Two separate defects are visible above. They are unrelated in cause and are
fixed separately.

## Defect 1 — the resolved SHA is the tag object (`src/fetch.yo`, `resolve_git_ref`)

Git only prints the peeled `<ref>^{}` line when a requested pattern MATCHES
that ref. `resolve_git_ref` passed the ref alone:

```
$ git ls-remote -- <url> v0.0.7
7e942fae34e3146de8503f3bf32411e8b28c0919	refs/tags/v0.0.7        <-- tag object, and the only line
```

so the peeled line naming the commit was never returned, and the function took
the first line's SHA verbatim. Asking for both patterns returns both lines:

```
$ git ls-remote -- <url> v0.0.7 'v0.0.7^{}'
7e942fae34e3146de8503f3bf32411e8b28c0919	refs/tags/v0.0.7
e0b57015533d17bb5204737d73e6e06d6bcb6292	refs/tags/v0.0.7^{}     <-- the commit
```

**Scope.** Any dependency resolved at an ANNOTATED tag, through `yo add` as
well as `yo install` — the two share this function. Lightweight tags, branches
and `HEAD` were never affected (git peels nothing for them, and the extra
pattern returns no extra line). Two locks already in the wild carry a tag
object:

| lock | records | `cat-file -t` | real commit |
| --- | --- | --- | --- |
| `tetris_yo/yo.lock` (`raylib_yo` v0.0.7) | `05a34c6d91a8…` | `tag` | `5639d970225a…` |
| the re-pin under test (`markdown_yo` v0.0.7) | `7e942fae34e3…` | `tag` | `e0b57015533d…` |

This repository's own `yo.lock` is NOT affected: it pins `markdown_yo` by
`rev`, and `a46f7004…` is a real commit.

**Why every gate stayed green.** Git peels the tag on its own for `cat-file`,
`fetch` and `checkout`, so the fetch still lands the right tree and the
`integrity` hash is correct. The only wrong thing is the recorded SHA — the
lock claims an object that is not a commit, and anything comparing it to a
real commit (`git rev-parse HEAD` in a checkout of that tree) never matches.

### Why the corpus could not have caught it

All four git fixtures in `tests/cli-cases/` create their tags with `git tag` —
LIGHTWEIGHT. 134 cases, zero annotated tags. The corpus did not miss this by
chance; it was structurally incapable of seeing it, because every fixture
shared the convention that the bug lives on the other side of.

**A corpus that shares a convention cannot see a bug in what the convention
fixes.** `git tag` vs `git tag -a` is one flag, and nobody would list it as a
test dimension — which is exactly what makes it worth writing down. When a
whole suite agrees on an incidental choice (a tag kind, a binder name, an
argument order), that choice is invisible to it.

`tests/cli-cases/install-annotated-tag/` is the case that now covers it, and
it keeps the resolved SHA in the golden stdout on purpose, so a regression
reads as a SHA mismatch rather than an opaque tree-hash diff:

```
      <   remote → v1.0.0 (004f99c8e1c8)      # golden, fixed binary: the commit
      >   remote → v1.0.0 (e917d910f283)      # v0.2.32 seed: the tag object
```

(That is the actual scorecard output from running the new case against the
unfixed seed — the "fails before the fix" check.)

### Does the fix break an already-committed lock?

No — MEASURED, not inferred. The worry is reasonable: after the fix the
resolver answers `e0b57015` where the committed lock says `7e942fae`, so
`--locked` would seem to have to reject it. It does not, because the reused
lock path never re-resolves. `src/resolver.yo` (~:1233) passes
`locked_commit = Some(old_commit)` to `fetch_package`, whose first two lines
are

```
(commit : String) = match(locked_commit, .Some(c) => if(refresh, String.new(), c.clone()), .None => String.new());
needs_ls_remote := (commit.len() == usize(0));
```

so on a non-refresh reuse `resolve_git_ref` is not called at all.

Transcript — a lock written by the v0.2.32 seed (recording the tag object),
then the fixed binary run against it:

```
$ <seed> install                       # the old, wrong lock
  remote → v1.0.0 (e917d910f283)
$ git cat-file -t e917d910f283…     -> tag

$ <fixed> install --locked             # rc=0, no complaint
yo.lock is up to date.
  remote → v1.0.0 (e917d910f283)
  => lock byte-identical

$ <fixed> install                      # same, lock reuse
yo.lock is up to date.
  => lock byte-identical

$ <fixed> update                       # the migration
Wrote yo.lock (1 package(s)).
  remote → v1.0.0 (004f99c8e1c8)
$ git cat-file -t 004f99c8e1c8…     -> commit
```

**Release-note consequence.** An existing lock keeps working untouched, and a
tag-object `commit` is harmless in practice — git peels it for fetch and
checkout, so this is provenance hygiene, not an emergency. But it is
self-healing, NOT automatic: `install` and `--locked` deliberately do not
re-resolve, so a stale entry stays wrong with no warning until someone runs
`yo update`. Fold that into the next dependency change rather than rushing it.

## Defect 2 — a cache-miss probe leaks git's stderr (`src/fetch.yo`, `_mirror_has_commit`)

`_mirror_has_commit` ran `git cat-file -e <sha>^{commit}` through `.status()`,
which inherits stderr. A MISS is the ordinary answer before the mirror has
been fetched, so git's `fatal: Not a valid object name …` printed straight
into normal `yo install` output — the `fatal:` line above. `mirror_rev_parse`
next to it already did this correctly with `--quiet` + `.output()`.

## Fix

`src/fetch.yo`:

- New pure helper `commit_from_ls_remote(text) -> Option(String)`: prefers the
  line whose ref ends `^{}`, falls back to the first line. Order-independent.
- `resolve_git_ref` asks for `<ref>` and `` `${ref}^{}` `` and selects through
  that helper.
- `_mirror_has_commit` probes with `.output()` instead of `.status()`.

## Tests

- `tests/internal/fetch.test.yo` — 7 cases on `commit_from_ls_remote`:
  annotated tag (both line orders), lightweight tag, branch, `HEAD`, blank
  lines, empty input.
- `tests/cli-cases/install-annotated-tag/` — end-to-end, and the half the unit
  tests cannot reach: it checks the ls-remote QUERY, which is what was wrong.
  Its fixture remote's only tag is annotated; the kept stdout line
  `  remote → v1.0.0 (<12 chars>)` must read the commit `004f99c8e1c8`, not the
  tag object `e917d910f283`.
