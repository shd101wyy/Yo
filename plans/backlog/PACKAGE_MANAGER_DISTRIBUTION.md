# Package-manager distribution: Homebrew, Scoop, dpkg/apt, rpm/dnf, apk, pacman, nix

**Status: Backlog — written 2026-10-08, not started.** Nothing here drives
work until one of the per-channel start triggers in §8 fires. Whatever lands,
the `install.sh` / `install.ps1` installers and the `yo version` manager stay
the primary channels (§0).

## 0. The question first: are `install.sh` / `install.ps1` good enough?

Functionally, yes. Every capability a package manager would provide already
exists somewhere in the current channels:

| Capability            | Today                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| Install latest/pinned | `install.sh` (+`--version`), `install.ps1`, `yo version install <v>`         |
| Side-by-side versions | `yo version` (its whole purpose — `plans/reference/VERSION_MANAGEMENT.md`)   |
| Update                | re-run the installer / `yo version install <newer>` — no one-command upgrade |
| Uninstall             | `install.sh -u`, `yo version clean`                                          |
| System deps           | `install.sh` installs clang/git/pkg-config per distro itself                 |
| No native bundle      | `--from-source` from the published single-file C                             |

What package managers add is not function but:

- **Trust and normalcy.** `curl | sh` is a hard no for a real share of users;
  `brew install` / `apt install` is the expected shape on those platforms, and
  the trust transfer is to the manager rather than to an opaque pipe.
- **One-command upgrades** (`brew upgrade yo`, `scoop update yo`, `apt
  upgrade`) against a channel the user already polls.
- **Discoverability** (`brew search`, `scoop search`).
- **Declared dependencies** — the formula/manifest says what TLS needs instead
  of the binary warning at runtime.

**Position.** Keep `curl | sh` primary. When this plan is picked up: §2
(Homebrew tap) and §3 (Scoop bucket) first — two small companion repos plus one
release hook, near-zero steady-state cost, covering the two platforms where
users reach for a manager first. §4's system-package artifacts are next
cheapest. §5's hosted repositories are deliberately last and demand-triggered:
GPG key lifecycle and signed-index regeneration are a perpetual cost for a
single maintainer, and §4's artifact-only install already covers the need. §6
(nix) is one file in this repo.

## 1. Why every channel is cheap for Yo specifically

Four properties of the current release machinery do most of the work, and every
channel below consumes the SAME published assets — no compiler changes, no new
build paths.

1. **The assets already exist, per architecture, at stable versioned URLs**
   (v0.2.54 shown; `scripts/release_asset_triple.sh` is the naming authority):
   - `yo-v0.2.54-aarch64-apple-darwin.tar.gz` + `.c.gz`
   - `yo-v0.2.54-x86_64-apple-darwin.tar.gz` + `.c.gz`
   - `yo-v0.2.54-x86_64-pc-windows-msvc.tar.gz` + `.c.gz`
   - `yo-v0.2.54-aarch64-pc-windows-msvc.tar.gz` + `.c.gz`
   - `yo-v0.2.54-x86_64-unknown-linux-musl.tar.gz`,
     `yo-v0.2.54-aarch64-unknown-linux-musl.tar.gz` (statically linked; no
     musl `.c.gz` — the GNU arm is the portable one, and the same C compiles
     under either libc)
2. **The compiler is self-locating through symlinks and shims.**
   `resolve_std_path` (`src/module_manager.yo`) walks up from the running
   executable to find a sibling `std/`, and `current_exe` (`std/env.yo`) is
   symlink-resolved on macOS/Linux (`/proc/self/exe`; `_NSGetExecutablePath` +
   `realpath`) and returns the real module path on Windows
   (`GetModuleFileNameW`). Homebrew's `/opt/homebrew/bin/yo →
   ../Cellar/yo/<v>/bin/yo`, Scoop's shim and dpkg's `/usr/bin/yo` symlink all
   resolve back to the real tree, where the walk-up finds its data.
   `install.sh` ALREADY installs through a symlink (`~/.local/bin/yo →
   ~/.local/lib/yo/<tag>/bin/yo`), so the mechanism is field-proven, not
   hypothetical.
3. **The Linux bundle has zero runtime dependencies.** Static musl with
   OpenSSL compiled in (`openssl-libs-static`, asserted in the release job) —
   deb/rpm/apk/pacman packages carry no `Depends:` and no glibc/musl split.
4. **The license is packaging-clean**: `Apache-2.0 WITH LLVM-exception`, a
   valid SPDX expression every manager accepts.

**The one invariant every channel must respect: install the WHOLE bundle
tree, with the original sibling layout.** The bundle is `bin/` + `std/` +
`vendor/mimalloc/` + `pack/` + `docs/en-US/` + `.github/skills/` + `LICENSE.md`
as siblings (release.yml, "Assemble the bundle"). `yo skills install`, `yo
context` and `--allocator mimalloc` resolve those by the same walk-up; a
packaging step that cherry-picks `bin/`+`std/`, flattens or re-homes the tree
is wrong even when `yo --version` works.

Two platform notes the channels encode:

- The macOS bundle weak-links Homebrew's `openssl@3` (the TLS canary pattern:
  absent dylib ⇒ `__yo_tls_available()` reports false and remote `yo version`
  operations degrade with guidance). A formula therefore `depends_on
  "openssl@3"` not because the binary needs it to launch, but to keep the
  canary live.
- The Windows bundle links only system DLLs (ws2_32, bcrypt, advapi32,
  secur32, crypt32; TLS via Schannel) — nothing to declare in a Scoop
  manifest.

## 2. Homebrew tap (P1)

What the user types:

```bash
brew tap shd101wyy/yo   # clones github.com/shd101wyy/homebrew-yo (brew auto-prepends "homebrew-")
brew install yo
# or the one-liner with no prior tap:
brew install shd101wyy/yo/yo
```

A custom tap has no admission bar (homebrew-core's is a different thing — §8).

- [ ] Create `shd101wyy/homebrew-yo` with `Formula/yo.rb`, binary flavor:

```ruby
class Yo < Formula
  desc "The Yo programming language compiler"
  homepage "https://github.com/shd101wyy/Yo"
  url "https://github.com/shd101wyy/Yo/releases/download/v0.2.54/yo-v0.2.54-aarch64-apple-darwin.tar.gz"
  sha256 "…"                                # arm64 default; on_intel swaps URL+sha256
  version "0.2.54"
  license "Apache-2.0 WITH LLVM-exception"
  depends_on "openssl@3"                    # TLS canary liveness (§1), not launch

  def install
    # The WHOLE tree, dot-dir included — a bare Dir["*"] drops .github/ and
    # silently breaks `yo skills install` (§1's invariant).
    prefix.install((Dir["*"] + Dir[".*"]) - [".", ".."])
  end

  def caveats
    "Yo compiles to C11 and invokes clang; Apple's Command Line Tools provide it (xcode-select --install)."
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yo --version")
  end
end
```

- [ ] A source flavor (compile the published `yo-v<version>-<triple>.c.gz` with
      the formula's clang, ~a minute, `install.sh`'s `--from-source` flags) is
      the variant homebrew-core would require and a drop-in if that day comes;
      the tap starts binary because custom taps may ship binaries, and the
      bits then match the release CI's smoke-tested bundle exactly.

## 3. Scoop bucket (P2)

```powershell
scoop bucket add yo https://github.com/shd101wyy/scoop-yo
scoop install yo
```

- [ ] Create `shd101wyy/scoop-yo` with `bucket/yo.json`:

```json
{
  "version": "0.2.54",
  "description": "The Yo programming language compiler",
  "homepage": "https://github.com/shd101wyy/Yo",
  "license": "Apache-2.0 WITH LLVM-exception",
  "architecture": {
    "64bit": {
      "url": "https://github.com/shd101wyy/Yo/releases/download/v0.2.54/yo-v0.2.54-x86_64-pc-windows-msvc.tar.gz",
      "hash": "…",
      "extract_dir": "yo-v0.2.54-x86_64-pc-windows-msvc"
    },
    "arm64": {
      "url": "https://github.com/shd101wyy/Yo/releases/download/v0.2.54/yo-v0.2.54-aarch64-pc-windows-msvc.tar.gz",
      "hash": "…",
      "extract_dir": "yo-v0.2.54-aarch64-pc-windows-msvc"
    }
  },
  "bin": "bin\\yo.exe",
  "suggest": { "C compiler": ["llvm", "zig"], "VCS": ["git"] },
  "checkver": "github",
  "autoupdate": { "architecture": { "64bit": { "url": "…/v$version/yo-v$version-x86_64-pc-windows-msvc.tar.gz" } } }
}
```

- [ ] `extract_dir` strips the versioned top folder inside the tarball; the
      autoupdate template regenerates it (and the hashes) per release.
- [ ] `bin: bin\yo.exe` — Scoop's shim `CreateProcess`es the real exe, so
      `GetModuleFileNameW` resolves the app dir and the walk-up finds `std/`
      (§1).
- [ ] `suggest`, not `depends`: `llvm`/`zig` for the C compiler, `git` for
      dependency management.
- [ ] Scoop extracts `.tar.gz` through its 7-Zip dependency; if that proves
      friction, the alternative is also publishing a plain `.zip` per Windows
      target from the release workflow (§10.2).

## 4. Linux system packages via nfpm: deb, rpm, apk, pacman (P3)

nfpm (goreleaser's packager) emits deb, rpm, apk and archlinux
(`.pkg.tar.zst`) packages from ONE YAML config — four of the requested
ecosystems with one tool and no root at build time. All four consume the musl
static bundle (§1.3), so there are no library dependencies to express.

Content and layout, all formats: the bundle tree under
`/usr/lib/yo/<version>/` plus a `/usr/bin/yo` symlink into it — the same shape
`install.sh` installs under `~/.local`, which the walk-up already understands.
A versioned directory keeps `upgrade` a whole-tree replacement.

- [ ] `scripts/nfpm.yaml` in this repo: name/version/arch driven by the
      release, contents = the extracted bundle, the `/usr/bin/yo` symlink,
      per-format metadata.
- [ ] One new `release.yml` job (per arch, after `musl-bundle` uploads): fetch
      the just-published tarball, run `nfpm package` for the four formats,
      attach the artifacts to the release. Release-workflow jobs live outside
      `test.yml`'s merge-gate — no gate edits.
- [ ] Metadata: Recommends/Suggests, NOT hard Depends — `clang | gcc`, `git`,
      `pkg-config`. A hard dependency would drag a compiler onto machines that
      only run prebuilt Yo binaries. RPM: no autoreqprov (static binary, no
      sonames). apk/pacman arch fields: `x86_64` / `aarch64`.
- [ ] Package name `yo` — verify no collision in each namespace (Debian NEW,
      AUR, existing taps/buckets) before first publish; fallback `yolang`
      (§10.3 decides once).
- [ ] Uninstall removes BOTH the tree and the `/usr/bin/yo` symlink (nfpm's
      contents must own the symlink; verify per format).
- [ ] Documented install UX in the artifact-only phase:

```bash
sudo apt install ./yo_0.2.54_amd64.deb
sudo dnf install ./yo-0.2.54.x86_64.rpm
sudo apk add --allow-untrusted ./yo-0.2.54.apk      # indexes+signatures are §5
sudo pacman -U yo-0.2.54-x86_64.pkg.tar.zst
```

## 5. Hosted repositories: apt / dnf / apk / pacman (P4 — deferred, demand-triggered)

The step from §4's artifacts to a real `apt upgrade` channel is index hosting
and signing, and that is this phase's whole cost:

- One GPG signing key: generate, publish the public key, store as an Actions
  secret, plan rotation. apk and pacman each want their own signature scheme
  (apk-tools is mid-migration v2→v3; pacman signs via `repo-add` + keyring) —
  verify against current distro releases at implementation time, not from this
  doc.
- Index regeneration per release: reprepro or aptly (apt), `createrepo_c`
  (dnf), `repo-add` (pacman), `apk index` (alpine).
- Hosting: the docs site on GitHub Pages is built from the docs tree by
  `scripts/build_site.yo`; binary indexes do not belong in that build. Likely
  shape: a `dist/` branch (or a companion repo's Pages) holding `/apt/`,
  `/yum/`, `/alpine/`, `/pacman/`, fed by the §7 dispatch. Decide at
  implementation (§10 gets the answer).
- Docs: sources.list / `.repo` / `pacman.conf` snippets per family in
  `INSTALL_LINUX.md`.

Deferred because: perpetual key-and-index maintenance for one maintainer,
versus an artifact-only install that already works — and a user who wants
near-daily Yo updates (§7) is better served by `yo version` than by `apt`
either way.

## 6. nix (P5)

Cheapest of all — one file in THIS repo, no companion repos:

- [ ] `flake.nix` at the repo root: `packages.<system>.yo` for `x86_64-linux`,
      `aarch64-linux`, `x86_64-darwin`, `aarch64-darwin`.
- [ ] Build from the per-target single-file C (`yo-v<version>-<triple>.c.gz`,
      `plans/reference/PORTABLE_C_DISTRIBUTION.md`) with `install.sh`'s
      `--from-source` flag set (`cc -std=c11 -fno-strict-aliasing -fwrapv -O2
      yo.c -lpthread -lm`), and lay out `bin/yo` + `std/` (+ `pack/`,
      `docs/en-US/`, `.github/skills/`) as siblings under `$out` — the walk-up
      then finds `$out/std`. std comes from the release source tarball, with
      the `*.test.yo` siblings deleted exactly as `install.sh` does.
- [ ] `.gitignore`: `result`.
- [ ] Usage: `nix run github:shd101wyy/Yo`, or as a flake input.
- [ ] §10.1 decides the TLS story for portable-C builds; if the canary is off,
      remote `yo version list` degrades — adding `openssl.dev` to buildInputs
      may or may not flip it, verify.
- Later, separately: nixpkgs proper — needs an upstream maintainer and review;
      the single-file-C build makes the derivation unusually clean for a
      compiled language, so it is pleasant when it happens.

## 7. Keeping channels current (the automation that must exist first)

The release cadence is near-daily patches (v0.2.37 → v0.2.54 in under three
weeks, 2026-09/10). A hand-updated formula or manifest is stale within a day
of the first release. None of §2–§6 ships before this exists:

- The Release workflow's publish step fires `repository_dispatch`
  (`{type: "release", version, tag}`) at `homebrew-yo`, `scoop-yo` (and §5's
  index job when it exists), using a PAT with workflow scope on those repos.
- Each companion repo runs a tiny workflow: regenerate the formula/manifest
  (version, per-arch sha256/hash), commit to its default branch.
- Bootstrap fallback (no dispatch): a daily cron with `brew livecheck` /
  `scoop checkver` + autoupdate. Laggier, fine to start with.

## 8. Start triggers (what promotes a phase from this doc to active work)

| Channel                          | Start when                                                        | Steady-state cost                  |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| §2 Homebrew tap                  | first sustained macOS request beyond install.sh, or a README ask  | ~zero (dispatch automation)        |
| §3 Scoop bucket                  | same on Windows                                                   | ~zero                              |
| §4 nfpm artifacts                | any user asks to manage Yo with their distro's package manager    | one release job                    |
| §5 hosted repos                  | repeated explicit requests for `apt upgrade`-style updates        | GPG key lifecycle + index signing  |
| §6 nix flake                     | first NixOS/nix user request                                      | one file                           |
| homebrew-core / nixpkgs / Scoop Main / AUR | notability bar realistically met (homebrew-core's guide asks on the order of 750★ + 30 forks; this repo stood at 38★ / 0 forks on 2026-10-08) AND a willing upstream maintainer | upstream contribution obligations |

## 9. Docs to update when a phase lands

Both `docs/en-US/` and `docs/zh-CN/`: `INSTALL_MACOS.md` (tap),
`INSTALL_WINDOWS.md` (bucket), `INSTALL_LINUX.md` (§4/§5), plus the README
install section. The docs site builds from these files, so no separate site
work. Each landing PR also adds the one-sentence coexistence note: a
package-manager install lives in the system prefix, `yo version` keeps
`~/.local`, and PATH order decides which `yo` wins.

## 10. Open questions

1. **Portable-C TLS on Linux/macOS**: live, weak-linked, or canary-off?
   `install.sh`'s source path passes no OpenSSL flags; whether such a build's
   `__yo_tls_available()` canary is true affects §6 and the Homebrew source
   flavor. Verify by building the published `.c.gz` and running
   `yo version list --remote`.
2. **Scoop `.zip` assets**: rely on Scoop's 7-Zip-based `.tar.gz` extraction,
   or publish `.zip` per Windows target from the release workflow?
3. **Package name**: `yo` or `yolang`, decided ONCE before any first publish
   (renaming later is per-channel pain). The VS Code extension is already
   `yolang`; `yo` is shorter but needs the §4 collision check.
4. **macOS x64 endgame**: the Intel bundle depends on GitHub's last Intel
   runner (`macos-26-intel`, release.yml); when that goes, does the tap pin
   the last x64 formula or drop `on_intel`? Same question `install.sh` already
   faces — answer once, in `RELEASE_ASSET_TRIPLES` terms.

## 11. Non-goals

- **No compiler changes.** This campaign is packaging-only; any compiler gap
  it finds becomes an `issues/` entry, not a rider on a packaging PR.
- **homebrew-core / Scoop Main / AUR-trusted / nixpkgs submission** — not
  while notability is far off (§8); the custom channels have no bar.
- **winget / Chocolatey** — the Windows manager this plan targets is Scoop;
  winget is a natural later addition over the same assets and gets its own §8
  line then.
- **No glibc dynamic Linux packages** — the static musl bundle is THE Linux
  bundle (2026-08-20 decision, reaffirmed in release.yml); package formats do
  not reopen it.
- **No `yo version` changes** — the version manager and system packages
  coexist (different prefixes; §9's one sentence).
