# An empty struct literal `{}` is accepted where unit is expected

**Severity:** S2 — the checker accepted a program that should be rejected: a `cond`/`match` arm (or
any unit-expected position) written `{}` type-checks, although `{}` is an empty STRUCT value, not
unit. No memory unsafety is known to follow; the type system lies about the value. Workaround: write
the unit value `()`.

**Status:** fixed (2026-10-18). Maintainer directive 2026-10-18 (on
`issues/repros/match-statement-falls-off-end.yo`'s follow-ups): "`true => {}` is wrong and should
give error"; the correct arm is `true => ()`.

## Reproducer (passed `yo check` before the fix)

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

`yo check repro.yo` printed `evaluator OK` on the v0.2.65 seed and on develop (`6029bb589`, verified
2026-10-18; re-verified on the v0.2.65 seed at `01-seed-repro-check.txt` in the fix PR's gate logs).
The same acceptance applied to `match` arms, to a `fn` body consisting of `{}`, to a unit argument
`u({})`, and to tail positions.

## Root cause (check-time, two cooperating acceptances; the parser was never at fault)

`{}` parses to the `_(...)` anon-struct literal (BK_ANON_STRUCT) with zero fields — a RECORD, in
every position, per the decided brace rule. Proof: `(fn() -> Empty)({})` with `Empty :: struct()`
already type-checked (and still does). The acceptance lived in the evaluator:

1. `src/types/compatibility.yo` carried a deliberate "Empty struct == unit (non-exact)" rule that
   returned true for empty-struct-vs-unit in BOTH directions (added so a no-op `.None => {}` arm
   could join a `()` sibling; `issues/fixed/yo-self-p1-transpile-tail.md`'s arm-type cluster). That
   rule gated every compat query: the fn-body-vs-declared-result check (E0604's gate in
   `evaluator/calls/function_type.yo`), argument checks, and sibling-arm joins.
2. `cond`/`match` stamp the whole expression's type from `ctx.expected_type` when it is concrete
   (`exprs/cond.yo`, `exprs/match.yo`), so an all-`{}`-arms cond inside a `-> unit` fn never even
   reached a compat query: the cond reported the expected `unit` directly.

## Fix

- Removed the "Empty struct == unit" compat rule (`src/types/compatibility.yo`): empty struct and
  unit are incompatible in both directions again, so every compat-gated unit-expected position
  rejects `{}`.
- Added the clear, literal-pointing rejection in the `_(...)` dispatch
  (`src/evaluator/exprs/_expr.yo`, beside the existing `{ x }` punned-record check): a zero-field
  literal against a unit expected type throws
  `` `{}` is an empty struct literal, but unit is expected here `` with help
  `` write `()` for the unit value — a brace group without a semicolon is a record, so `{}` is a zero-field struct ``.
  Arm bodies, fn bodies, unit arguments and tail expressions are all evaluated with the unit
  expected type, so they all get this message.
- Migrated the tree's own 20 no-op arms (`=> {}` → `=> ()`; see the census below), the only in-tree
  users. std, docs and embedded Yo (workflows, heredocs, `scripts/check-embedded-yo.sh`) carry none.

Kept legal: `{}` where a zero-field STRUCT type is expected (`Z :: struct(); (fn() -> Z)({})` still
checks — positive test), `{ }` with whitespace (same record, same rule), and every parse-level use
(the parser is untouched).

## Migration scope (all `=> {}` sites in the tree, `git grep -E '=> *\{\}'`, 2026-10-18)

- `src/`: `build_runner.yo` (4), `module_manager.yo` (5), `context_command.yo` (2),
  `skills_command.yo` (2), `evaluator/builtins/comptime_assert.yo` (2),
  `evaluator/builtins/gensym.yo` (2), `evaluator/builtins/and_or.yo` (1),
  `evaluator/builtins/va_start.yo` (1); the two `compatibility.yo` hits were comment lines inside
  the removed rule.
- `tests/env.test.yo` (1).
- `tests/sys/dir.test.yo`'s site was corrected to `()` in #1451; the
  `tests/internal/formatter_fixtures/25–26` hits are parse-level formatter input/expected pairs
  about compact array/tuple literals and stay valid — the rejection is a check-time rule, and
  formatter fixtures never run the evaluator.

Every site was audited: all are no-op arms whose sibling arms are `;`-terminated unit blocks, so
`=> ()` preserves the join type exactly. Re-grepped the whole tree plus `.github/workflows/`, shell
heredocs and docs after migrating: no further sites.

## Test plan (landed)

- `tests/basic.test.yo`, case "an empty struct literal {} is not the unit value":
  `comptime_expect_error` for a cond arm `{}`, a match arm `{}` and a `fn` body `{}` (each asserting
  the new message), positives for the same arms written `()`, and the genuine zero-field struct
  literal positive (`Z :: struct(); (fn() -> Z)({}); (z : Z) = mkz();`).
- Fails-before: the reproducer above passed `yo check` on the v0.2.65 seed (recorded); after the fix
  it fails with the new error.
