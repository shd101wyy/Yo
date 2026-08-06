# Self-hosting completion — retire `src/`, full CLI, install scripts, LSP

**Written 2026-08-06.** Successor to the bootstrap campaign
([`BOOTSTRAPPING.md`](BOOTSTRAPPING.md), goal achieved: fixpoint holds, full
suite green under the self-hosted binary, all CI jobs gate). This document is
the roadmap for making `yo-self/` **the** compiler, not the port of one.

## End state

1. The `src/` TypeScript compiler is retired. Bun/Node/npm/yarn are no longer
   required to build, install, test, or use Yo — **except**
   `vscode-extension/`, which stays TypeScript + bun by design (it is a VS Code
   client; that ecosystem is TS).
2. The self-hosted binary supports **every** `yo` subcommand (`init`, `build`,
   `doc`, `fetch`, `install`, `cache`, `version`, plus today's
   `check`/`compile`/`test`/`fmt`) at CLI-flag parity.
3. Users install Yo with one command on every platform — POSIX `install.sh`,
   Windows `install.bat`/PowerShell — downloading prebuilt binaries from
   GitHub Releases (Koka's installer is the reference implementation, cloned
   at `~/Workspace/koka`, see `util/install.sh` (719 lines) and
   `util/install.bat` (610 lines)).
4. A Yo-native LSP server (`yo lsp`) powers the VS Code extension.

Ordering rationale: each phase is a prerequisite of the next. CLI parity
(P1) must come before retiring `src/` (P2) — you cannot delete the reference
while it is the only thing that can `yo build`. Distribution (P3) must come
before or with P2 — once TS is gone, prebuilt binaries are the only bootstrap
seed. LSP (P4) rides on a stable native toolchain.

---

## Phase 1 — full subcommand parity in `yo-self`

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
- Leftover from the port: activate `types/flowability.yo` (setter/caller
  wiring — list in `REMAINING_EVALUATOR_PORTS.md`).

**Gate:** a differential harness per subcommand — same inputs, compare
outputs/exit codes/effects against the TS CLI (`scripts/bootstrap/` style).
`yo build` differential runs on a corpus of real `build.yo` projects
(`tests/build-projects/` to be collected from the existing TS
`build-system.test.ts` fixtures).

## Phase 2 — retire `src/` and the bun/node toolchain

The self-hosting trust chain has to move off TypeScript before `src/` can go.

1. **Bootstrap seed.** Cut a release whose binaries are built by the TS
   compiler one final time (per platform). From then on, stage-1 is built by
   the **previous release binary**, not by TS. CI's fixpoint job keeps the
   chain honest: seed → stage-1 → stage-2 → stage-3, stage-2 ≡ stage-3.
2. **CI migration.** Replace `bun install && bun run build` in every workflow
   job with "download pinned seed release → self-build". The differential
   ground truth changes from "TS compiler" to "previous release binary" —
   the corpus harness and `tests/internal` differential keep their shape.
3. **Re-express TS-only tests.** `src/tests/*.test.ts` (evaluator unit tests,
   build-system tests, pragma/unsafe/comptime-ref gates) either already have
   `.yo` equivalents in `tests/` + `tests/internal/` or need one written.
   Inventory first; nothing gets deleted before its coverage exists in Yo.
4. **Retire.** Freeze `src/` (attic tag/branch), delete from `develop`,
   remove `package.json`/`bun.lock`/`build.js`/`out/` from the root, keep
   `vscode-extension/` self-contained with its own lockfile. `yo-cli` (bash)
   and `yo-cli.ps1` re-point from `node out/cjs/yo-cli.cjs` to the installed
   native binary.
5. **Docs sweep.** AGENTS.md's build/test commands, `.github/instructions/`,
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
   `std/` + init templates + LICENSE. (Windows bundle implies the compiler
   builds and runs natively there — today's Windows CI runs the TS compiler,
   so this is the first native-Windows exercise of the self-hosted binary;
   budget for a porting tail.)
2. **`util/install.sh`** (POSIX sh, curl-pipe-able) and **`util/install.bat`**
   (cmd; a PowerShell variant optional later), adapted from Koka's.
3. **`yo version`** management re-pointed at the releases channel: `version
list --remote` reads GitHub Releases, `version install X` downloads the
   bundle into the version cache; `.yo-version` pinning semantics unchanged.

**Gate:** fresh VM/container per platform: `curl … | sh` (or `install.bat`),
then `yo init && yo build test` succeeds with no other toolchain present
(C compiler excepted — document clang/gcc/zig as the one prerequisite, or
evaluate bundling zig as Koka bundles nothing but suggests one).

## Phase 4 — LSP + VS Code integration

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
