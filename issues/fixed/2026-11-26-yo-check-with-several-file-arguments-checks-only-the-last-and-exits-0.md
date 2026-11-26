# `yo check` with several file arguments checks only the last one and exits 0

**Severity:** S2 — `yo check a.yo b.yo` silently skips every file but the last and exits 0 when the last file is clean, so a script that batches files into one call gets a hollow green.

- Filed: 2026-11-26 (lane `deref-f2`, VERDICTS-73). Found when an oracle script passed a list of 471 files to one `yo check --test-bodies` call. It reported no error, but only the last file in the list had been checked.
- Reproduces with the v0.2.79 seed and with a tree binary built from develop `1175c046c`.
- Status: FIXED by the `fix/check-multiple-paths` PR.

## Reproducer

`bad.yo`:

```yo
main :: (fn() -> unit)({
  (x : i32) = "not an i32";
});
export(main);
```

`good.yo`:

```yo
main :: (fn() -> unit)({
  ();
});
export(main);
```

```text
$ yo check bad.yo good.yo; echo rc=$?
check: /home/…/std/prelude.yo — evaluator OK
check: good.yo — evaluator OK
rc=0
$ yo check good.yo bad.yo; echo rc=$?
error[E0601]: Incompatible types:
…
rc=1
```

`bad.yo` is never parsed in the first call.

## Root cause

`run_check` (`src/main.yo`) takes one positional path. Its argument loop assigns each positional to `target_path`, so a later positional overwrites an earlier one without any diagnostic:

```yo ignore
true => {
  target_path = a.clone();
  ai = (ai + usize(1));
}
```

The usage line says `yo check <input.yo | dir>`, but nothing enforces the single path. A directory argument is not affected: `collect_check_files` walks it.

## Fix

`yo check` takes several paths. `run_check` collects every positional, walks each one with `collect_check_files` (a directory as before), and checks the union in argument order, each file once. This is the loop `yo fix` already uses for its several paths. The per-file output is unchanged. With more than one file the run prints the `check: N/M file(s) passed` tally and exits 1 when any file fails. `--help` and the usage lines now say `yo check <file-or-dir>...`.

The same overwrite was in the other subcommands that take one input. Each now rejects a second positional with an error and rc 1:

| command | before | now |
| --- | --- | --- |
| `compile` | last input compiled, rc 0 | `compile: one input file per run, got 'a.yo' and 'b.yo'` |
| `effects` | last path reported | `effects: one path per run, …` |
| `unsafe-report`, `public-safe-report` | last path reported | `<cmd>: one path per run, …` |
| `version` | a third positional replaced the value | `version: unexpected extra argument '…'` |
| `explain` | last code explained, rc 0 | `explain: one error code per run, …` |

`explain`'s argument loop started at the subcommand name itself, so a bare `yo explain` reported `unknown error code 'explain'`. It now starts after the name, and a bare `yo explain` is the missing-code usage error.

`verify`, `test`, `doc`, `init`, `add`, `remove`, `cache` and `context` already rejected an extra positional. `fmt`, `fix`, `update` and `build` take several and handle every one. `install` takes none.

Regression: the cli-cases `check-several-paths-checks-every-one` (bad then good: E0601, `1/2`, rc 1), `check-several-clean-paths-pass`, `compile-a-second-input-is-rejected`, `effects-a-second-path-is-rejected`, `unsafe-report-a-second-path-is-rejected`, `public-safe-report-a-second-path-is-rejected`, `version-an-extra-argument-is-rejected`, `explain-a-second-code-is-rejected` and `explain-without-a-code-is-a-usage-error`.

## Exposure

A grep of `scripts/` and `.github/workflows/` (2026-11-26) found no gate that passes several files to one `yo check`/`yo compile` call:

- G-A (`origins-corpus.sh`), G-B (`origins-unsound.sh`) and G-E (`check-origin-sinks.sh`) call once per program.
- `check-docs.py` calls once per block.
- `origins-gen.py` batches by passing a directory.

The only hollow run was the lane-local oracle that found this bug.
