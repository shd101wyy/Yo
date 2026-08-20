# `tests/cli-cases/` — the CLI case corpus

One directory per case, consumed by [`scripts/cli-diff-test.sh`](../../scripts/cli-diff-test.sh).
Each case runs in an isolated sandbox (own project dir, own `HOME`) and the
harness scores exit code, normalized stdout, the project tree and the `HOME`
tree against the case's recorded goldens.

It was a two-compiler differential until the TypeScript compiler was deleted
with `src/` — hence the harness's name. The goldens, recorded from the
self-hosted arm while both still existed, are the reference now.

This corpus exists because `check` proves a subcommand type-checks, not that
anything ever calls it — `init_project` shipped as 239 complete, type-checking
lines wired to no subcommand and SIGSEGV'd the first time it ran. See
[`plans/P1_CLI_PARITY.md`](../../plans/P1_CLI_PARITY.md) §1.

## Case layout

| file                 | required | meaning                                                                                                                                               |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd`                | yes      | one shell-quoted argv per line, run in order in the sandbox project                                                                                   |
| `fixture/`           | no       | copied into the sandbox project dir before the first command                                                                                          |
| `ignore`             | no       | one path glob per line, dropped from the tree comparison                                                                                              |
| `opts`               | no       | `stdout=strict\|ignore`, `stdout_keep=<ERE>`, `network=1`, `timeout=<seconds>`, `env=K=V` (repeatable; `<PROJ>`/`<HOME>` expand to the sandbox paths) |
| `expected_rc`        | yes      | golden files, recorded via `--record` — see Goldens below. A case without `expected_rc` fails as `NO-GOLDEN`.                                         |
| `expected_stdout`    | yes      | (absent for `stdout=ignore` cases — those score rc + trees only)                                                                                      |
| `expected_tree`      | yes      | project-tree manifest (`<relpath>\t<sha256>`)                                                                                                         |
| `expected_home_tree` | yes      | `HOME`-tree manifest, same format                                                                                                                     |

A run stops at the first non-zero exit code, so a `cmd` file may assert an error
path by putting the failing command last.

## Goldens — the corpus's post-retirement form

The harness scores the run against each case's recorded golden files
(`plans/P2_5_RETIRE_EXECUTION.md` step 12). Goldens were recorded **from the
self-hosted arm** (`--record`): the harness injects `YO_STD`, so the surviving
arm is the one whose environment was always explicit. A case with no goldens
scores `NO-GOLDEN` and fails the run — a silently unscored case is
indistinguishable from a passing one.

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh                   # score against goldens
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh --record <case>   # re-record after an intended behavior change
```

Re-record only when a behavior change is intended, and review the golden diff
in the same commit as the change that caused it — the diff IS the review
surface now that there is no second compiler to disagree.

(`--golden` is still accepted and does nothing; golden scoring is the only
mode.)

## Running

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh              # whole corpus
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh init -v      # one case, verbose
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh --network    # include network cases
```

## `stdout=ignore` is a debt marker, not a convenience

Prefer `stdout_keep_match=<ERE>` — it keeps only the matched substring of
matching lines, so a case can pin the diagnostic itself while discarding a
wrapper whose remainder is environment-specific. A pattern that matches nothing
fails the case (`NO-GOLDEN`, "matched nothing — vacuous"), so the assertion
cannot rot into "any failure passes". `stdout=ignore` survives only where there
is no such substring — as of P2.5 step 15 that is exactly one case
(`std-path-flag`, whose opts file documents why); say so in the `opts` file if
you add another.

Fixtures that must be misformatted `.yo` (the fmt cases) ship as
`fixture/*.yo.fixture` — the suffix is stripped on sandbox copy — so the
repo-tree `fmt --check` gate never sees them.

## `pending/` — empty, and that is the point

There is no `pending/` directory right now, and there should not be one unless a
subcommand is written before it is dispatched.

It existed while `build`, `fetch` and `install` were written but undispatched in
`src/main.yo`: their cases would have failed every run, so they sat one
directory down where the harness does not pick them up (it only treats a
directory containing a `cmd` file as a case). All three are dispatched now and
their cases have moved up.

If you write a case ahead of its subcommand, put it in `pending/` and move it up
**the same commit the subcommand is dispatched** — a case sitting in `pending/`
runs nowhere, which is indistinguishable from a case that passes.

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh tests/cli-cases/pending/<case> -v
```

## Known coverage gaps

- `cache-clean` only exercises the "cache directory does not exist" path.
  Covering the removal path needs a **populated** sandbox `HOME`, and `fixture/`
  is copied into the project dir only. Either teach the harness a
  `home-fixture/` alongside `fixture/`, or make the case's first command one
  that populates the cache (which today means a network `fetch`).
