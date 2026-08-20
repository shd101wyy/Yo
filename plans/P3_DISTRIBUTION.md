# P3 — distribution: installers, the releases channel, static musl

**Working doc for Phase 3 of
[`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).** Same contract
as `P1_CLI_PARITY.md`/`P2_RETIRE_SRC.md`: measured numbers, live status,
traps recorded as found. Drafted 2026-08-11; **item 1 landed 2026-08-12**.

## CRITICAL PATH 2026-08-15 — cutting a release is now the blocker

Four P3 deliverables are built, committed and CI-verified, and every one of them
is inert until a release runs, because each is produced, deployed, or carried to
users only by `release.yml`:

| Deliverable                | Produced by               | Status until a release runs                         |
| -------------------------- | ------------------------- | --------------------------------------------------- |
| single-file `yo.c`         | `portable-c` job          | `yo-v*.c.gz` 404s on EVERY published release        |
| static musl bundle         | `musl-bundle` job         | Alpine users get the unusable glibc bundle          |
| `…github.io/Yo/install.sh` | Pages deploy in `release` | 404 — READMEs must use the raw URL                  |
| Windows big-stack `main`   | a release + SEED bump     | the windows CI leg stays red (crash is in the SEED) |

That last row is a different shape from the other three but the same blocker:
the fix is in the codegen, so it reaches users only through a binary BUILT by
the fixed codegen. Same reason a compiler fix cannot fix a CI step running the
seed — see `issues/compiler-holds-emit-memory-during-cc.md`.

Measured, not assumed: `yo-v0.2.4.c.gz` and `yo-v0.2.3.c.gz` both return 404,
and `v0.2.4`'s asset list is five platform bundles plus the `.vsix`.

The user-visible consequence is the sharp one: **`--from-source` cannot work
against any existing release**, and that is precisely the path NixOS and Alpine
users are told to take, since no prebuilt bundle runs for them. So the platforms
with no other option are the ones with nothing at all until a release ships.
`install.sh` at least fails honestly there ("may predate the single-file yo.c
artifact"), and both READMEs now state the constraint.

None of this is fixable by more code. The next action for P3 is to **cut a
release**, then verify on it, in order: `portable-c` uploaded `yo.c.gz`;
`musl-bundle` uploaded and smoked; the Pages site serves `/install.sh`; bump
`SEED_VERSION` and confirm the windows leg goes green; then switch both READMEs
to the canonical URL and promote `musl-bundle` off `continue-on-error`.

### Scoreboard after 2026-08-15

| item                  | state                               |
| --------------------- | ----------------------------------- |
| 1 — install scripts   | LANDED; unification DONE 2026-08-15 |
| 2 — `yo version`      | DONE                                |
| 3 — static musl       | DONE, proof release-gated           |
| 4 — release hardening | DONE, windows leg release-gated     |

**P3 engineering work is complete.** Everything outstanding is waiting on a
release, not on code.

### Installer/cache unification — DONE 2026-08-15

The gap: `install.sh` lays versions out at `<prefix>/lib/yo/<tag>` while
`yo version install X` writes `<cache_root>/versions/<version>`. Both are the
same shape — a plain bundle extraction — but nothing looked in the installer's
root, so a `.yo-version` pin could not see a script-installed version and
`yo version list` omitted the very version the user was running.

Resolved by **deriving** the install root rather than configuring it: a
script-installed compiler runs from `<prefix>/lib/yo/<tag>/bin/yo`, so it
recovers its own root by walking up from `current_exe()` and checking the
`lib/yo` shape. Nothing has to be passed in and it works for any `--prefix`.
`install.sh` needed no change at all, which is the sign the direction was right.

- `get_install_versions_dir()` / `get_install_version_dir()` (`cache.yo`) —
  `.None` when the layout does not match (bundle run in place, dev build out of
  `yo-out/`, binary copied to `/tmp`), so callers fall back to exactly the
  previous cache-only behaviour.
- `is_version_cached` consults the install root FIRST, then the cache.
- `resolve_version_dir` (new) returns whichever holds the version, install
  root winning.
- `list_cached_versions` unions both roots, de-duplicated.

**Deliberately NOT the other direction** (installing into the version cache).
A cache is by definition safe to delete — `yo version clean` removes the whole
versions tree — so installing there would let a routine cache clean delete the
user's actual installation.

**Also deliberately unchanged:** `yo version install X` still downloads into the
cache, not the install root. Writing to the install root can require sudo for a
system prefix (`--prefix=/usr/local`), and a download command that sometimes
needs privileges is worse than one that never does. Reading from both roots is
what users needed; writing to both is not.

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
or Developer Mode).

**RESOLVED 2026-08-15** — see "Installer/cache unification" above. The
prediction here held exactly: the layout IS per-version and IS a plain bundle
extraction, so it was a re-rooting rather than a rewrite. Of the two options
floated, "teach the cache about the install root" was taken; installing into
the cache was rejected because `yo version clean` may delete a cache and must
never be able to delete an installation. The root is DERIVED from
`current_exe()`, so `install.sh` did not change.

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

- ~~Hosting at the Pages site root~~ **DONE 2026-08-15**:
  `scripts/build-site.ts` copies `install.sh` + `install.ps1` to the site root
  (and THROWS if either is missing — a silently absent installer would make the
  documented one-liner pipe a 404 page into `sh`). **Not live yet**: Pages
  deploys only from `release.yml`, and
  `https://shd101wyy.github.io/Yo/install.sh` was verified to 404 today, so
  both READMEs deliberately use the raw GitHub URL until a release deploys the
  site. See the critical-path section at the top.
- The optional `--vscode` flag (`code --install-extension`).
- Unifying with the version cache (above).

## Item 2 — `yo version` re-pointed at GitHub Releases (URGENT)

**LANDED in both compilers (discovered already-done 2026-08-17 — the
paragraph below was stale):** `src/version-cache.ts` and
`yo-self/version_cache.yo` both implement the redesign (native-bundle cache
layout `~/.cache/yo/versions/<v>/bin/yo`, GitHub Releases API for `list
--remote` with the rate-limit 403 message, `MIN_BUNDLE_VERSION = 0.2.1`
guard for the dead npm era). The last gap — the differential cases this
item specified — is closed by `tests/cli-cases/version-list-empty`
(deterministic, no network) and `tests/cli-cases/version-install-pinned`
(`network=1`: install 0.2.1 → list → clean against the real Releases
channel).

The original redesign, for the record:

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

**The "unexplained green" at v0.2.7 is EXPLAINED (2026-08-17), and the leg is
promoted.** Every prior red release run's musl log dies on `duplicate
'static'` in the emitted C — the GCC comptime-prototype blocker
(`issues/fixed/comptime-only-prototype-breaks-gcc.md`): Alpine's `cc` is GCC,
which made this job the SECOND GCC-family consumer after portable-c, and the
musl job's Yo->C step runs the compiler built from the RELEASED commit (not
the seed), so PR #130's fix — the only substantive commit between the last
red run 31909103188 and the first green 31925643271 — took effect at v0.2.7.
Confirmed by a fresh emit with zero `static inline // Unknown type`
prototypes and by the PR-side musl leg's consecutive greens. Accordingly the
release job is `continue-on-error: false` and in `publish-release`'s `needs`
(the pairing its comment required), and its emit is now SEED-driven (bun/node
retired from the job).

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

### Validation results (PR #169, 2026-08-19/20) — musl-only is VIABLE

Measured by a temporary CI job that ran the same self-emit with both v0.2.11
bundles on one runner, with identical swap/zswap/THP treatment on both arms (or
the experiment measures the treatment, not the libc). **The job has since been
deleted — it cost 76 minutes on every PR, which is only worth paying to answer a
question once.** These are its results.

| run | glibc wall | musl wall | glibc peak RSS | musl peak RSS |
| --- | --- | --- | --- | --- |
| 1 | 11:25.11 | 11:44.68 | 15,336,652 KB | 15,616,880 KB |
| 2 | 8:18.57 | **7:56.17** | 15,359,036 KB | 15,413,364 KB |

**The two runs disagree on the SIGN**, so the libc difference is smaller than
runner-to-runner variance on GitHub hosted runners. Do not quote either delta as
"musl costs N%" — n=1 is not a measurement here. What both runs agree on:

- **`EMIT IDENTICAL`** — the two seeds produce byte-identical C. This is the
  decisive check: identical output means the musl bundle is a drop-in
  replacement, and only cost was ever left to argue about.
- Peak RSS within ~2%.
- `file` confirms the shapes: musl `statically linked`; glibc
  `dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2` — the NixOS
  failure in one line.

Checklist status, against the three items named above:

| check | status |
| --- | --- |
| io_uring under musl | DONE — the musl smoke test greps for `liburing not available` |
| mimalloc under musl | DONE — the smoke test greps for `mimalloc: error` |
| `std/sys/dns` NSS | MOOT — the compiler shells out to `curl` (`version_cache.yo:439`) and `git`; its own `getaddrinfo` reference comes from the codegen runtime template emitted into USER programs, which use their own libc |
| worker-thread stack sizing | **ANSWERED 2026-08-20 — HONOURED on both arches, see below** |

### ANSWERED: the stack request IS honoured under musl

Measured against the **shipped v0.2.12 bundles** by
`.github/workflows/probe-musl-stack.yml` (dispatch-only; runs 32340613649 and
32340649947). Both bundles were confirmed `statically linked` before the probe
ran:

| target | `YO_MAIN_STACK_MB=1` | `=64` | verdict |
| --- | --- | --- | --- |
| `linux-x64-musl` | rc=139 | rc=0 | HONOURED |
| `linux-arm64-musl` | rc=139 | rc=0 | HONOURED |

The discrimination is real — 1 MB genuinely SIGSEGVs and 64 MB genuinely passes
— which is exactly what the two earlier attempts below could not produce.

**METHOD NOTE, and it is load-bearing:** the probe must run INSIDE Alpine, where
`cc` is musl gcc. Running the same static musl `yo` on the Ubuntu host would
compile the probe program against the host's GLIBC, measuring the wrong libc and
reporting a confident, meaningless pass.

**This was the last open gate on the musl-only migration.** Perf is noise (two
A/B runs disagree on sign), the emitted C is byte-identical, and static-linking
caveats do not apply because the compiler shells out to `curl` rather than
linking a resolver. Nothing remains to measure.

### Musl-only migration — EXECUTED 2026-08-20 (branch `release/musl-only-linux`)

The migration is a REMOVAL, not a rename — the musl bundles keep their `-musl`
suffix and the glibc bundles stop being published:

- `release.yml`: the glibc `seed-bundles` job (its only two legs were
  linux-x64/linux-arm64) is DELETED. What it carried moved into `musl-bundle`,
  which is now THE Linux release leg pair: the stage-2 re-emit gate runs
  against the static candidate, and the portable-c arms (`linux-x64`,
  `linux-arm64`, system-allocator flavored as before) are emitted at the end
  of that job. `portable-c` and `publish-release` needs rewired.
- `install.sh`: musl-first on EVERY Linux (the static bundle runs on glibc
  hosts too), with the glibc name as a fallback for releases that predate the
  musl legs (x64: v0.2.7+, arm64: v0.2.12+).
- `src/version_cache.yo`: `host_bundle_name` appends `-musl` on Linux;
  `download_version` falls back to the pre-musl name on 404 so old versions
  stay installable.
- `install-seed` action: Linux seeds are the musl bundles (static — no
  liburing.so needed to run them).
- `test.yml` musl job: the stack-sizing probe
  (`scripts/bootstrap/probe-stack-sizing.sh`) now runs per PR inside Alpine —
  the gate this section answered, kept honest continuously.

First release with no glibc Linux bundles: the one cut after this lands.

### The question, and the two attempts that failed to answer it (historical)

Codegen requests a 1 GiB worker stack and **falls back silently** to
`__yo_main_thread_entry(NULL)` on the ~8 MB process stack when `pthread_create`
fails. A musl build that ignored the request would therefore pass ordinary
workloads and SIGSEGV (rc=139, no message) on deep comptime recursion — the
Windows failure in `issues/windows-no-main-worker-stack-rc139.md`.

Two attempts failed to probe it, both reporting themselves inconclusive rather
than passing green:

1. A single 8 MB run: useless, because 8 MB is also what the fallback yields.
2. A downward sweep (1/2/4/8 MB) comparing both libcs' failure thresholds:
   `0 0 0 0` for BOTH. `check ./yo-self` needs under 1 MB at `-O2` — LLVM stack
   coloring shrinks frames ~100x versus the `-O0` case that originally exposed
   the stack ceiling — so no threshold hunt with this workload can discriminate.

**The probe now exists and is validated:**
`scripts/bootstrap/probe-stack-sizing.sh <path-to-yo>`. It compiles a program
that recurses 500,000 deep (~12 MB of frames), runs it at `YO_MAIN_STACK_MB=1`
and `=64`, and requires the outcomes to DIFFER. Every compiled Yo program runs
`main` on the same worker thread, so this exercises the identical codegen path
in seconds rather than the 76 minutes the A/B cost.

Measured on macOS/arm64 with the **v0.2.11** bundle:

| `YO_MAIN_STACK_MB` | rc |
| --- | --- |
| 1 | 138 (crash) |
| 4 | 138 (crash) |
| 16 / 64 / 256 | 0 |

Threshold between 4 and 16 MB, consistent with 500k frames at ~24 bytes. **The
request is honoured there.** The same probe has since been run against the
STATIC MUSL bundles on Linux — the actual open question — and it is honoured on
both arches; see the answered section above.

**The trap the script encodes**, because the first two attempts at this both
failed: "non-tail recursion" is not sufficient. `n + recur(n - 1)` is linearised
by LLVM's accumulator tail-call transform (addition is associative), and the
probe then reports 500,000 frames fitting in 1 MB — 2 bytes per frame, i.e. no
recursion happened at all. The fix is an `inout` local whose address escapes,
which pins one real frame per level. A probe that cannot fail proves nothing;
check the arithmetic of bytes-per-frame before believing a green result.

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
io_uring is IN rather than stubbed.

### VERDICT 2026-08-15 — the leg is GREEN; item 3 is de-risked

Run 31863256060 reported `Static musl Linux bundle (build + run, no publish) =>
success` with all three traps cleared. That was the last precondition stated
above, so the design is now proven end-to-end in CI:

- glibc host emits the C, Alpine compiles it against static liburing,
- `file` reports `statically linked`,
- the io_uring assertion passes on a binary that genuinely contains it, under
  `seccomp=unconfined` so the profile cannot mask a stub.

### Item 3 COMPLETE 2026-08-15 — published and selectable

Both remaining halves landed the same day:

- **`release.yml` grows a `musl-bundle` job** — emit C on the glibc host, link
  statically in Alpine, assemble `bin/`+`std/`+`vendor/mimalloc`, smoke it ON
  Alpine, upload as `yo-v<ver>-linux-x64-musl.tar.gz`. EXPERIMENTAL on arrival
  (`continue-on-error: true`), as windows-x64 was.

  It is deliberately **not** in `publish-release`'s `needs`. `continue-on-error`
  keeps a failure from failing the workflow, but the job's result is still
  `failure`, and a dependent whose `needs` resolves to failure is SKIPPED — so
  listing it would let a broken experimental leg block publication outright.
  Move it into `needs` in the same commit that flips the flag off.

- **`install.sh` can now select it.** It previously detected Alpine only to warn
  that the glibc binary would not run, then pointed at a source build. It now
  probes for the musl bundle (header-only request, so an absent optional asset
  is free), prefers it, and falls back to glibc WITH a warning when a release
  has none — the situation for every release so far. The `--from-source` advice
  is suppressed on musl, where it would send a user to a build they no longer
  need; NixOS still gets it, which is the case it genuinely fixes.

- **Alpine coverage added** to `install-scripts.yml`. The posix matrix is
  glibc-only, so every musl branch in `install.sh` had been dead code no CI run
  executed. The new job is dry-run — a real install cannot succeed until a
  release publishes the bundle — but asserts what regresses silently: musl
  detected through `ldd --version` (stderr, non-zero exit), a bundle still
  chosen, and the source-build advice suppressed.

**First real proof still pending:** no release has published a musl bundle yet,
so the upload + Alpine smoke path runs for the first time on the next release.
Watch that job, and promote it off `continue-on-error` once it is green.

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
