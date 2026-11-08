# `Type.impls(T, Escapable)` answers `false` for every type

**Severity:** S3: a wrong compile-time answer from a reflection query. The
bound `where(T <: Escapable)` and every storage check decide `Escapable`
correctly; only `Type.impls` asks the question wrongly.

Found 2026-11-08 while writing `tests/sized.test.yo` (decision 49 S1a): the
derived `Sized` marker had the same wrong answer.

## Repro (v0.2.76)

```yo
main :: (fn() -> unit)({
  comptime_assert(Type.impls(i32, Escapable), "an i32 carries no origin");
});
export(main);
```

`yo check` fails the assertion. `Type.impls(i32, Send)` holds.

## Root cause

`Type.impls` is a prelude method whose body calls `__yo_type_impls`, so the
question is asked in the environment where that body is written. That
environment is a snapshot taken near the top of the prelude. `Escapable` is
defined about 6,000 lines further down, so it is not in the snapshot.
`is_escapable_trait` looked the marker up by name in that environment only.
It found nothing and answered "not the marker", and the structural answer
was never reached. `Send`, `Sync` and `Acyclic` are defined above the method,
which is why they answer correctly.

## Fix

`_is_prelude_marker_trait` (`src/evaluator/trait_checking.yo`) looks the
marker up in the given environment first. If that fails, it looks in the
cached prelude environment. `is_escapable_trait` and `is_sized_trait` both
go through it.

Test: `tests/borrow_spelling.test.yo`, "Type.impls answers Escapable
structurally".
