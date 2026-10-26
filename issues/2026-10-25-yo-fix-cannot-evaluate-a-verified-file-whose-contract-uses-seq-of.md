# `yo fix --migrate explicit-copy` cannot evaluate a verified file whose contract uses `seq_of`, and does not say why

**Severity:** S3 — the migration skips such a file's copies with a generic "does not evaluate" while `yo check` accepts the file, and the load error is discarded

Filed 2026-10-25 while running the VBD B7b for-source dry run over
`tests/` (the item's sweep of `for(xs, …)` sources used afterwards).

## Reproducer

```yo
pragma(Pragma.Verify);
{ ArrayList } :: import("std/collections/array_list");
first :: (fn(xs : &ArrayList(i32), ensures(seq_of(r) == seq_of(xs))) -> (r : ArrayList(i32)))({
  out := ArrayList(i32).new();
  out
});
```

```
$ yo check v2.yo                      # rc 0
$ yo fix v2.yo --migrate explicit-copy --dry-run
fix: v2.yo does not evaluate; its copies are migrated only as far as evaluation reached
fix: would insert 0 `.clone()` call(s); 0 site(s) left as written (listed above); 1 file(s) did not evaluate
```

Measured with develop `35c72789a` (and the B7b branch): the same file with
a contract that uses no ghost builtin (`ensures(r == (x + i32(1)))`)
evaluates under `fix`, and `tests/spec/fixtures/valid/for_produced.yo`
(which uses `seq_of` and `produced`) fails the same way. Dropping
`pragma(Pragma.Verify)` makes `yo check` report "ghost-only builtin (legal
only inside contract clauses …)", which suggests the evaluation `fix` runs
does not treat the contract clause as one; that is unconfirmed, because the
error itself is never printed.

## Two defects

1. The evaluation behind `yo fix --migrate explicit-copy`
   (`_run_migrate_explicit_copy`, `src/main.yo`, through `mm_load_file`)
   rejects a file `yo check` accepts.
2. It drops the load error (`_drop := _take_load_error();`) and prints only
   "does not evaluate", so the cause has to be found by bisecting the file.
   The other evaluating migrations (`addr-of`, `mut-bindings`, …) share the
   pattern.

## Fix

Print the load error's first diagnostic in the "does not evaluate" line,
then make the migration's load evaluate contract clauses the way `check`
does. Test: a cli-case running `yo fix --migrate explicit-copy --dry-run` on
the reproducer, expecting it to evaluate (rc 0, no "did not evaluate").
