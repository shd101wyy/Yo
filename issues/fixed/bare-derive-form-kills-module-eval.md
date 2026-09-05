# `derive(T, Eq)` (bare trait, no params) kills module evaluation with a misleading error

**Status: FIXED 2026-09-05** — by the shared containment in
`issues/fixed/derive-ord-without-a-prior-derive-eq-kills-module-evaluation.md`.
The bare form is still REJECTED (option 2 of "Wanted" below), but now at the
derive site with the real cause:

```
error[E0603]: derive on "Point" failed: error[E0603]: Argument count mismatch: expected 1, got 0
  --> bare_derive.yo:7:15
  |
7 | derive(Point, Eq);
  |               ^^
```

`yo check` fails on it instead of reporting the module OK. Regression test:
`tests/derive.test.yo`, the module-level `comptime_expect_error` around
`derive(BareTraitArg, Eq)`.

**Found:** 2026-08-22 while probing user-defined derive rules for
derive(ToJson). `derive(Point, Eq(Point))` works; the BARE form
`derive(Point, Eq)` does not — and instead of an error at the derive
site, the whole module's evaluation dies and the surfaced diagnostic is
`Variable "Point" not found.` at Point's LATER use (under `compile`), or
a missing-method error (under `check`). Classic error-token-location lie.

Likely mechanics: the bare form hands the rule empty `trait_params`; the
prelude rules splice `Eq(...#(trait_params))` which yields `Eq()` — an
invalid trait application — and the failure is swallowed into the
def-time module-eval abort instead of anchoring at the `derive(...)`
statement.

## Wanted

Either make the bare form legal (default trait_params to `[T]`?) or
reject it AT THE DERIVE SITE with a real message ("derive: trait
arguments required — write derive(Point, Eq(Point))").

RESOLVED as option 2, generically: every derive-rule failure is now anchored at
the `derive(...)`, so the bare form reports the arity mismatch it actually hits
rather than a bespoke message. Making the bare form LEGAL stays open as a
language-design question — it would need a rule for which traits default their
parameter to the target type (`Eq`/`Ord` yes, `Index(K)` no).

Repro: two-line module — `Point :: struct(x : i32); derive(Point, Eq);`
plus any later use of Point.
