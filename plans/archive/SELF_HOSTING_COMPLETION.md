# Self-hosting completion — retire `src/`, full CLI, install scripts, LSP

> **ARCHIVED 2026-09-04 — CAMPAIGN COMPLETE.** Every phase landed: P1 CLI
> parity (COMPLETE 2026-08-10), P2 + P2.5 retirement of `src/` and the
> bun/node toolchain (LANDED 2026-08-20, frozen at tag `src-attic-final`),
> P3 distribution (every item proven by shipped releases, v0.2.14 onward),
> P4 LSP + VS Code (FEATURE-COMPLETE 2026-08-22). The per-phase records are
> archived alongside this doc; live work continues from
> [`ROADMAP.md`](../ROADMAP.md).

**Written 2026-08-06.** Successor to the bootstrap campaign
([`BOOTSTRAPPING.md`](BOOTSTRAPPING.md), goal achieved: fixpoint holds, full
suite green under the self-hosted binary, all CI jobs gate). This document is
the roadmap for making `yo-self/` **the** compiler, not the port of one.

## End state

1. The `src/` TypeScript compiler is retired. No JavaScript runtime is required
   to build, install, test, or use Yo — **except** `vscode-extension/`, which
   stays TypeScript by design (it is a VS Code client; that ecosystem is TS).
   **Updated 2026-08-12: the extension moved from bun to Node/npm**, so `bun`
   is needed NOWHERE after retirement rather than surviving for one job. Its
   toolchain (`vsce`, `vscode-languageclient`, `@types/vscode`) is npm-native,
   `npm version` already bumped it at release time, and `build.js` used no
   bun-specific API — so the switch was scripts + lockfile only.
2. The self-hosted binary supports **every** `yo` subcommand (`init`, `build`,
   `doc`, `fetch`, `install`, `cache`, `version`, plus today's
   `check`/`compile`/`test`/`fmt`) at CLI-flag parity — and the compiler
   itself is built by `yo build` from a repo-root `build.yo`
   (`docs/en-US/BUILD_SYSTEM.md`), not by bun or a bespoke script.
3. Users install Yo with one command on every platform —
   `curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh` (and
   `install.bat` for Windows) — version-selectable, downloading prebuilt
   binaries from GitHub Releases and interoperating with `yo version` /
   `.yo-version` pinning (Koka's installer is the reference implementation,
   cloned at `~/Workspace/koka`, see `util/install.sh` (719 lines) and
   `util/install.bat` (610 lines)).
4. A Yo-native LSP server (`yo lsp`) powers the VS Code extension.

Ordering rationale: each phase is a prerequisite of the next. CLI parity
(P1) must come before retiring `src/` (P2) — you cannot delete the reference
while it is the only thing that can `yo build`. Distribution (P3) must come
before or with P2 — once TS is gone, prebuilt binaries are the only bootstrap
seed. LSP (P4) rides on a stable native toolchain.

---

## Phase 1 — full subcommand parity in `yo-self` — **COMPLETE 2026-08-10**

> **P1 is DONE** — every subcommand dispatched and differentially validated
> (corpus green, `doc --format html` shipped via the vendored `markdown_yo`,
> fmt gate landed). [`P1_CLI_PARITY.md`](P1_CLI_PARITY.md) records the
> campaign. The paragraphs below are kept as written for history.

> **READ [`P1_CLI_PARITY.md`](P1_CLI_PARITY.md) FIRST.** It is the P1 handover: it lists what must be
> true before P1 starts, and corrects three premises of the paragraph below that
> were verified false on 2026-08-08: `build` is **hollow** rather than unwired (its
> registry is never populated and it shells out to a flag that does not exist in
> `src/`), `doc` is **~3,800 lines unported**, and `module-manager.ts` (458 lines,
> imported by build/fetch/install/doc/test-runner/codegen) has **no counterpart at
> all**. It also notes that the `build` differential corpus cannot be "collected"
> from `build-system.test.ts` as stated below — those are unit tests whose only
> on-disk projects are one-line stubs, so the corpus must be written.

`yo-self/main.yo` currently dispatches only `check | compile | test | fmt`.
The machinery for the rest is ALREADY PORTED as libraries (build runner, doc
pipeline, fetch/install/cache/lock-file, init, version discovery — see the
component table history in `BOOTSTRAPPING.md` git log); the work is CLI
wiring + flag parity + differential validation.

| Subcommand | Ported library                                            | Wiring notes                                                                                                                   |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `init`     | `yo-self/init.yo`                                         | scaffolding templates; trivial                                                                                                 |
| `build`    | `yo-self/build_runner.yo` + `evaluator/builtins/build.yo` | DAG scheduler; needs `run`/`test` steps, `--list-steps`, `-Dname=val`                                                          |
| `doc`      | `yo-self/doc/`                                            | `--format json/html`, `-o`                                                                                                     |
| `fetch`    | `yo-self/fetch.yo`                                        | `--update`; lock-file pruning; `GIT_TERMINAL_PROMPT=0`                                                                         |
| `install`  | `yo-self/install_command.yo`                              | git/path deps, semver tags                                                                                                     |
| `cache`    | `yo-self/cache.yo`                                        | `path` / `clean`                                                                                                               |
| `version`  | `yo-self/version.yo` + version cache                      | ⚠ redesign: today's version cache downloads from **npm** — that channel dies with P2/P3; re-point at GitHub Releases (see P3) |

Also in scope:

- Flag parity for the existing four subcommands (`--emit-c`,
  `--skip-c-compiler`, `--sanitize`, `--allocator`, `--parallel`, `--bail`,
  `--test-name-pattern`, `--keep-generated-files`, `--exclude`, …). The
  self-hosted test runner currently ignores `--parallel` ("v1 runs
  sequentially") — implement it or document it as accepted divergence.
- **`fmt` parity + its differential gate.** **Re-measured 2026-08-09: 17 files,
  not ~315** — see [`P1_CLI_PARITY.md`](P1_CLI_PARITY.md) §6. Two root causes
  were fixed in both formatters (the `Dot` case eating a preceding space; and a
  character index used as a byte offset that DESTROYED any file mixing
  non-ASCII text with a backtick string, at rc=0). One rule class remains: a
  stray space before `)` when an operator token ends a multiline paren frame. This is P1-critical rather than cosmetic: at P2 the
  self-hosted formatter becomes canonical and `fmt --check` becomes
  self-referential, so the first `yo fmt` would silently restyle hundreds of
  files with no gate able to notice. The gate must land WITH the fix —
  `scripts/bootstrap/gates_fast.sh` carries a note where it goes. Mind the
  caveat recorded there: the TS formatter preserves existing line structure
  rather than canonicalizing it, so a raw "would format" count conflates real
  spacing bugs with line-breaking differences.
- ~~**The 3 hollow language test files**~~ — **RESOLVED 2026-08-08**
  ([`issues/fixed/yo-self-hollow-language-test-files.md`](../issues/fixed/yo-self-hollow-language-test-files.md)).
  The first full-corpus sweep scored 185 GREEN / 3 HOLLOW — files that reported
  passes (one claimed 49) while running no assertions — and its first CI run added
  **2 RED files that pass on macOS but fail on Linux** (`ref_local_binding`,
  `string/string`). All five are now fixed and
  `scripts/bootstrap/known-failing.tsv` is EMPTY, so the sweep ratchet demands a
  fully clean corpus rather than a frozen one.
  For the RED ones, start from the `hollow-sweep-results` CI artifact; they do not
  reproduce on macOS.
- Leftover from the port: activate `types/flowability.yo` (setter/caller
  wiring — list in `REMAINING_EVALUATOR_PORTS.md`).

**Gate:** a differential harness per subcommand — same inputs, compare
outputs/exit codes/effects against the TS CLI (`scripts/bootstrap/` style).
`yo build` differential runs on a corpus of real `build.yo` projects
(`tests/build-projects/` to be collected from the existing TS
`build-system.test.ts` fixtures).

## Phase 2 — retire `src/` and the bun/node toolchain — **IN PROGRESS**

> **Working doc: [`P2_RETIRE_SRC.md`](P2_RETIRE_SRC.md).** Status
> **2026-08-12**: **2.1 DONE** — the seed chain is live and now four releases
> deep (v0.2.0 → v0.2.3); **all five bundles** ship
> (`yo-v0.2.3-{linux-x64,linux-arm64,macos-arm64,macos-x64,windows-x64}.tar.gz`),
> and npm publishing stopped at v0.2.0. **2.2 DONE** (repo-root build.yo
> verified both ways; `TestSuite.exclude` landed via PR #94). **2.4 DONE**
> (inventory in the P2 doc). **2.3 IN REVIEW** (PR #98): every job green
> except the tier-1 gates, whose blocker is fixed and merged but cannot reach
> that job until a **v0.2.4** seed is cut — see the two-generation rule in the
> P2 doc. **2.5 planned** in
> [`P2_5_RETIRE_EXECUTION.md`](P2_5_RETIRE_EXECUTION.md); 2.6 follows it.
> Groundwork already in: std-root resolution reworked in BOTH compilers
> (`--std-path` flag → `YO_STD` → exe-relative walk-up via
> `std/env.current_exe()` → `./std`), so the bundles are **self-locating** —
> CI consumers just extract and put `bin/` on PATH.
>
> **What 2.3 has already bought, and it is the point of the phase:** building
> stage-1 with the previous RELEASE instead of with TypeScript exposed a class
> of defect every prior CI arm was blind to — bugs in what the SELF-HOSTED
> codegen emits. Two were found and fixed this way
> (`issues/fixed/seed-built-stage1-miscompiles-current-source.md`,
> `issues/self-built-compiler-uaf-in-report-and-build-paths.md`), neither
> visible to a TS-built stage-1.

The self-hosting trust chain has to move off TypeScript before `src/` can go.

1. **Bootstrap seed.** Cut a release whose binaries are built by the TS
   compiler one final time (per platform). From then on, stage-1 is built by
   the **previous release binary**, not by TS. CI's fixpoint job keeps the
   chain honest: seed → stage-1 → stage-2 → stage-3, stage-2 ≡ stage-3.
2. **The compiler builds itself with its own build system.** A repo-root
   `build.yo` (per `docs/en-US/BUILD_SYSTEM.md`) becomes the canonical way to
   build the compiler — `yo build` compiles `yo-self/main.yo` into the `yo`
   executable, `yo build test` drives the suite, plus steps for the fixpoint
   (`stage2`/`stage3`) and release bundles. This replaces both `bun run
build` and the raw `yo-cli compile yo-self/main.yo` invocation, and is the
   single best dogfooding target the build system can have. (Depends on P1
   `build` parity; doubles as its acceptance test.)
3. **CI migration.** Replace `bun install && bun run build` in every workflow
   job with "download pinned seed release → `yo build`". The differential
   ground truth changes from "TS compiler" to "previous release binary" —
   the corpus harness and `tests/internal` differential keep their shape.
4. **Re-express TS-only tests.** `src/tests/*.test.ts` (evaluator unit tests,
   build-system tests, pragma/unsafe/comptime-ref gates) either already have
   `.yo` equivalents in `tests/` + `tests/internal/` or need one written.
   Inventory first; nothing gets deleted before its coverage exists in Yo.
5. **Retire.** Freeze `src/` (attic tag/branch), delete from `develop`,
   remove `package.json`/`bun.lock`/`build.js`/`out/` from the root, keep
   `vscode-extension/` self-contained with its own lockfile. `yo-cli` (bash)
   and `yo-cli.ps1` re-point from `node out/cjs/yo-cli.cjs` to the installed
   native binary.
6. **Docs sweep.** AGENTS.md's build/test commands, `.github/instructions/`,
   and skills all reference `bun run build` — rewrite around the native
   toolchain.

**Gate:** a full CI matrix run with NO node/bun setup steps anywhere except
the `vscode-extension` job; fixpoint + differential-vs-previous-release green.

Risks: (a) compile-time — the self-hosted binary self-compiles slower than TS
today (memory peak ~2×; levers: `YO_SELF_ENV_SHARING.md`,
`TYPEVALUE_HASH_CONSING.md`) — acceptable for CI, matters for dev loops;
(b) trust-chain discipline — the seed release must be reproducible and
archived; document the chain in the release notes every time.

## Phase 3 — distribution: releases + install scripts (Koka model)

Reference: `~/Workspace/koka/util/install.sh` + `install.bat`. Their shape to
copy: single script, version-pinned default, `--prefix` override
(`/usr/local` default on POSIX, `%LOCALAPPDATA%\yo` on Windows), uninstall
mode, dry-run, os/arch sniffing, tarball from
`https://github.com/<org>/yo/releases/download/<version>/yo-<version>-<os>-<arch>.tar.gz`,
PATH guidance, optional `--vscode` flag that also installs the editor
extension.

Work items:

1. **Release CI**: on tag, build bundles for `macos-arm64`, `macos-x64`,
   `linux-x64`, `linux-arm64`, `windows-x64` — each = native `yo` binary +
   `std/` + `vendor/mimalloc/` + LICENSE (init templates are generated inline
   by the binary; vendor/ must ship as a SIBLING of std/ because both
   compilers resolve mimalloc as `dirname(std)/vendor`). (Windows bundle
   implies the compiler builds and runs natively there — today's Windows CI
   runs the TS compiler, so this is the first native-Windows exercise of the
   self-hosted binary; budget for a porting tail.)

   **DONE 2026-08-12** (bundles), except musl. `release.yml`'s `seed-bundles`
   job builds and attaches **all five** bundles — `linux-x64`, `linux-arm64`,
   `macos-arm64`, `macos-x64`, `windows-x64` — each smoke-tested from outside
   the checkout, with releases kept atomic (draft until every required leg
   uploads, then a publish job flips it). Bundles are self-locating (`bin/yo`
   finds the sibling `std/` via the executable-relative walk-up), so the
   installer only extracts and puts `bin/` on PATH. **Still open: the
   static-musl Linux story below** — today's Linux bundles are glibc, verified
   dynamically linked against `/lib64/ld-linux-x86-64.so.2`, so they do not
   run on Alpine, and on NixOS they fail to start at all (that path does not
   exist there; the loader lives in `/nix/store`). See
   [`P3_DISTRIBUTION.md`](P3_DISTRIBUTION.md) item 3.

   **Linux libc decision — one static musl binary per arch, not per-libc
   bundles.** A glibc-linked `yo` does not run on musl distros (different
   dynamic linker + symbol versioning). Instead of Koka's distro-sniffing
   dual bundles, the Linux bundles are **fully static musl builds**
   (Zig/Deno/Bun model): one `linux-x64` and one `linux-arm64` binary that
   run on every distro, glibc or musl, with no installer detection logic.
   Constraints: Yo cannot cross-compile gnu→musl (`BUILD_SYSTEM.md` — musl is
   native-only), so release CI builds the Linux bundles inside an Alpine
   container; `liburing` (async runtime) must be statically linked; and the
   runtime needs a one-time validation pass under musl (io_uring, mimalloc,
   worker-thread stack sizing) — the `x86_64-linux-musl` target exists for
   exactly this. Fallback if static-musl validation surfaces real problems
   (e.g. `std/sys/dns` NSS behavior differences that matter in practice):
   Koka-style separate `-gnu`/`-musl` bundles + `OSDISTRO` sniffing in the
   installer.

   Note this affects only the `yo` binary itself: Yo emits C compiled on the
   user's machine with their toolchain against their libc, so a musl-static
   compiler on Ubuntu still produces ordinary glibc user programs.

   Host-platform matrix (what the bundles cover): `linux-x64`/`linux-arm64`
   (static musl, all distros), `macos-arm64`/`macos-x64` (libSystem; Rosetta
   covers arm64 running the x64 bundle as fallback), `windows-x64` (MSVC CRT;
   arm64 Windows runs it emulated, as Koka does). Compile-target matrix is
   unchanged from `BUILD_SYSTEM.md`: native target = host (gnu and musl
   variants on Linux), plus `wasm32-emscripten`/`wasm32-wasi` from any host.

2. **Install scripts — LANDED 2026-08-12** as `scripts/install.sh` (POSIX sh,
   curl-pipe-able) and `scripts/install.ps1` (PowerShell, not the planned
   `.bat`), adapted from Koka's. Note the paths: `scripts/`, not `util/`.
   `--version` / `--prefix` / `--uninstall` / `--force` / `--dry-run` /
   `--no-deps` / `--no-verify`; dependency installation across
   apt/dnf/zypper/pacman/apk/yum; verification that compiles and runs a hello
   world rather than checking a version string. Exercised by
   `.github/workflows/install-scripts.yml` on all five platforms against the
   REAL published bundles, plus weekly (nothing in a normal PR touches these
   files, so a release-layout change would otherwise break them silently).

   **Deviation from this plan, deliberate:** they install into
   `<prefix>/lib/yo/<tag>` rather than the `yo version` cache layout, so the
   installer and `yo version install X` are NOT yet one mechanism — the thing
   item 4 / P3 item 2 wanted. The layouts are structurally the same (a
   per-version directory holding a bundle extraction), so unifying them is a
   re-rooting rather than a rewrite. Tracked in
   [`P3_DISTRIBUTION.md`](P3_DISTRIBUTION.md) item 1.

   Dependencies the scripts install, each verified against the shipped
   compiler rather than assumed: a C compiler (`yo compile` invokes `clang` by
   default), **git** (`yo fetch` / `yo install` shell out to it), and on Linux
   **liburing and pkg-config as a pair** — the emitted C gates io_uring on
   `#if __has_include(<liburing.h>)` while `-luring` is added only when
   `pkg-config --exists liburing` succeeds, so the header WITHOUT pkg-config
   is strictly worse than neither.

3. **Host the installers on GitHub Pages**, so the canonical one-liner is:

   ```bash
   curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh
   curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --version v0.2.0
   ```

   (and `install.bat` at the same base URL for Windows). Implementation: the
   Pages deployment publishes `util/install.sh` / `util/install.bat` at the
   site root; the scripts themselves keep downloading the binary bundles from
   GitHub **Releases** — Pages only hosts the tiny bootstrap scripts, so the
   URL stays stable across releases while the default version inside the
   script is bumped by release CI.

4. **`yo version`** management re-pointed at the releases channel: `version
list --remote` reads GitHub Releases (replaces the npm registry), `version
install X` downloads the bundle into the version cache — shared code path
   with the install scripts per item 2; `.yo-version` pinning semantics
   unchanged. **Urgency raised 2026-08-11: npm publishing stopped at v0.2.0**
   (the release workflow no longer publishes the package — the npm package
   WAS the TS compiler), so the npm-based version cache cannot see any
   version from v0.2.0 on; this item is what restores `yo version
   install`/`list --remote` for new versions.

**Gate:** fresh VM/container per platform: `curl … | sh` (or `install.bat`),
then `yo init && yo build test` succeeds with no other toolchain present
(C compiler excepted — document clang/gcc/zig as the one prerequisite, or
evaluate bundling zig as Koka bundles nothing but suggests one).

## Phase 4 — LSP + VS Code integration

> **FEATURE-COMPLETE 2026-08-22** (`P4_LSP.md` has the full record): `yo lsp`
> serves stdio LSP — diagnostics at exact ranges (incl. the def-time swallow
> class), hover, definition, document symbols, references, folding, rename,
> formatting, signature help, completion (import-path / dot members / enum
> dot-prefix / generic-impl methods / identifier+env+keyword) — and the VS
> Code extension carries a plain-JS client (`yo.binPath`). Gated by the
> `lsp-handshake` + `lsp-completion` cli-cases (real framed-protocol goldens).
> The companion incremental-compilation Phase B landed alongside
> (`plans/reference/INCREMENTAL_COMPILATION.md`): per-edit module-cache invalidation
> with an open-buffer overlay, and registry purge so re-analysis stops
> leaking. Inlay hints deliberately dropped (the attic shipped them
> disabled). Original scoping below.

> **Working doc: [`P4_LSP.md`](P4_LSP.md) — SCOPED 2026-08-12.** Measured
> sizing (4,730 lines across 14 files, `completion.ts` alone 1,541, plus a
> transport layer TypeScript gets free from `vscode-languageserver/node`) and
> two feasibility spikes:
>
> - **Transport: GREEN.** A Yo program can read its own stdin when stdin is a
>   PIPE — the prerequisite that could have sunk this, since `std/sys/file.read`
>   is positional and positional reads fail on pipes with `ESPIPE`. Proven
>   against real LSP framing, including back-to-back frames.
>   `BufReader.read_exact` was added to std for it.
> - **Diagnostics: RED.** `yo-self check` reports "evaluator OK" for a file
>   calling an undefined function, where the TS compiler reports it with a
>   position — the def-eval swallow. An LSP on that checker would report NO
>   errors on broken code, which is worse than shipping none, because editor
>   silence reads as approval.
>
> **So increment 1 below is wrong as written**: diagnostics cannot come first.
> The corrected order is in P4_LSP.md — fix the def-eval swallow and add a
> structured-diagnostics entry point (`check` prints progress text, it does not
> return ranges) BEFORE any protocol work.
>
> This bears on P2.5's decision **B2** — _"keep `src/lsp` as an island, or ship
> a syntax-only extension"_ — without settling it. P4 fixes the LONG-TERM
> answer (rewritten in Yo, so no island survives), but B2 is about the
> INTERIM, between deleting `src/` and P4 shipping, and that remains a
> maintainer call. What P4 changes is the arithmetic: an island kept for the
> interim is thrown away when P4 lands, so its cost has to be justified by
> that window alone.

1. **`yo lsp`** subcommand: a Yo-native LSP server over stdio. Increment 1:
   document sync + diagnostics from the `check` surface (the evaluator already
   produces positioned errors). Increment 2: hover types + go-to-definition
   from the `ExprInfoTable` (types, definition sites are already recorded).
   Increment 3: completion (env/frame contents at a position), rename,
   references. Incremental/partial re-check is where the parked memory levers
   (`TYPEVALUE_HASH_CONSING.md`) start paying rent — full-project re-check per
   keystroke won't fly.
2. **`vscode-extension/`** (stays TS + bun): replace its bundled-grammar-only
   intelligence with an LSP client (`vscode-languageclient`) that spawns the
   installed `yo lsp`. The extension's stale-diagnostics problem (AGENTS.md
   pitfall) disappears with a live server.
3. Installer integration: `install.sh --vscode` / `install.bat` flag installs
   the published extension (Koka's scripts show the `code --install-extension`
   dance).

**Gate:** the extension against the released binary passes a scripted smoke:
open repo, see real diagnostics on a broken file, hover shows a type,
go-to-def jumps across modules.

---

## Sequencing snapshot

```
P1 CLI parity  ──►  P2 retire src/ + bun  ──►  P3 releases + installers  ──►  P4 LSP + VS Code
                         ▲                          (P3 seed work can start during P2)
                         └── needs P1 done for build/doc/fetch parity
```

Nothing here blocks merging the bootstrap PR (#76) — this roadmap starts
from its merge.

### Where the phases actually stand — 2026-08-12

| phase            | status                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 CLI parity    | **COMPLETE** 2026-08-10                                                                                                                               |
| P2 retire `src/` | 2.1/2.2/2.4 **DONE**; 2.3 **in review** (needs a v0.2.4 seed); 2.5 planned, 2.6 after it                                                              |
| P3 distribution  | **PROVEN by v0.2.14 (2026-08-21)**: six bundles (musl-only Linux, windows-arm64 included) + six per-target `yo.c`; installers landed; `yo version` on Releases; suite runs on all six targets — only the fresh-VM gate run remains (`P3_DISTRIBUTION.md`) |
| P4 LSP           | **scoped**, blocked on the def-eval swallow                                                                                                           |

The strict phase order has held with one exception worth noting: P3's
installers landed before P2 finished, because they only depend on the release
bundles (a P2.1 output), not on `src/` being gone. Anything else in P3 that
depends only on published bundles can be pulled forward the same way.
