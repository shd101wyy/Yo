# An empty struct literal `{}` is accepted where unit is expected

**Severity:** S2 — the checker accepts a program that should be rejected: a `cond`/`match` arm (or
any unit-expected position) written `{}` type-checks, although `{}` is an empty STRUCT value, not
unit. No memory unsafety is known to follow; the type system lies about the value. Workaround: write
the unit value `()`.

**Status:** open. Maintainer directive 2026-10-18 (on
`issues/repros/match-statement-falls-off-end.yo`'s follow-ups): "`true => {}` is wrong and should
give error"; the correct arm is `true => ()`.

## Reproducer (passes `yo check` today; every `{}` arm should be an error)

```yo
export(main);
m :: (fn(b : bool) -> unit)({
  cond(
    b => {},
    true => {}
  );
});
main :: (fn() -> unit)({
  m(true);
});
```

`yo check repro.yo` prints `evaluator OK` on the v0.2.65 seed and on develop (`6029bb589`, verified
2026-10-18). The same acceptance applies to `match` arms and to a `fn` body consisting of `{}` — the
whole class of unit-expected positions should be audited.

## Suspected cause

Either the parser types an empty brace group as a block/unit in arm-body position (the record rule —
"a brace group is a record unless it contains a `;`" — should make `{}` an empty record value), or
the evaluator coerces an empty struct literal to unit when the expected type is `unit`. Distinguish
the two before fixing; the fix must keep `{}` legal where an empty struct is genuinely expected
(a zero-field struct type), and reject it with a clear error naming `()` as the unit value.

## Migration scope (all `=> {}` sites in the tree, `git grep -E '=> *\{\}'`, 2026-10-18)

- `src/`: `build_runner.yo` (4), `module_manager.yo` (5), `context_command.yo` (2), `skills_command.yo` (2), `types/compatibility.yo` (2), `evaluator/builtins/comptime_assert.yo` (2), `gensym.yo` (2), `and_or.yo` (1), `va_start.yo` (1)
- `tests/env.test.yo` (1)
- (`tests/sys/dir.test.yo`'s site was corrected to `()` in the same window; the
  `tests/internal/formatter_fixtures/25–26` hits are parse-level formatter input/expected pairs about
  compact array/tuple literals and stay valid — the rejection is a check-time rule.)

Each site becomes `=> ()` (or, where the arm is the only content, the arm keeps `{}` ONLY if a
statement block was meant — audit each; a block with statements ending in `;` already evaluates to
unit).

## Test plan

- A `comptime_expect_error` (or check-negative) case: a `cond` arm `{}` where unit is expected is
  rejected with the new error; same for a `match` arm and a `fn` body `{}`.
- Positive cases: the same arms written `()` still check and run; a genuine zero-field struct literal
  in a struct-expected position still checks.
- Fails-before: the reproducer above passes `yo check` on develop (record the output).
