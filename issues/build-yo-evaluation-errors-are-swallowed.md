# A parse or evaluation error in `build.yo` is swallowed; the user sees `Unknown step "install". Available: (none)`

**Status:** OPEN
**Found:** 2026-09-11, auditing the build system
(`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`). Reproduced with `yo 0.2.30`.
**Severity:** medium — every mistake in a build file (syntax error, duplicate
artifact name, wrong field type, unknown builtin) is reported as a missing
step, with no file, line, or message.

## Reproducer

```bash
yo init app --name app --no-skills && cd app
echo 'this is not yo (' >> build.yo
yo build
```

```
yo: error: Error: Unknown step "install". Available: (none)
```

The same happens for a semantic error that throws mid-file — e.g. two
`build.executable` calls with the same `name` (a real diagnostic exists for it,
`_check_duplicate_artifact_name`, `src/evaluator/builtins/build.yo:652-670`,
and it is never shown); the registry keeps whatever was registered before the
throw and the build proceeds on that partial graph.

## Root cause

`evaluate_build_file` (`src/build_runner.yo:1491-1510`) calls
`mm_load_yo_file` and binds its result to `_outcome`, which is never read.
`mm_load_file`'s error path (`src/module_manager.yo:783-790`) stashes the
rendered diagnostic in `g_load_module_error` for `_take_load_error`, but
`build_runner.yo` never imports `_take_load_error` (only `main.yo`,
`check_watch.yo` and `lsp/diagnostics.yo` do). The header comment
(`:1484-1487`) calls the swallowing intentional — "exactly as in TS" — but the
TS runner printed the error before continuing, and `yo fetch` has the same
shape (`src/fetch_command.yo:97-103`: a broken build file reports "No
dependencies declared in build.yo." with rc 0).

## Fix direction

After `mm_load_yo_file`, call `_take_load_error`; if it is `.Some`, print the
diagnostic through `error_format` and exit 1 before touching the registry. Do
the same in `run_fetch`. Gate: a `tests/cli-cases/build-file-syntax-error`
fixture asserting rc 1 and the `-->` location line.
