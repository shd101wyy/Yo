# `yo fix --migrate unsized` boxes a generic body's `dyn(Box.new(v))` a second time

**Severity:** S2 — a second run of the migration (or a first run over code already written `dyn(Box.new(v))` in a generic body) rewrites it to `dyn(Box.new(Box.new(v)))`, which no longer type-checks (`Type Box(i32) does not implement the trait ToString`).

Found 2026-11-12 by the decision 49 S1g sweep with #1901's recorder. `tests/dyn.test.yo`'s `_generic_show` (`dyn(v.*)` in a `generic(T : Type)` body) was rewritten correctly by the first run and boxed again by the second.

## Reproducer

`tests/cli-cases/fix-migrate-unsized/fixture/main.yo`'s

```yo ignore
_gen_speak :: (fn(generic(T : Type), v : &T, where(T <: Speak)) -> i32)(_owned(dyn(v.*)));
```

became `dyn(Box.new(Box.new(v.*)))` after two runs.

## Cause

For an open payload, `evaluate_dyn_value` evaluates `dyn(Box.new(v))`, which it reads as `dyn(Rc.new(v))`, through the prelude cell (`_prelude_cell_callee`) in the non-executing path. The payload's ExprInfo type is then `v`'s type, not a cell. The recorder (`_record_unsized_dyn_site`) took that for the legacy auto-box of a plain value, kind 2, and recorded `dyn(Box.new(...))` again.

## Fix

Kind 2 also requires that the argument as written is not `Box.new(...)`, `Rc.new(...)` or `Arc.new(...)` (`_written_cell_new`).

Test: the `fix-migrate-unsized` cli case's `_gen_speak`. The first run writes it once, and the second run rewrites nothing.
