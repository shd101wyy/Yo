# `yo fix --migrate` aborts a whole directory walk at a malformed nested `yo.toml`

**Severity:** S3 — one `yo fix <dir> --migrate …` invocation applies NOTHING and prints no per-file diagnostics or summary when any nested project under the walk carries a malformed `yo.toml`; the workaround is `--exclude`, and the marker sweep of this repository needed it for `tests/cli-cases/doc-name-manifest-malformed`.

## Symptom

During the marker sweep part 2 (2026-10-11), `yo fix ./tests --migrate markers`
exited 1 with no summary and rewrote nothing:

```console
$ yo fix ./tests --migrate markers --std-path ./std
fix: tests/cli-cases/… (per-file lines) …
yo: error: /…/tests/cli-cases/doc-name-manifest-malformed/fixture/yo.toml: [package] name is required
```

Minimal reproduction (verified 2026-10-11 with the v0.2.59 seed):

```bash
mkdir -p /tmp/repro/fixture
printf 'x := i32(1);\nshow :: (fn(n : &i32) -> i32)(n.*);\n_n := show(x);\n' > /tmp/repro/migrate_me.yo
cp /tmp/repro/migrate_me.yo /tmp/repro/fixture/lib.yo
printf '[package]\n' > /tmp/repro/fixture/yo.toml      # a malformed manifest (no name)
yo fix /tmp/repro --migrate markers --std-path ./std   # rc=1; migrate_me.yo left bare, no summary
```

`yo fmt /tmp/repro` and `yo check /tmp/repro` over the same directory both
exit 0 — only the `fix --migrate` walk is fatal.

## Root cause

`_run_migrate_markers` (`src/main.yo`) loads each file with `mm_load_file`
and handles a returned failure per file (`fix: <file> does not evaluate; …`),
counting it and continuing. But for a file whose NEAREST `yo.toml` is
malformed, module resolution throws before returning: manifest setup
(`src/module_manager.yo`, the `load_manifest`/`resolve_import_roots` error
arms around `src/module_manager.yo:2101`–`2110`) does `exn.throw(dyn(msg))`,
and the throw propagates out of the walk loop — the insert phase never runs,
so even files that evaluated cleanly are left unwritten and no summary is
printed. A `.yo` file with a syntax/type error is treated as per-file data;
a broken manifest next to it is treated as fatal.

## Fix direction

Catch the throw per file in the migrate walk (the same treatment as
`!outcome.ok`): report `fix: <file> does not evaluate; its arguments are
migrated only as far as evaluation reached` (or a manifest-specific line),
count it in `failed`, and continue; the walk then prints its summary. Applies
to every `--migrate` mode sharing the loop, and regression-tested with a
cli-case whose fixture nests a malformed `yo.toml` beside a file with a bare
marker site: before the fix the run aborts with rc=1 and no rewrite; after,
the sibling file is migrated and the walk reports the one failure.
