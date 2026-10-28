# A `yo fix` batch over `tests/` rejects later files' std `clone()` of a `mut` global after `copy_trait.test.yo`

**Severity:** S3: a migration tool misreports files it never changes. In one
`yo fix ./tests --migrate rc-clone` run, every file evaluated after
`tests/copy_trait.test.yo` that reads a `mut` global through std's
`clone()` "does not evaluate" (E0916), so its copies are not migrated. Each
file alone evaluates, and `yo check` over the same file list is clean.

> Found 2026-10-28 by the V2c rc-clone sweep of `tests/`: all 88
> `tests/internal` files that import `src/utils.yo` (`g_current_owner.clone()`)
> or `src/diagnostics.yo` (`g_error_format.clone()`) were reported as not
> evaluating. The sweep works around it by running `tests/internal` as its
> own batch.

## Reproducer

`tmp/zz_probe.yo`:

```yo ignore
{ String } :: import("std/string");
(mut(g_s) : String) = String.from("x");
read_s :: (fn() -> String)(g_s.clone());
export(read_s);
```

```bash
yo fix tests/copy_trait.test.yo tmp/zz_probe.yo --migrate rc-clone --dry-run --std-path ./std
# fix: tmp/zz_probe.yo does not evaluate; ...
YO_DEBUG_FIX=1 ...   # error[E0916]: Cannot lend `g_s` to `g_s.clone` ...
yo fix tmp/zz_probe.yo --migrate rc-clone --dry-run --std-path ./std            # clean
yo check tests/copy_trait.test.yo tmp/zz_probe.yo --std-path ./std              # clean
```

Bisected over the 740 non-internal `tests/` files (`yo fix` with the probe
appended): `tests/copy_trait.test.yo` alone poisons.

## Suspected cause (not yet confirmed)

`copy_trait.test.yo` checks rejected impls with `comptime_expect_error`, among
them the blanket `impl(generic(T : Type), T, Copy())` ("only a value type").
Under `yo fix` the expected error is still raised, but an impl registered
before the rejection seems to stay in the process-wide trait registry, so in a
later file `String`'s `clone()` resolves to a candidate defined outside std
and `_is_structural_clone_call` (`src/evaluator/calls/function.yo`) no longer
exempts the receiver from E0916. `yo check` evaluates the same file without
leaving it behind, so the difference is in the migration mode's evaluation of
`comptime_expect_error` bodies.

## Workaround

Run `tests/internal` (or any file that reads a `mut` global through
`clone()`) as a separate `yo fix` batch.
