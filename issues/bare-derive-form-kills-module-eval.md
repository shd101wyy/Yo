# `derive(T, Eq)` (bare trait, no params) kills module evaluation with a misleading error

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

Repro: two-line module — `Point :: struct(x : i32); derive(Point, Eq);`
plus any later use of Point.
