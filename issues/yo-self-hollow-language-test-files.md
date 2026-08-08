# 3 of 188 language test files are HOLLOW under the self-hosted compiler

**Found 2026-08-08** by the first full-corpus hollow sweep. These files exit 0
and report passing tests while **running no assertions at all**.

## The census (first ever)

`scripts/bootstrap/hollow_sweep69.sh` runs every `tests/**/*.test.yo` except
`tests/internal` through `<bin> test` and scores each file honestly: GREEN
requires exit 0 **and** an emitted batch `__yo_user_main` that is not a
`// Failed to transpile` comment.

```
BIN=<self-hosted binary> OUT=/tmp/hsweep bash scripts/bootstrap/hollow_sweep69.sh
awk '{print $2}' /tmp/hsweep/results.txt | sort | uniq -c
```

| verdict | count |
| ------- | ----- |
| GREEN   | 185   |
| HOLLOW  | **3** |
| RED     | 0     |

```
tests/index.test.yo                      HOLLOW rc=0 hollow=1 markers=1  49 passed
tests/safe_code_structural_gates.test.yo HOLLOW rc=0 hollow=1 markers=1   1 passed
tests/variadic_comptime.test.yo          HOLLOW rc=0 hollow=1 markers=1  10 passed
```

Note the pass counts. `tests/index.test.yo` reports **49 passed** while
executing nothing — a bare "N passed" from the self-hosted runner is not
evidence that anything ran.

## Why this was invisible

CI runs `<bin> test` on only the **23-file** `gates_fast.sh` battery; the other
**165 language files are exercised solely by the TypeScript compiler**. All
three hollow files are outside the battery. `hollow_sweep69.sh` was written
precisely to close this and is wired into no workflow
(`grep -rn hollow_sweep .github/` returns nothing).

This matters for `plans/SELF_HOSTING_COMPLETION.md` **P2**: after `src/` is
retired, the self-hosted binary's "N passed" becomes the only signal there is.

## Shape of the failure

In all three the **entire** test-dispatch `match` degrades to a comment, so the
whole file's body is skipped in one go:

```c
  // Failed to transpile match(((__yo_batch_env.env).get)(("YO_TEST_INDEX".to_string)()),
  //   .Some(__yo_test_idx) => cond((__yo_test_idx == ("0".to_string)()) => begin(...
```

Candidate constructs per file (each file's arms are dominated by one theme):

- `index.test.yo` — Index-trait reads, array/string slicing, `ComptimeList`
- `safe_code_structural_gates.test.yo` — `inout` params; 115 lines with a single
  `test(...)`, the rest module-level `comptime_expect_error(...)` negative cases
- `variadic_comptime.test.yo` — variadic comptime functions

## Do not extract a minimal `main` — it false-passes

Both obvious reductions were tried and **both compile cleanly** under the
self-hosted compiler, proving nothing:

1. `swap(x, y)` with `inout(a) : i32` params in a plain `main` — clean.
2. The same body kept inside a `test(...)` wrapper in a fresh one-test file —
   also clean, `0` markers in the batch `__yo_user_main`.

So the trigger is not `inout` alone, nor the batch wrapper alone. It needs the
surrounding file — most likely the module-level `comptime_expect_error(...)`
declarations interacting with batch generation. Reduce by **deleting arms from
the real file** (keeping the `test(...)` wrapper and the module preamble) rather
than by writing a new small file.

## Gated as a ratchet (done)

The sweep now runs in CI as the `hollow-sweep` job, scored against
`scripts/bootstrap/known-hollow.txt`. It fails in **both** directions: a hollow
file that is not allowlisted fails (so no _new_ hollow file can land), and an
allowlisted file that is no longer hollow also fails (so the list cannot go
stale). `ALLOWLIST=/dev/null` demands a fully-clean sweep. The sweep is
resumable via `$OUT/results.txt`.

That banks the 165-file differential immediately, while these three are worked
down. **Fixing one means deleting its line from the allowlist** — the gate will
tell you to.

## Remaining work

Root-cause and fix the three, then empty the allowlist. Start with
`safe_code_structural_gates.test.yo`: it is the smallest (115 lines, a single
`test(...)`, the rest module-level `comptime_expect_error(...)`), so it has the
fewest confounders — and per the section above, reduce it by deleting arms from
the real file, not by writing a new one.
