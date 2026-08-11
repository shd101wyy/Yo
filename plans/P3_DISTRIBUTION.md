# P3 — distribution: installers, the releases channel, static musl

**Working doc for Phase 3 of
[`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).** Same contract
as `P1_CLI_PARITY.md`/`P2_RETIRE_SRC.md`: measured numbers, live status,
traps recorded as found. Drafted 2026-08-11, while P2's last blocker (the
seed-trust UAF) was in flight.

## What P2 already delivered that P3 builds on

- **v0.2.1 ships all five native bundles** (linux-x64, linux-arm64,
  macos-arm64, macos-x64, windows-x64), each `bin/yo` + `std/` +
  `vendor/mimalloc/` + LICENSE, **self-locating** (`--std-path` → `YO_STD` →
  exe-relative walk-up → `./std`) — an installer only extracts and puts
  `bin/` on PATH.
- **Releases are atomic** (draft until required legs upload, then a publish
  job flips it) — `latest` can never point at a bundle-less release, which
  is the invariant `install.sh` needs.
- **npm publishing stopped at v0.2.0** — the npm-based `yo version` cache is
  dead for new versions, making item 2 here the most urgent.
- Release-pipeline traps already handled: personal-repo rulesets can't
  bypass the Actions integration (bump lands via `[skip ci]` PR; gate falls
  back to the parent SHA); `macos-26-intel` is the last Intel runner label.

## Item 1 — `util/install.sh` + `util/install.bat` (Koka model)

Reference: `~/Workspace/koka/util/install.sh` (719 lines) / `install.bat`
(610). Shape to copy: single POSIX-sh script, curl-pipe-able,
version-selectable (`--version vX.Y.Z`, default latest), `--prefix`
override (`/usr/local` default; `%LOCALAPPDATA%\yo` on Windows), uninstall
mode, dry-run, os/arch sniffing, PATH guidance, optional `--vscode` flag
(`code --install-extension`).

- Download URL: `https://github.com/shd101wyy/Yo/releases/download/<tag>/yo-<tag>-<os>-<arch>.tar.gz`
  (exactly what the seed jobs publish today).
- **Install INTO the per-version cache layout** (item 2's layout), with a
  `yo` shim on PATH that resolves `.yo-version` pins — the installer and
  `yo version install X` become two front-ends to one mechanism. Do item 2
  first or together; a `--prefix`-only installer now would be rework.
- Host both scripts at the Pages site root (`scripts/build-site.ts` grows a
  copy step); the canonical one-liner
  `curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh` stays stable
  across releases while release CI bumps the default version inside it.

## Item 2 — `yo version` re-pointed at GitHub Releases (URGENT)

Today (`src/version-cache.ts` + `yo-self/version_cache.yo`):
`~/.cache/yo/versions/<version>/` holds an **npm package** (package.json +
node_modules) and downloads from the npm registry — dead for ≥ v0.2.0.

Redesign:

- Cache layout becomes the native bundle: `~/.cache/yo/versions/<v>/bin/yo`
  - `std/` + `vendor/` (exactly a bundle extraction; self-locating, so no
    per-version env wiring).
- `version list --remote` reads the GitHub Releases API (no auth for public
  repos; handle rate-limit 403 gracefully).
- `version install X` downloads + extracts the bundle for the HOST platform
  (reuse the os/arch sniff from item 1 — implement once in Yo, both
  front-ends call it).
- `.yo-version` pinning semantics unchanged; the shim (`yo-cli` bash /
  `yo-cli.ps1`, re-pointed at native binaries by 2.5) resolves the pinned
  version's `bin/yo`.
- BOTH compilers until 2.5 lands (src/version-cache.ts + version_cache.yo,
  1:1); differential cases for `version list`/`install` (network-gated,
  `network=1` in the corpus opts).

## Item 3 — static-musl Linux bundles

One fully static musl binary per arch (Zig/Deno/Bun model) replaces both
glibc Linux legs; a glibc `yo` cannot run on Alpine (different ld.so +
symbol versioning). Constraints (from `BUILD_SYSTEM.md` + the plan):

- Yo cannot cross-compile gnu→musl — release CI builds inside an Alpine
  container (`container:` on the linux legs, or a docker-run step).
- `liburing` must be statically linked; validate io_uring, mimalloc, and
  worker-thread stack sizing under musl once (`x86_64-linux-musl` target
  exists for this).
- User programs are unaffected (compiled on the user's machine against
  their libc) — this is only the `yo` binary's portability.
- Fallback if musl validation surfaces real problems: Koka-style separate
  `-gnu`/`-musl` bundles + distro sniffing in install.sh.

## Item 4 — release hardening (carried from P2 notes)

- Per-platform fixpoint (byte-identity) as a scheduled or release-time job
  with the linux job's memory tuning — each self-emit holds ~9-11.5 GB, so
  it cannot ride the 7 GB suite runners (P2_RETIRE_SRC.md §2.2 note).
- The windows error-path rc=139 follow-up (probe SEGV on a failed child
  compile) — issues/fixed/windows-native-selfhosted-build-fails.md
  iteration-3 note.

## Gate

Fresh VM/container per platform: `curl … | sh` (or `install.bat`), then
`yo init && yo build test` succeeds with no toolchain present except a C
compiler (document clang/gcc as the one prerequisite). Alpine is one of the
containers (proves musl). `yo version install <prev>` + `.yo-version`
pinning round-trips.

## Sequencing

Item 2 first (it unblocks version management NOW and defines the cache
layout item 1 installs into) → item 1 (installer over that mechanism) →
item 3 (musl bundles; installer needs no change if names stay
`linux-<arch>`) → item 4 opportunistically. P4 (LSP) stays separate.
