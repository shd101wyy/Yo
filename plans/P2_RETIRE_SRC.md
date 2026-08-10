# P2 — retire `src/` and the bun/node toolchain

**Working handover doc for Phase 2 of
[`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).** Same contract as
[`P1_CLI_PARITY.md`](P1_CLI_PARITY.md) (COMPLETE, 2026-08-10): every number
here is measured, and the doc records what is done, what is in flight, and
the traps as they are found. Started 2026-08-10, branch `p2/self-build`.

The phase's items, from the umbrella plan:

| item | what                                                             | status                           |
| ---- | ---------------------------------------------------------------- | -------------------------------- |
| 2.1  | bootstrap seed release (TS builds the binaries one last time)    | not started — needs a release    |
| 2.2  | repo-root `build.yo`: the compiler builds itself with `yo build` | **IN FLIGHT** — see below        |
| 2.3  | CI migration: seed release + `yo build` replace bun              | not started (blocked on 2.1/2.2) |
| 2.4  | re-express TS-only tests in Yo                                   | **inventory below**              |
| 2.5  | retire: freeze + delete `src/`, drop package.json/bun/out        | blocked on 2.1–2.4               |
| 2.6  | docs sweep (AGENTS.md, instructions, skills)                     | blocked on 2.5                   |

---

## 2.2 — repo-root `build.yo` (the dogfood build)

Landed 2026-08-10:

- **`build.yo` at the repo root**: `yo build` compiles `yo-self/main.yo` into
  `yo-out/<target>/bin/yo` at `Optimize.ReleaseSmall` — which maps to plain
  `-O2` + release mode, byte-for-byte the flags of the canonical
  `yo-cli compile yo-self/main.yo --release` (see the comment in build.yo for
  why not Debug and why not ReleaseSafe). `yo build test` drives `tests/`
  (NOTE: includes `tests/internal` — `TestSuite` has no exclude field yet, so
  the fast-suite CI jobs keep `yo test ./tests --exclude tests/internal`).
- **The §9 P1 debt is closed**: `yo-self/build_runner.yo`'s `compile_artifact`
  now forwards the artifact's full option set to the child compile —
  `--release`/`--optimize` (mirroring `mapOptimize`: release-safe/-small → 2,
  release-fast → 3, release only when not debug/release-safe), `--allocator`
  (unconditional, like TS), `--sanitize` (when not "none"), `-D`, `-L`, `-l`,
  `--strip`, `--static`, `--static-library`, `--cflags`. Without this the
  self-build would have produced a `-O0` compiler binary — the rc=139
  stack-ceiling one from AGENTS.md's pitfalls.
- **Verified under TS**: `./yo-cli build` produced a working
  `yo-out/aarch64-macos/bin/yo` (check + doc smoke-tested; kept at
  `/tmp/yo-via-tsbuild` during bring-up).
- **Self-hosted self-build (`yo-s26 build`) in flight** at time of writing.

Still open in 2.2:

- `TestSuite.exclude` (std/build.yo + both runners) so `yo build test` can be
  the fast suite.
- Fixpoint steps (`stage2`/`stage3`) and release-bundle steps: the build
  system's `step()` is dependency-grouping only — no command execution — so
  these need either a build-API extension or stay as
  `scripts/bootstrap/*.sh` wrappers invoked around `yo build`.
- `build.run(exe)` takes no args, and a bare `yo` exits 1, so there is no
  run step in the compiler's build.yo.

## 2.4 — TS-only test inventory (23 files, ~9,000 lines)

Ground truth: `tests/internal/` has 59 files including `formatter`,
`lock_file`, `cache`, `fetch`, `install_command`, `init`, `pkg_config`,
`version`, `doc_extractor`, `doc_render_markdown`, `doc_sections`;
`tests/cli-cases/` has 10 differential cases.

| TS file (lines)                            | covers                                           | verdict                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build-system.test.ts (2075)                | lock-file parse, DAG, doc-site helpers, registry | PARTIAL — `tests/internal/lock_file.test.yo` + cli-cases cover slices; needs a per-describe audit against `tests/internal/`                                                              |
| lsp.test.ts (1506)                         | the TS LSP                                       | dies with `src/` — P4 rewrites the LSP in Yo with its own tests; port nothing                                                                                                            |
| formatter.test.ts (574)                    | formatYoSource/formatYoFiles                     | covered: `tests/internal/formatter.test.yo` + GATE 6 fmt differential (808 files) — verify describe-level gaps                                                                           |
| type-representation-pointer.test.ts (248)  | typeRepresentationContainsRawPtr                 | port to `tests/internal/` (pure fn)                                                                                                                                                      |
| unsafe-report-classify.test.ts (209)       | unsafe-report sub-kinds                          | port to `tests/internal/` once `unsafe-report` is in yo-self (NOT dispatched today — P2 gap found by this inventory)                                                                     |
| public-safe-report.test.ts (163)           | `yo public-safe-report` CLI                      | same gap as above — subcommand not in yo-self                                                                                                                                            |
| version.test.ts (157)                      | parseYoVersion/findYoVersionFile                 | covered: `tests/internal/version.test.yo` — verify                                                                                                                                       |
| async-await-position-gate.test.ts (141)    | rejected await positions                         | port as `comptime_expect_error` cases (see memory: prefer comptime_expect_error over TS gate tests)                                                                                      |
| unsafe-gate.test.ts (126)                  | unsafe() gate outside std/yo-self                | shells out to yo-cli; port as cli-case or comptime_expect_error                                                                                                                          |
| reserved-quantifiers.test.ts (116)         | forall/exists reserved                           | comptime_expect_error port                                                                                                                                                               |
| contracts-runtime-violation.test.ts (109)  | contract panics at run time                      | port to `tests/` (run-fail assertions)                                                                                                                                                   |
| comptime-ref-gate.test.ts (109)            | comptime(ref(...)) rejection                     | comptime_expect_error port                                                                                                                                                               |
| contracts-comptime-violation.test.ts (107) | contract compile errors                          | comptime_expect_error port                                                                                                                                                               |
| pragma-validation.test.ts (97)             | pragma arg validation                            | comptime_expect_error port                                                                                                                                                               |
| thread-safety-codegen.test.ts (89)         | atomic RC codegen pins                           | port to `tests/internal/` (emitted-C greps) or accept as covered by runtime tests                                                                                                        |
| import-path.test.ts (73)                   | safeRelativePath, win32 paths                    | port to `tests/internal/` against yo-self's path helpers                                                                                                                                 |
| fixme.test.ts (28)                         | scratch harness                                  | dies with `src/`; port nothing                                                                                                                                                           |
| src/doc/\*.test.ts (6 files, ~3,100)       | doc pipeline units                               | PARTIAL — extractor/sections/render-markdown have internal tests; builder/render-json now covered end-to-end by cli-cases doc-json/doc-markdown; render-html deferred with the html port |

**New P2 gap found by the inventory:** `unsafe-report` / `public-safe-report`
subcommands exist only in TS (`src/yo-cli.ts`) — they were never in P1's
scope table. They must be ported (or explicitly retired) before 2.5 can
delete `src/`.

## Sequencing note

2.1 (seed release) is the maintainer's cut — everything else here can land
first. The practical order: finish 2.2 (self-build verified both ways) →
2.4 ports → 2.3 CI swap on a seed release → 2.5 retire → 2.6 docs.
