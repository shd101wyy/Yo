# `yo fix --migrate rc-clone` moves a handle that an earlier argument of the same call lends (E0910)

**Severity:** S3: the migration leaves a call that does not type-check, so
the migrated file needs a hand edit. The rule and E0910 are right; only the
repair tool picks the wrong spelling.

> Found 2026-10-28 by the V2c sweep of `tests/internal/env_lookup.test.yo`.

## Reproducer

```yo ignore
trait_ty := t_trait_simple(`Comptime`);
_d := env.define_val(`Comptime`, &trait_ty, true, .Some(EvalValue.TypeVal(trait_ty)));
```

After the sweep `trait_ty` is not read again, so the migration judges the
copy in the last argument a last-use move and inserts nothing. But the second
argument lends `trait_ty` to the same call:

```
error[E0910]: This argument moves `trait_ty`, which an earlier argument of the same call lends to it (`&(trait_ty)`) …
help: move a copy instead (`trait_ty.clone()`), or split the call so the move comes after it
```

## Repair by hand

`.Some(EvalValue.TypeVal(Rc.clone(trait_ty)))`.

## Where to look

The migration's move-or-copy judgement (`_ic_migrate_site`,
`src/evaluator/utils.yo`) does not see decision 28's argument exclusivity. A
last-use move whose call lends the same place in an earlier argument should be
spelled as a clone, as a copy whose source is read again is.
