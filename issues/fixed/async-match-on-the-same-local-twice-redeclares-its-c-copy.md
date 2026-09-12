# Two `match`es on the same local in an `io.async` body redeclare its C copy (`redefinition of 'parsed'`)

**Status:** FIXED 2026-09-12 (`p1/yo-toml-manifest`, `src/codegen/exprs/match.yo`).
**Found:** 2026-09-12, building the compiler with the new `install_command.yo`:
`run_add` bound `parsed := match(parse_package_specifier(…), …)` and matched
it twice (a statement `match(parsed, .Path … .Git …)` and
`is_path := match(parsed, …)`); `install_dependencies` matched `requirement`
twice in a `while` body. The C compiler failed with
`error: redefinition of 'parsed'` / `redefinition of 'requirement'`.
**Severity:** high — a legal, natural shape (read an enum local in two
`match`es) makes an async body fail at the C step; the whole build of the
compiler was blocked by it.

## Reproducers

`issues/repros/async-match-same-local-twice.yo` (top-level async body: a
match-bound `parsed`, a statement match, then `is_path := match(parsed, …)`,
two awaiting `if`s, a third match) and
`issues/repros/async-match-same-local-twice-in-while.yo` (a `while` body:
`requirement := match(src, …)` and `url := match(src, …)` — two matches on
the loop's `src`). Both compiled on the pre-fix compiler to

```c
      __yo_t11 parsed = sm->var_1399220;
      switch ((parsed).tag) { … }
      …
      __yo_t11 parsed = sm->var_1399220;   // error: redefinition of 'parsed'
      switch ((parsed).tag) { … }
```

## Root cause

`generate_match_expression` materializes the subject into a C variable named
by the evaluator's `variable_name` whenever the generated subject code differs
from that name (`__yo_tN parsed = <code>;`), so that the arms destructure a
stable value. For a NON-atom subject (a call, a field read) that name is a
minted temp, unique per match. For an ATOM subject the name is the variable's
own, and in an async body the atom's code is its state-machine slot
(`sm->var_N`) — different from the name — so every match on the same local
emitted `__yo_tN name = sm->var_N;` into the current block. The `ref`/`inout`
parameter case (`(*name)`) had the same defect and carried a guard
(`is_inout_atom`); no other atom did.

## Fix

An atom subject is never materialized: its code already denotes the
variable's storage (the plain C name, `(*name)`, or `sm->var_N`), and the
arms read `(<code>).tag` / `<code>.data.V.f` from it directly — the guard is
widened from `inout` atoms to every atom. Non-atom subjects keep their
per-match temp. A synchronous function's match on a plain local emitted no
copy before (code == name) and emits none now, so only async bodies and
closure captures change.

## Gates

- `tests/async_await.test.yo`: "two matches on the same match-bound local in
  one async body" and "two matches on a loop local in an async while body" —
  red on the pre-fix compiler (batch C compile fails), green after.
- `check ./src` 271/271; the compiler builds; gen-1/gen-2 fixpoint.
- Seed gate: the released seed still has the bug, so `src/` code compiled by
  the seed must not match one async local twice until the seed bump —
  `install_command.yo` decides its flags inside a single `match` (a comment
  at each site names this issue).
