# `yo fix --migrate markers` skips files under `pragma(Pragma.Verify)`

**Severity:** S3: the migration tool silently leaves a whole class of files
unmigrated. The sweep reports them, but the report reads like an ordinary
evaluation failure, and the misses surface only on CI's Z3 job.

> Found 2026-10-12 fixing develop's Formal-verification job after #1318.

## Observed

```
$ yo fix ./tests/spec --migrate markers
fix: tests/spec/fixtures/valid/list_distinct.yo does not evaluate; its arguments are migrated only as far as evaluation reached
...
fix: inserted 0 `&` and 0 `&mut` call-site marker(s); 0 site(s) left as written (listed above); 31 file(s) did not evaluate
```

All 31 files that "do not evaluate" are `pragma(Pragma.Verify)` fixtures.
`yo check` evaluates the same files fine (it reports the one real E0914 in
`list_distinct.yo`), and a single-file `yo fix` on that fixture still
inserts nothing. The two missed sites were lent by hand
(`issues/fixed/the-verifier-loses-a-lent-list-argument-at-a-contracted-call.md`).

## Expected

`yo fix` evaluates a Verify-pragma file the way `yo check` does (no solver
needed) and records its marker sites, or names the pragma as the reason it
skipped the file.

## Next step

Find what makes `run_fix`'s evaluation of a Verify-pragma file fail where
`run_check`'s succeeds (`src/main.yo`), and add a cli-case: a Verify-pragma
file with one bare `&T` argument, migrated by `yo fix --migrate markers`.
