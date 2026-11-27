# `yo fix` exits after one parse-error repair when another parse error remains

**Severity:** S3 — a file with two repairable parse errors (two compound assignments, E0010) is repaired once per `yo fix` run: the run applies the first repair, prints the second error and exits 1, so the user reruns `fix` once per error.

Filed 2026-11-26 by the `v81-v84-pr2` lane while recording `tests/cli-cases/fix-rewrites-a-compound-assignment`.
Reproduced with a stage 1 of `wip/v0281-v84-pr2` (develop `77af20c87` plus the E0010 repair).

## Reproducer

```yo ignore
main :: (fn() -> unit)({
  (mut(x) : i32) = i32(4);
  x += i32(1);
  x -= i32(2);
  _y := x;
});
export(main);
```

```text
$ yo fix .
error[E0010]: Yo has no compound assignment: `-=` is an operator followed by `=`. Write the assignment out: `x = (x - i32(2))`.
  --> main.yo:4:5
fix: main.yo:3:5: write `x = (x + i32(1))`
```

The file then holds `x = (x + i32(1));` and the untouched `x -= i32(2);`; `fix` printed no `applied` line and
exited 1.

## Root cause

After each rewrite, the pass loop of `run_fix` (`src/main.yo`) formats the file with `run_fmt`. `run_fmt` installs its
own exception handler that prints the error and calls `exit(1)`, and formatting parses the file first. A file whose
first parse error was repaired still fails to parse at the second, so `fmt` ended the whole `fix` process before the
next pass could read the second repair. Evaluator repairs never hit it: their files parse.

## Fix

The pass loop formats a rewritten file only when it parses (`_parse_or_none`); the pass whose repair makes the file
parse formats it. Test: `tests/cli-cases/fix-rewrites-a-compound-assignment` (four compound assignments, all
rewritten in one `fix` run, then `check` passes).
