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

| file       | required | meaning                                                             |
| ---------- | -------- | ------------------------------------------------------------------- |
| `cmd`      | yes      | one shell-quoted argv per line, run in order in the sandbox project |
| `fixture/` | no       | copied into the sandbox project dir before the first command        |
| `ignore`   | no       | one path glob per line, dropped from the tree comparison            |
| `opts`     | no       | `stdout=strict\|ignore`, `network=1`, `timeout=<seconds>`           |

A run stops at the first non-zero exit code, so a `cmd` file may assert an error
path by putting the failing command last.

## Running

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh              # whole corpus
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh init -v      # one case, verbose
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh --network    # include network cases
```

## `stdout=ignore` is a debt marker, not a convenience

Use it only where the two binaries deliberately identify themselves differently
(the self-hosted one prefixes fatal errors with `yo-self: error:`), and say so in
the case's `opts` file. Everywhere else, make the output match instead.

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
