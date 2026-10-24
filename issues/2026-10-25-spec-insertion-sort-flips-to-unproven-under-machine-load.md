# `spec_insertion_sort` flips to unproven under machine load

**Severity:** S3 — `yo verify tests/spec/fixtures/valid` reports
`spec_insertion_sort` as `unproven` on a loaded machine and `ok` on a quieter
one: the same source, compiler and Z3 pin give different verdicts.

**Status:** open. **Found:** 2026-10-24 by the `style/while-true` verifier A/B
(develop `82671f612`, tree binary, pinned Z3 5.1.0, a 64 GB box running ~12
concurrent heavy jobs).

## Reproducer

```sh
yo verify ./tests/spec/fixtures/valid/spec_insertion_sort.yo --no-cache
```

Measured four runs of the identical query (the SMT goal text compared equal
across all four):

| Run | Tree | `loop-invariant-iterate~2` |
| --- | ---- | -------------------------- |
| directory run, 2026-10-24 ~18:30 | develop `39c8723fe` | proved |
| directory run, same window, in parallel | `style/while-true` (fixture unchanged) | unproven (`unknown`) |
| directory run, 2026-10-25 ~00:40 | develop `82671f612` | unproven (`unknown`) |
| file alone, 2026-10-25 ~01:00 | develop `82671f612` | unproven (`unknown`), 16 queries in 129 s |

## Analysis

`src/verifier/z3.yo` promises byte-identical verdicts: the budget is the
deterministic `:rlimit`, and the `:timeout` (30 s per query, `encode.yo`) is
only a crash-guard backstop. A verdict that depends on the run suggests the
wall-clock backstop fires before the rlimit is spent when the box is loaded,
and the harness maps that `unknown` to `Unproven` like a budget exhaustion.
Not yet confirmed: the harness does not record Z3's `:reason-unknown`, which
would tell a `timeout` from a `max. resource limit exceeded` / `canceled`.

## Next step

Record `(get-info :reason-unknown)` for an `unknown` answer and surface a
wall-clock timeout as its own outcome (or retry it), so a load-dependent
`unknown` is not reported as an unproven obligation.
