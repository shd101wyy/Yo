# A wrong cli-case golden reached `develop` through the gap between two gates

**Status:** OPEN. Found 2026-09-17 while landing
`plans/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` slice 2 (#724).

`develop` carried a golden that its own compiler contradicts:

```
tests/cli-cases/contracts-runtime-old-ensures/expected_stdout
golden < ensures failed: n == old(n) (at src/main.yo:1:40)
run    > ensures failed: n == old(n) (at src/main.yo:1:39)
```

Measured on `f40fe21d2` itself, in a throwaway worktree with no other changes:
`PASS 2  GOLDEN-DIFF 1` across the three `contracts-runtime-*` cases.

**39 is correct, and the corpus says so rather than anyone's taste.** The
sibling goldens encode "the operator's FIRST character":

| case | operator | starts at column | golden |
| --- | --- | --- | --- |
| `contracts-runtime-ensures` | `>=` | 40 | 40 ✓ |
| `contracts-runtime-requires` | `!=` | 44 | 44 ✓ |
| `contracts-runtime-old-ensures` | `==` | 39 | 40 ✗ |

Only the `old(...)` form goes through `_hoist_old_in`, and `_build_assert_call`
takes its position from `ast_expr_token` of the REWRITTEN predicate, so that is
the path that decides the value. Corrected to 39 in #724.

## The real defect: it passed between two gates that both cover it

CI **does** score all 150 cases on every PR — the indirection is why this is
easy to get wrong. `test.yml:1662` runs
`S1=/tmp/yo-stage1 P=ci bash scripts/bootstrap/gates_fast.sh`, which at
`gates_fast.sh:241` runs `scripts/cli-diff-test.sh` and fails at line 254 with
`CLI golden scorecard is not clean: …`. **A `grep -rn cli-diff .github/`
therefore finds nothing, because the workflow names the wrapper and the wrapper
lives under `scripts/`.** Do not conclude from that grep that the corpus is
ungated; scope the search to `scripts/bootstrap/` too.

So both nets exist, and the golden still landed:

1. **The PR's own scoring never finished.** #710 merged at 2026-09-16T18:09:30Z
   while `Self-hosted \`test\` subcommand (yo-self tier-1 gates)` — the job that
   runs the scorecard — was still `pending`. A merge that precedes its own
   golden gate is ungated by it.
2. **`develop`'s post-merge battery was cancelled.** `f40fe21d2`'s run was
   cancelled, as were `939eb6f0f`'s and three before them, by the
   supersede-and-cancel hygiene `AGENTS.md` prescribes for a rapid merge train.

After that, no later PR reports it: each PR battery scores **its own tree**, and
a PR that does not touch the contracts path scores that golden as PASS against
the same wrong file. The error is stable and invisible until something moves
that column.

## What this costs, and the options

The cancel rule in `AGENTS.md` is correct as written and has an unpriced cost:
cancelling a superseded `develop` run also discards the only run that scores
`develop`'s OWN goldens after a merge. Combined with merging before a gate
completes, there is a window where a wrong golden is permanent.

- **Do not merge while the tier-1 gate is pending** — it is the golden gate, and
  it is the cheapest of the three fixes.
- **Never cancel a `develop` run that is the first to carry a given tree**, even
  when superseded; cancel the older duplicates instead.
- Optionally, score goldens in a small standalone job so the signal does not
  ride inside a long tier-1 leg and is not lost when that leg is cancelled.

The generalisable lesson is the search, not the column: **a capability invoked
through a wrapper is invisible to a grep scoped to the caller's directory.**
I concluded "CI never runs the harness" from exactly that mistake, and a peer
session corrected it with the line numbers above.
