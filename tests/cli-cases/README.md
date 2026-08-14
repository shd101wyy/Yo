# `tests/cli-cases/` — the CLI differential corpus

One directory per case, consumed by [`scripts/cli-diff-test.sh`](../../scripts/cli-diff-test.sh).
Each case runs under BOTH compilers in two isolated sandboxes (own project dir,
own `HOME`) and the harness compares exit code, normalized stdout, the project
tree and the `HOME` tree.

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
| `expected_rc`        | no       | golden files, recorded from the self-hosted arm via `--record` — see Golden mode below.                                                               |
| `expected_stdout`    | no       | (absent for `stdout=ignore` cases)                                                                                                                    |
| `expected_tree`      | no       | project-tree manifest (`<relpath>\t<sha256>`)                                                                                                         |
| `expected_home_tree` | no       | `HOME`-tree manifest, same format                                                                                                                     |

A run stops at the first non-zero exit code, so a `cmd` file may assert an error
path by putting the failing command last.

## Golden mode — what outlives `src/`

When `out/cjs/yo-cli.cjs` is missing (or `--golden` is passed), the harness
scores the self-hosted arm against each case's recorded golden files instead of
against the TS reference — this is the corpus's post-retirement form
(`plans/P2_5_RETIRE_EXECUTION.md` step 12). Goldens are recorded **from the
self arm** (`--record`): the harness injects `YO_STD` on the self side only, so
the surviving arm is the one whose environment was always explicit. A case with
no goldens scores `NO-GOLDEN` and fails the run — a silently unscored case is
indistinguishable from a passing one.

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh --golden          # score against goldens
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh --record <case>   # re-record after an intended behavior change
```

Re-record only when a behavior change is intended, and review the golden diff
in the same commit as the change that caused it — the diff IS the review
surface once the TS arm is gone.

## Running

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh              # whole corpus
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh init -v      # one case, verbose
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh --network    # include network cases
```

## `stdout=ignore` is a debt marker, not a convenience

Prefer `stdout_keep_match=<ERE>` — it keeps only the matched substring of
matching lines, so a case can assert the shared diagnostic even when the two
binaries wrap it differently (TS an uncaught throw with a stack, the
self-hosted one a `yo: error:` line). A pattern that matches nothing on either
side fails the case (`keep-match-vacuous`), so the assertion cannot rot into
"any failure passes". `stdout=ignore` survives only where there is NO shared
substring — as of P2.5 step 15 that is exactly one case (`std-path-flag`,
whose opts file documents why); say so in the `opts` file if you add another.

Fixtures that must be misformatted `.yo` (the fmt cases) ship as
`fixture/*.yo.fixture` — the suffix is stripped on sandbox copy — so the
repo-tree `fmt --check` gate never sees them.

## `pending/` — empty, and that is the point

There is no `pending/` directory right now, and there should not be one unless a
subcommand is written before it is dispatched.

It existed while `build`, `fetch` and `install` were written but undispatched in
`yo-self/main.yo`: their cases would have reported `SELF-FAIL` every run, so they
sat one directory down where the harness does not pick them up (it only treats a
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
