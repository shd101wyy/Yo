# One broken third-party apt source takes out every Linux CI job

**Status:** FIXED 2026-09-10 (observed 2026-09-09/10; hit #522, #526 and #529 simultaneously).

## Symptom

Every Linux-based job fails in its dependency step, before any Yo code runs:

```
Get:29 https://dl.google.com/linux/chrome-stable/deb stable/main amd64 Packages [1405 B]
Err:29 https://dl.google.com/linux/chrome-stable/deb stable/main amd64 Packages
  Hash Sum mismatch
  Hashes of expected file:
   - Filesize:1405 [weak]
   - SHA256:233e56de019b57db89238fa7bcc3647718dbbea3a40c2dc1c633a8c8952aa9e9
...
E: Failed to fetch https://dl.google.com/linux/chrome-stable/deb/dists/stable/main/binary-amd64/Packages.gz  Hash Sum mismatch
E: Some index files failed to download. They have been ignored, or old ones used instead.
##[error]Process completed with exit code 100.
```

The blast radius is the whole run, not one job. "Build the suite candidate
(Linux, shared by the cross-emits)" dies on this, and then every leg that
consumes its artifact fails with a DIFFERENT and misleading error:

```
##[error]Unable to download artifact(s): Artifact not found for name: suite-c-macos-arm64
```

so `test (macos-latest)` looks like a macOS regression when the cause is an apt
mirror. On #529 that produced 18 red checks from one root cause.

## Why the existing mitigation does not help

`APT_OPTS` already carries `-o Acquire::Retries=3` (test.yml:108 and the same
line in `fixpoint-arm64.yml`, `deploy-site.yml`). **A Hash Sum mismatch is
DETERMINISTIC** — the mirror is serving a `Packages.gz` whose bytes do not
match the hash in its own release index — so all three attempts re-download the
same bad file. Retries only help a flaky connection.

`apt-get update` exits **100 if ANY configured source fails**, even when every
source the build actually installs from succeeded.

## Root cause

The GitHub Ubuntu runner image ships third-party apt sources (Google Chrome,
and others depending on the image) under `/etc/apt/sources.list.d/`. This
repository installs only `liburing-dev`, `libssl-dev`, `pkg-config` and `time`
— all from Ubuntu's own archives. So a source that is never used can, and did,
fail the build.

## The fix

Drop the third-party lists this repo does not install from, before `update`:

```yaml
- name: Install Linux dependencies
  run: |
    # The runner image ships third-party apt sources (Google Chrome, ...) that
    # nothing here installs from, and `apt-get update` exits 100 if ANY source
    # fails. A Hash Sum mismatch on dl.google.com took out every Linux job on
    # 2026-09-09, and Acquire::Retries cannot help — a hash mismatch is
    # deterministic, so every retry re-fetches the same bad file.
    sudo rm -f /etc/apt/sources.list.d/*google*.list \
               /etc/apt/sources.list.d/*google*.sources
    sudo apt-get $APT_OPTS update
    sudo apt-get $APT_OPTS install -y liburing-dev libssl-dev pkg-config time
```

Both `.list` and `.sources` (deb822) forms, because newer images use the
latter.

Applied at all **20** `apt-get ... update` call sites:

| file | sites |
| --- | --- |
| `.github/workflows/test.yml` | 13 |
| `.github/workflows/release.yml` | 4 |
| `.github/workflows/fixpoint-arm64.yml` | 1 |
| `.github/workflows/deploy-site.yml` | 1 |
| `.github/actions/build-stage1/action.yml` | 1 |

**The composite action was the one that mattered and the one nearly missed.**
A first pass patched only the 19 `sudo apt-get $APT_OPTS update` lines in the
workflows, and the wasm legs still fell over — `.github/actions/build-stage1`
spells its flags out inline rather than reading the caller's `$APT_OPTS` (on
purpose: a composite action must not depend on an env var the caller happens to
define), so a grep for `$APT_OPTS` does not find it. Audit by matching
`apt-get` + `update` across `.github/**`, not by matching the env var.

The rationale lives with the existing `APT_OPTS` comment block (which already
documents the dpkg-lock hang, `issues/ci-apt-hangs-on-dpkg-lock.md`), so the
per-site line is one comment pointing back at it. Not factored into a composite
action: `APT_OPTS` is already duplicated per workflow the same way, and matching
that beats introducing a second mechanism for one `rm`.

## Rejected alternatives

- `apt-get update || true` — hides a genuine failure of a source the build
  DOES need, turning a clear error into a confusing "package not found" later.
- Pinning/refreshing the Google list — the repo has no reason to carry it at
  all.

## Verification

The fix is self-testing: a `pull_request` event runs the workflow from the PR's
own head, so this PR's own Linux legs exercise the pruned source list.

## Note for whoever touches this again

Workflow-touching PRs need care: `gh pr merge --admin` refuses a PR that
touches workflows while it is BEHIND the base, so bring the branch up to date
immediately before merging.
