# P3 — distribution: installers, the releases channel, static musl

**Working doc for Phase 3 of
[`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).** Same contract
as `P1_CLI_PARITY.md`/`P2_RETIRE_SRC.md`: measured numbers, live status,
traps recorded as found. Drafted 2026-08-11; **item 1 landed 2026-08-12**.

## What P2 already delivered that P3 builds on

- **Every release since v0.2.1 ships all five native bundles** (linux-x64,
  linux-arm64, macos-arm64, macos-x64, windows-x64 — current: **v0.2.3**),
  each `bin/yo` + `std/` + `vendor/mimalloc/` + LICENSE, **self-locating**
  (`--std-path` → `YO_STD` → exe-relative walk-up → `./std`) — an installer
  only extracts and puts `bin/` on PATH.
- **Releases are atomic** (draft until required legs upload, then a publish
  job flips it) — `latest` can never point at a bundle-less release, which
  is the invariant `install.sh` needs.
- **npm publishing stopped at v0.2.0** — the npm-based `yo version` cache is
  dead for new versions, making item 2 here the most urgent.
- Release-pipeline traps already handled: personal-repo rulesets can't
  bypass the Actions integration (bump lands via `[skip ci]` PR; gate falls
  back to the parent SHA); `macos-26-intel` is the last Intel runner label.

## Item 1 — install scripts — **LANDED 2026-08-12**

`scripts/install.sh` (POSIX sh) + `scripts/install.ps1` (PowerShell — the
planned `.bat` was skipped; PowerShell ships everywhere Windows CI and users
actually are). Note the paths are `scripts/`, not `util/`.

Delivered: `--version` (default latest) / `--prefix` / `--uninstall` /
`--force` / `--quiet` / `--dry-run` / `--no-deps` / `--no-verify`, os/arch
sniffing, sudo only when the prefix is not writable, PATH guidance, and
dependency installation across apt/dnf/zypper/pacman/apk/yum.

**Verification compiles and runs a hello world** rather than checking a
version string — a downloaded binary is not a working install unless `std`
resolves, the vendored mimalloc is found, and the C compiler links.
`.github/workflows/install-scripts.yml` runs both scripts on all five
platforms against the REAL published bundles, plus weekly; each job also
compiles from a directory with no `./std`, so a broken std-resolution cannot
hide behind a fallback.

### The deviation this doc warned about

> "Install INTO the per-version cache layout … a `--prefix`-only installer now
> would be rework."

That is what shipped: `<prefix>/lib/yo/<tag>/{bin,std,vendor}` with a
`<prefix>/bin/yo` symlink (a `.cmd` shim on Windows, where symlinks need admin
or Developer Mode). So the installer and `yo version install X` are still two
mechanisms, and `.yo-version` pinning does not yet work for script-installed
versions.

The rework is smaller than feared: the layout IS per-version and IS a plain
bundle extraction — the same shape item 2 specifies — so unification is a
**re-rooting** (point the installer at the version-cache root, or teach the
cache about the install root), not a rewrite. Do it as part of item 2, which
has to touch both sides anyway.

### Dependencies — measured against the shipped compiler, not assumed

| dependency                | why                                                                               | without it                  |
| ------------------------- | --------------------------------------------------------------------------------- | --------------------------- |
| clang / gcc               | `yo compile` invokes `clang` by default (`yo-self/main.yo:747`)                   | cannot compile at all       |
| **git**                   | `yo fetch` / `yo install` shell out to `git ls-remote`/`clone`/`fetch`/`checkout` | dependency management fails |
| liburing **+** pkg-config | async I/O (io_uring) on Linux                                                     | see below                   |

**Stronger than "async I/O is degraded": the published Linux bundle does not
start at all without `liburing.so.2`.** Measured 2026-08-15 on a CI runner
that lacked it:

```
yo: error while loading shared libraries: liburing.so.2:
    cannot open shared object file: No such file or directory
```

The bundle is built on a box that HAS liburing, so it links against it
dynamically; the `#if __has_include` fallback only applies when the C is
compiled, and by then the choice is baked into the artifact. So liburing is a
**hard runtime dependency of the release binary**, not merely a feature
toggle. Note the exit code is **127**, which reads exactly like
`yo: command not found` and will send an investigation hunting a PATH bug —
it did; see `issues/fixed/musl-job-seed-needs-host-liburing.md`. This is one
more argument for item 3: a static binary has no such dependency.

**liburing and pkg-config must be installed as a pair.** The emitted C gates
its io_uring calls on `#if __has_include(<liburing.h>)`, while `-luring` is
added only when `pkg-config --exists liburing` succeeds. A box with the header
but no pkg-config therefore emits io_uring calls and fails to link them
(`undefined reference to io_uring_peek_batch_cqe`) — the header WITHOUT
pkg-config is strictly worse than neither. The installer installs both and
warns when it finds that combination already present.

### Immutable distributions

NixOS, SteamOS, ostree systems (Silverblue/Kinoite/Bazzite) and openSUSE
MicroOS get detected FIRST — several also match a classic family (SteamOS is
Arch, Bazzite is Fedora), so family matching alone misroutes them — and are
given targeted advice instead of a package manager, since imperative installs
there either fail or are reverted by the next update.

On NixOS there is a second, harder problem that no package can fix: see item 3.

### Still open on item 1

- Hosting at the Pages site root, so the canonical one-liner is
  `curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh`
  (`scripts/build-site.ts` grows a copy step). Today the URL is the raw
  GitHub one.
- The optional `--vscode` flag (`code --install-extension`).
- Unifying with the version cache (above).

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

**Priority raised 2026-08-12: there are now two distinct distros where the
shipped Linux bundle cannot run, not one.** Measured on the published
`yo-v0.2.3-linux-x64.tar.gz`:

```
bin/yo: ELF 64-bit LSB pie executable, x86-64, dynamically linked,
        interpreter /lib64/ld-linux-x86-64.so.2
```

- **Alpine/musl** — the known case: different ld.so and symbol versioning.
- **NixOS** — `/lib64/ld-linux-x86-64.so.2` does not exist there at all (the
  loader lives in `/nix/store`), so the binary fails to `exec` with
  `No such file or directory` while the file is plainly present. This is
  unfixable by any package the installer could install; the workarounds are
  `steam-run`, `programs.nix-ld.enable`, or `patchelf --set-interpreter`. A
  static binary needs no interpreter and sidesteps it entirely.

The installer warns about both today (it checks for the loader up front), but
a warning is a workaround, not a fix — item 3 is the fix.

One fully static musl binary per arch (Zig/Deno/Bun model) replaces both
glibc Linux legs. Constraints (from `BUILD_SYSTEM.md` + the plan):

- Yo cannot cross-compile gnu→musl — release CI builds inside an Alpine
  container (`container:` on the linux legs, or a docker-run step).
- `liburing` must be statically linked; validate io_uring, mimalloc, and
  worker-thread stack sizing under musl once (`x86_64-linux-musl` target
  exists for this).
- User programs are unaffected (compiled on the user's machine against
  their libc) — this is only the `yo` binary's portability.
- Fallback if musl validation surfaces real problems: Koka-style separate
  `-gnu`/`-musl` bundles + distro sniffing in install.sh.

### The trap: no musl liburing ⇒ a binary that links fine and cannot work

**Established 2026-08-15 by reading the emitter, not by guessing.** The Linux
async runtime is included conditionally:

```c
#if __has_include(<liburing.h>)   // src/codegen/async/runtime-io-linux.ts:537
```

and the `#else` arm (`:1486`) replaces the whole subsystem with stubs whose
init does nothing but

```c
fprintf(stderr, "[Yo] Warning: liburing not available, async I/O disabled\n");
```

The self-hosted compiler reads EVERY source file through
`io.await(read_file(...))` (`yo-self/module_manager.yo`), so a static-musl
build produced without a musl liburing would **link cleanly, ship, and then
fail to compile anything** — with a warning on stderr as the only clue. The
liburing probe is `pkg-config --exists liburing` (`yo-self/main.yo:841`), so
it degrades silently rather than failing the build.

**Therefore the musl leg MUST assert io_uring is IN the binary**, not merely
that the binary is static. Cheapest honest assertion: grep the emitted C for
`__YO_HAS_LIBURING`-guarded symbols, or run the built binary and fail if
`liburing not available` appears on stderr.

### Design that avoids the seed chicken-and-egg (no gcompat)

The seed is a glibc binary, so it cannot run inside Alpine — which is why
"build the musl bundle in an Alpine container" stalls. Split the pipeline at
the C boundary instead, which the toolchain already supports:

1. **On ubuntu-latest (glibc):** the seed does Yo→C only —
   `yo compile yo-self/main.yo --release --allocator mimalloc --std-path ./std
--emit-c --skip-c-compiler -o yo-musl`. (Precedent: `fixpoint_only.sh` is
   emit-only for the same reason, and P2.5 step 24b keeps it that way.)
2. **In an Alpine container:** compile that C with musl + STATIC liburing
   (`apk add build-base liburing-dev liburing-static`), plus mimalloc's
   `static.c`, linking `-static`.
3. **Assert, in Alpine:** `file` reports `statically linked`, the binary runs
   with no interpreter, `yo check std/assert.yo` succeeds, and stderr carries
   NO "liburing not available" warning.

This is PR-verifiable without publishing anything, so item 3 can be de-risked
in normal CI before `release.yml` grows the leg.

**Not locally testable on this machine** (macOS, no container runtime), so it
must be iterated in CI.

### Status 2026-08-15 — the pipeline works; three traps found by running it

The PR-CI leg now gets all the way to a **statically linked musl binary with
io_uring genuinely compiled in**. Three failures had to be cleared, each a real
trap rather than a typo:

1. **The seed could not start** — exit 127, `yo: error while loading shared
libraries: liburing.so.2`. The published Linux bundle links liburing
   dynamically, so the emit host needs it installed even though this job only
   uses the seed to emit C. Exit 127 reads as "command not found", which sent
   the first look at PATH. (`issues/fixed/musl-job-seed-needs-host-liburing.md`)
2. **`liburing-static` does not exist on Alpine.** Debian splits static libs
   into a `-static` package; Alpine ships `liburing.a` inside `liburing-dev`.
   The job now asserts `/usr/lib/liburing.a` exists rather than discovering its
   absence as a link error 140 MB into a compile.
3. **Docker's default seccomp profile blocks `io_uring_setup`**, so the built
   binary died with `io_uring_queue_init failed: Operation not permitted`.
   Note the shape of this one: the default profile fails exactly the binaries
   this assertion exists to bless, and would happily pass a stubbed-out one.
   The assert container now runs with `--security-opt seccomp=unconfined`.

What is proven so far: the split-at-the-C-boundary design works (glibc host
emits, Alpine compiles), the result is `statically linked` per `file`, and
io_uring is IN rather than stubbed. What remains is one green run of the
assertion, after which `release.yml` can grow the leg.

## Item 4 — release hardening (carried from P2 notes)

- **Per-platform fixpoint — DONE 2026-08-15**, as
  `.github/workflows/fixpoint-arm64.yml` (weekly + `workflow_dispatch`, not a
  required check).

  **Scope narrowed by measurement, and the narrowing is the finding.** A
  self-emit peaks ABOVE 15 GB, not the 9-11.5 GB recorded here: run
  31856743929 watched ubuntu-latest climb to 15,541 MB of 15,988 and die when
  its own allocation failed (dmesg showed no oom-kill). macOS runners have
  ~7 GB and no way to add a swapfile, so **macOS and Windows cannot host a
  fixpoint on standard runners at all** — the same wall that forced test.yml's
  `test` matrix to stop self-building there. "Per-platform" therefore means the
  two Linux arches; x86_64 is already covered per-PR, so the new job covers
  linux-arm64.

  arm64 earns its own job because the compiler's emit is NOT arch-independent:
  `yo-self/target.yo:165-184 detect_host()` folds `arch ==` into a comptime
  constant, so the x64 and arm64 emissions differ by construction, and nothing
  else in CI checks that the arm64 self-emit reaches a fixpoint.

- **The windows rc=139 follow-up — FIXED 2026-08-15**, and it was not an
  error-path bug at all. `main` ran on Windows' 1 MB process default stack
  because the big-stack worker thread was gated on `isTargetPosix`, and
  `YO_MAIN_STACK_MB` was read only inside that arm — so the knob was silently a
  no-op on Windows. Now a `CreateThread` worker with `dwStackSize`, in both
  compilers. See `issues/windows-no-main-worker-stack-rc139.md`.

  **Sequencing:** the CI leg stays red until a release ships this and
  `SEED_VERSION` bumps, because the crash is in the released SEED, built by the
  old codegen. That is release ordering, not an outstanding defect.

## Gate

Fresh VM/container per platform: `curl … | sh` (or `install.bat`), then
`yo init && yo build test` succeeds with no toolchain present except a C
compiler (document clang/gcc as the one prerequisite). Alpine is one of the
containers (proves musl). `yo version install <prev>` + `.yo-version`
pinning round-trips.

## Sequencing

**Superseded 2026-08-12 — item 1 shipped first.** The original order put item 2
first so the installer could be built over the version cache; in practice the
installer landed standalone because it depends only on the published bundles.
That cost the unification, which item 2 now has to absorb (a re-rooting — see
item 1).

Revised order:

1. **Item 2** (`yo version` on GitHub Releases) — still the most urgent, since
   npm publishing stopped at v0.2.0 and `version list --remote` / `version
install` are dead for every version since. Fold the installer re-rooting
   into it so the two front-ends converge.
2. **Item 3** (static musl) — raised in priority: it is the only real fix for
   both Alpine AND NixOS, and the installer names stay `linux-<arch>`, so it
   needs no installer change.
3. **Item 4** (release hardening) opportunistically.

P4 (LSP) stays separate — see [`P4_LSP.md`](P4_LSP.md).
