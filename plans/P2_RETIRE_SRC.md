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
- **The first self-hosted self-build attempt found two bugs** — the dogfood
  doing exactly its job:
  1. **`yo build` exited 0 on a failed step — in BOTH compilers** (TS bug,
     faithfully ported). The per-step catch that lets the summary name the
     broken step never fed a final verdict. FIXED both sides + a
     `tests/cli-cases/build-fail` differential case asserting the failure
     contract. See
     [the issue](../issues/fixed/yo-build-exits-zero-on-failed-step.md) —
     and its lesson: the differential only catches rc MISMATCHES, so a
     shared wrong rc passes silently; failure contracts need their own cases.
  2. **Self-hosted DEBUG-mode emission of the compiler miscompiles** (16
     `use of undeclared identifier '_file____User_temp_N'` C errors). That
     first attempt ran the child compile without `--release` because the
     forwarding fix hadn't landed in the running binary. OPEN — off the
     critical path since everything canonical builds at -O2:
     [issue](../issues/self-hosted-debug-emission-undeclared-temp.md).

Still open in 2.2:

- `TestSuite.exclude` (std/build.yo + both runners) so `yo build test` can be
  the fast suite.
- Fixpoint steps (`stage2`/`stage3`) and release-bundle steps: the build
  system's `step()` is dependency-grouping only — no command execution — so
  these need either a build-API extension or stay as
  `scripts/bootstrap/*.sh` wrappers invoked around `yo build`.
- `build.run(exe)` takes no args, and a bare `yo` exits 1, so there is no
  run step in the compiler's build.yo.

## PR #92 CI triage (2026-08-10) — three distinct root causes

The first full-CI run over the P1 work failed 7 jobs; all triaged:

1. **Language tests (ubuntu) — LSan leak, FIXED (TS).** Linux runs the suite
   under LeakSanitizer (macOS cannot — use `leaks --atExit` locally, which
   reproduced it exactly). Async match scrutinees leaked their payloads:
   deferred drops referenced `sm->var_<temp>` slots nothing ever stored, the
   escape dispose double-counted borrow bindings once the store landed, and
   nested matches made outer-arm drop cases unreachable (now chained). See
   [the issue](../issues/fixed/async-match-scrutinee-deferred-drops-hit-zeroed-slot.md).
   **yo-self port pending** — its `_store_temp_var_to_state_machine_if_needed`
   is a documented no-op stub, so stage-2-built binaries carry the same class.
2. **Language tests (macOS/Windows/wasm×2) + hollow sweep — fixture bleed,
   FIXED.** The differential corpus fixtures are project trees;
   `build-list-steps` carries a scaffolded `tests/main.test.yo` that the
   `./tests` walk and the sweep's `find` swept up. Both now exclude
   `tests/cli-cases`.
3. **Bootstrap fixpoint — stage-2 miscompile, FIXED in two waves.**
   Wave 1 (phantom-temp class, ~9 of 17 errors): the clear-variableName-
   around-raw-generation dance existed at only 3 of TS's 7 sites — ported to
   cond.yo/match.yo (see
   [the phantom-temp issue](../issues/fixed/stage2-match-if-else-value-phantom-temp.md)).
   Wave 2 (empty-RHS class, the remaining 8, all in fetch.yo): awaits inside
   bare-`if` bodies — a shape BOTH compilers miscompiled (TS silently skipped
   the branch at runtime; yo-self dropped the awaits and emitted
   `sm->var_N = ;`). Six-part fix across both compilers, kept 1:1 — see
   [the bare-if issue](../issues/fixed/ts-bare-if-await-early-return-silently-skipped.md)
   and the updated
   [await-position matrix](../issues/await-in-branch-positions-matrix.md).
   Wave 3 (the byte-diff layer the clang errors had masked): the C
   `i64.MIN` literal — `-9223372036854775808LL` is ULL-typed in C, so
   yo-self's inlined overflow-check comparisons went unsigned and every
   SELF-BUILT binary rejected all comptime signed subtraction; the swallowed
   def-eval failures renumbered every mangle. Plus the traversal gap the
   analysis fix unmasked (`expr_contains_await` now follows the expansion
   table — the if-in-while sweep hang). FIXPOINT_HOLDS verified locally.
   See issues/fixed/fixpoint-enum-id-allocation-order-divergence.md.
   NOTE `gates_fast.sh` does NOT include the stage-2 compile — run
   `scripts/bootstrap/fixpoint_only.sh` before believing a yo-self change is
   fixpoint-clean. A bug that exists ONLY in a stage-2-built binary is
   invisible to every CI arm that tests the TS-built stage-1 — the byte-diff
   is the only detector for that class.
4. **tests/internal doc_render_markdown — FIXED.** The P1 doc model added
   `examples` to `DocConstant`; the internal test's three constructions were
   not updated. Broke BOTH the TS arm (shard 0, module-eval error) and the
   self-hosted differential (the same file fails to transpile and poisons
   batch 33's C). 25/25 under both compilers after the fix.

Also landed en route: `yo build` exits 1 on failed steps (both compilers +
`build-fail` case), and the self-hosted def-eval swallow was found to extend
to `compile` (an undefined call builds a runnable no-op binary —
[open issue](../issues/self-hosted-compile-swallows-undefined-call.md)).

## doc --format html: LANDED (2026-08-10)

The P1 deferral is closed. `vendor/markdown_yo` (git submodule, branch
`migrate-to-latest-yo` — the library migrated to current Yo, 1035/1035
markdown-it fixtures green) supplies `markdown_to_html` by SOURCE import to
`yo-self/doc/render_html.yo` (1:1 port of render-html.ts; static CSS/JS in
`render_html_assets.yo`, script-extracted verbatim). The TS side keeps the
npm WASM. `tests/cli-cases/doc-html` PASSES byte-identical, and
doc-json/doc-markdown stay green with the vendored library in the build.
Open follow-up: `issues/doc-builder-generic-signature-divergence.md`
(builder-level, all formats, predates html).

## 2.4 — TS-only test inventory (23 files, ~9,000 lines)

Ground truth: `tests/internal/` has 59 files including `formatter`,
`lock_file`, `cache`, `fetch`, `install_command`, `init`, `pkg_config`,
`version`, `doc_extractor`, `doc_render_markdown`, `doc_sections`;
`tests/cli-cases/` has 10 differential cases.

| TS file (lines)                            | covers                                           | verdict                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build-system.test.ts (2075)                | lock-file parse, DAG, doc-site helpers, registry | PARTIAL — `tests/internal/lock_file.test.yo` + cli-cases cover slices; needs a per-describe audit against `tests/internal/`                                                                                                                                                                                                                                                  |
| lsp.test.ts (1506)                         | the TS LSP                                       | dies with `src/` — P4 rewrites the LSP in Yo with its own tests; port nothing                                                                                                                                                                                                                                                                                                |
| formatter.test.ts (574)                    | formatYoSource/formatYoFiles                     | covered: `tests/internal/formatter.test.yo` + GATE 6 fmt differential (808 files) — verify describe-level gaps                                                                                                                                                                                                                                                               |
| type-representation-pointer.test.ts (248)  | typeRepresentationContainsRawPtr                 | **PORTED 2026-08-10** → `tests/internal/types_utils.test.yo` (16 cases against yo-self's `type_representation_contains_raw_ptr`; the TS cyclic-reference case becomes a 45-deep depth-cap test — TypeValue values cannot form cycles)                                                                                                                                        |
| unsafe-report-classify.test.ts (209)       | unsafe-report sub-kinds                          | port to `tests/internal/` once `unsafe-report` is in yo-self (NOT dispatched today — P2 gap found by this inventory)                                                                                                                                                                                                                                                         |
| public-safe-report.test.ts (163)           | `yo public-safe-report` CLI                      | same gap as above — subcommand not in yo-self                                                                                                                                                                                                                                                                                                                                |
| version.test.ts (157)                      | parseYoVersion/findYoVersionFile                 | covered: `tests/internal/version.test.yo` — verify                                                                                                                                                                                                                                                                                                                           |
| async-await-position-gate.test.ts (141)    | rejected await positions                         | **PORTED 2026-08-10** → cli-cases `await-nested-in-if-condition` + `await-in-later-cond-branch` (NOT comptime_expect_error — the gate fires in CODEGEN, after evaluation). Exposed + fixed: yo-self panicked (rc=134) where TS exits 1 → `codegen_fatal` slot; message text now TS-parity. The TS file's third test (a source grep of state-code-gen.ts) dies with src/      |
| unsafe-gate.test.ts (126)                  | unsafe() gate outside std/yo-self                | **PARTIAL 2026-08-10**: positive arm → cli-case `unsafe-pragma-ok` (build-run, pins `v = 42`); signature gate → `ptr-type-safe-code`. The body-level `&(x)` / bare-`unsafe()` negatives are BLOCKED on the def-eval swallow (self accepts, TS rejects — see issues/self-hosted-compile-swallows-undefined-call.md 2026-08-10 addendum); add those two cases when it is fixed |
| reserved-quantifiers.test.ts (116)         | forall/exists reserved                           | **PORTED 2026-08-10** → `tests/internal/lexer.test.yo` (they are LEXER errors — comptime_expect_error cannot express them; the internal test asserts the exact diagnostic against yo-self's lexer)                                                                                                                                                                           |
| contracts-runtime-violation.test.ts (109)  | contract panics at run time                      | **PORTED 2026-08-10** → cli-cases `contracts-runtime-requires`/`-ensures`/`-old-ensures` (build-run, rc parity; panic messages probe-verified identical) + `contracts-runtime-ok` (rc=0, pins `d = 5`)                                                                                                                                                                       |
| comptime-ref-gate.test.ts (109)            | comptime(ref(...)) rejection                     | **PORTED 2026-08-10** → `tests/comptime_ref.test.yo` negatives (message pins stay TS-side until retirement). Exposed + fixed: yo-self's modifier walker had inout BEFORE own and neither gate — generic(inout(T)) and inout(own(x)) were silently accepted                                                                                                                   |
| contracts-comptime-violation.test.ts (107) | contract compile errors                          | **PORTED 2026-08-10** → `tests/comptime.test.yo` (top-level comptime_expect_error — inside a test() body the def-time body eval fires the violation BEFORE the wrapper; 30/30 green under both compilers)                                                                                                                                                                    |
| pragma-validation.test.ts (97)             | pragma arg validation                            | **PORTED 2026-08-10** → cli-cases `pragma-typo` / `pragma-non-pragma-enum` / `pragma-non-enum` (comptime_expect_error(pragma(...)) crashes the TS CLI — not expressible that way). Exposed + fixed: yo-self's evaluate_pragma was syntactic-only and accepted all three silently → full Phase-G validation ported                                                            |
| thread-safety-codegen.test.ts (89)         | atomic RC codegen pins                           | port to `tests/internal/` (emitted-C greps) or accept as covered by runtime tests                                                                                                                                                                                                                                                                                            |
| import-path.test.ts (73)                   | safeRelativePath, win32 paths                    | **NOTHING TO PORT** (2026-08-10): yo-self deliberately omits `safeRelativePath` (yo-self/evaluator/exprs/import.yo header) — it uses absolute paths directly, which IS the helper's cross-drive fallback; same-drive relativization is cosmetic. Windows CI covers the behavior that matters                                                                                 |
| fixme.test.ts (28)                         | scratch harness                                  | dies with `src/`; port nothing                                                                                                                                                                                                                                                                                                                                               |
| src/doc/\*.test.ts (6 files, ~3,100)       | doc pipeline units                               | PARTIAL — extractor/sections/render-markdown have internal tests; builder/render-json now covered end-to-end by cli-cases doc-json/doc-markdown; render-html deferred with the html port                                                                                                                                                                                     |

**New P2 gap found by the inventory:** `unsafe-report` / `public-safe-report`
subcommands exist only in TS (`src/yo-cli.ts`) — they were never in P1's
scope table. They must be ported (or explicitly retired) before 2.5 can
delete `src/`.

## Sequencing note

2.1 (seed release) is the maintainer's cut — everything else here can land
first. The practical order: finish 2.2 (self-build verified both ways) →
2.4 ports → 2.3 CI swap on a seed release → 2.5 retire → 2.6 docs.
