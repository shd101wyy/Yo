# The verify cache stores wall-clock `unknown` verdicts and keys on the pinned Z3 version, not the binary that ran

**Severity:** S3 — a query that timed out once on a loaded machine stays `unproven` from the cache on every later run, and a verdict computed by a different Z3 (`YO_Z3_PATH`) is served as if the pinned one produced it.

**Status:** fixed (branch `fix/verify-cache-hardening`, 2026-11-04). **Found:** 2026-11-04 by the Ada/SPARK lessons audit (`plans/backlog/ADA_SPARK_LESSONS.md`). Read from develop `fabe5d88e`.

## The two defects

1. **Inconclusive verdicts are cached.** `run_vc_query` (`src/verifier/driver.yo` ~L364–L399) treats every verdict except `SolverError` as terminal, so `Unproven(reason)` is stored. Z3 answers `unknown` both when the deterministic rlimit runs out (a reproducible verdict) and when the wall-clock backstop (`timeout_ms`) fires first (a load-dependent one). Only the first is cacheable. SPARK states the rule: "Only conclusive results are cached" (SPARK UG §7.3.6). This is the cache half of `issues/2026-10-25-spec-insertion-sort-flips-to-unproven-under-machine-load.md`: once the loaded run stores `unproven`, the quiet run never re-asks.
2. **The key names the constant, not the solver.** `verify_cache_key` (`driver.yo` ~L264) writes `z3=${Z3_VERSION}`, the pinned version. But discovery honours `YO_Z3_PATH` first (`src/verifier/z3.yo` ~L242–L247), which accepts any binary. A verdict from Z3 4.x or a locally built Z3 is therefore stored and served under the 5.1.0 key, and the reverse also happens.

## Fix direction

- Record `(get-info :reason-unknown)` with every `unknown`. Cache an `Unproven` only when the reason is the resource limit (`canceled` under rlimit, `resource limits reached`). Never cache a wall-clock `timeout`; report it as its own outcome (addendum item Z1 in `plans/backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`).
- Key on the resolved binary's own `--version` output, which the harness already prints on its `verify: solver:` line. Bump `VERIFIER_CACHE_EPOCH`.
- Test: a hermetic unit test over `verdict_of_response` and the store predicate (an `unknown` with reason `timeout` is not stored, one with the resource-limit reason is), and a key test showing two `--version` strings give two keys.

## Fix

- **What z3 says.** Measured with the pinned 5.1.0: an `unknown` whose `:rlimit` ran out answers `(:reason-unknown "canceled")`, and so does one whose `:timeout` fired early (`:timeout 1`); a later timer fire answers `"timeout"`. The reason alone cannot separate the two. `(get-info :rlimit)` can: it reports the resource count the query consumed, which reaches the budget only when the rlimit stopped it (`(:rlimit 100043)` under `:rlimit 100000`; `(:rlimit 434547)` under `:rlimit 100000000` with a 50 ms timeout).
- `encode_script` (`src/verifier/encode.yo`) now ends every script with `(get-info :reason-unknown)` and `(get-info :rlimit)`; `z3_reason_unknown_of` / `z3_rlimit_used_of` (`src/verifier/z3.yo`) read the answers, and `z3_unsat_core_of` skips the keyword-led `(:… …)` answers, which are bare atom lists.
- `solver_answer_of_response` (`src/verifier/driver.yo`) is the store predicate: sat and unsat cache; an `unknown` caches only when the consumed count reached the budget and the reason is not `timeout`. `timeout`, or `canceled` with budget left, is reported as `unknown: wall-clock timeout (the N ms backstop fired after rlimit U of B); not cached`. Any other `unknown` (incompleteness, no get-info answers) and every solver error are not stored.
- The key writes `solver=<binary --version>` (`z3_version_of_binary`, probed once per process per binary) instead of `z3=${Z3_VERSION}`; a binary whose `--version` probe fails runs uncached. `VERIFIER_CACHE_EPOCH` is 3.
- Tests (`tests/internal/verifier.test.yo`): `solver_answer_of_response` over the rlimit / timeout / early-`canceled` / incomplete / bare / error transcripts, two `--version` strings giving two keys, the core parser skipping the get-info answers, and the script golden with the two probes.
- Not done here: a separate `timeout` outcome in the JSON summary (addendum Z1's "own outcome") stays with Z1; the reason text carries it for now.
