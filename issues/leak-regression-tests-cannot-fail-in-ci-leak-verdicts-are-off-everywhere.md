# Leak regression tests cannot fail in CI — every job sets `YO_TEST_LEAK_VERDICT: "0"`

**Found**: 2026-09-05, verifying PR #409's fix
(`issues/fixed/short-circuit-bare-fn-body-operand-temps-leak.md`).
**Status**: OPEN. **Severity: hollow gate** — the same class as
`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`: not a
wrong answer, an ABSENT one, over the whole RC/leak surface.

## The measurement

`tests/internal/short_circuit_drops.test.yo` was added by #409 as the
regression net for a leak of 4 allocations per call. Run it against the
compiler that HAS the bug (`yo` 0.2.24, which predates #409 — the fix merged
2026-09-04 20:38 UTC, the tag is 16:18 UTC):

```
$ yo test ./tests/internal/short_circuit_drops.test.yo --parallel 1
  ✓ whole-body || drops its literal temps (leak regression)
  ✓ whole-body && drops its literal temps and short-circuits
  ✓ statement-position || keeps parity with the whole-body shape
3 passed
```

All three pass. They assert only VALUES, and short-circuit values were never
wrong — the leak was the defect. The file's own header says *"Under the shard's
LeakSanitizer build these leak-aborted before the fix"*, and #409's commit
message says *"Verified fail-before (the two whole-body tests leak-abort under
the develop-codegen control binary)"*. Neither is reachable as CI is configured.

## Why it cannot fail

**1. CI turns leak verdicts off in every job that could apply one.**

```
$ grep -n 'YO_TEST_LEAK_VERDICT' .github/workflows/test.yml
350:      YO_TEST_LEAK_VERDICT: "0"     # test
861:      YO_TEST_LEAK_VERDICT: "0"     # test-native
1271:          YO_TEST_LEAK_VERDICT: "0"
1403:          YO_TEST_LEAK_VERDICT: "0"   # tests/internal differential shard
1662:          YO_TEST_LEAK_VERDICT: "0"
1900:          YO_TEST_LEAK_VERDICT: "0"
```

`src/main.yo:2882` turns that straight into `detect_leaks=0`:

```rust
leak_verdict := match(
  proc_env.get(`YO_TEST_LEAK_VERDICT`),
  .Some(lv) => (lv != "0"),
  .None => true
);
...
_sv_asan := proc_env.set(String.from("ASAN_OPTIONS"),
  if(leak_verdict, String.from("detect_leaks=1"), String.from("detect_leaks=0")));
```

The only two suite runs that do NOT set it are the wasm32 legs, and
`use_asan` excludes `emcc`/WASI explicitly — so they could not apply a verdict
either. **No CI job applies a leak verdict.**

The flag is a deliberate staging ratchet for pre-existing self-hosted-emit leak
debt (`issues/self-hosted-emit-leaks-remaining-classes.md`) and the comments
say so. The problem is not the ratchet — it is that a leak REGRESSION TEST was
written as if the ratchet were not there.

**2. On macOS, `--sanitize address` does not instrument at all.**

```
$ yo compile probe.yo --sanitize address --allocator system --optimize 2 -o probe
$ nm probe | grep -c __asan
0
```

Zero ASan symbols. So a developer cannot get the verdict locally either.

## What DOES work locally

macOS `leaks --atExit` measures it exactly, with no sanitizer:

```
$ leaks --atExit -- ./whole_body_or_probe     # 1000 calls
Process: 4000 leaks for 128000 total leaked bytes     # pre-#409
Process: 0 leaks for 0 total leaked bytes             # post-#409
```

That is how #409's fix was independently confirmed (per-shape table in the
verification: two-operand `||` 4/call → 0, `&&` 2/call → 0, `||` in a match arm
4/call → 0, chains halved 6→2 and 8→4).

## Fix

Two independent things, both needed:

1. **Give leak regression tests a gate that works under the ratchet.** The
   assertion "this construct emits its drops" does not need a leak verdict — it
   is an EMIT-SHAPE property. A `tests/cli-cases/` golden that compiles a
   whole-body `||` with `--emit-c --skip-c-compiler` and matches the two
   `__yo_decr_rc` lines would fail the moment the drops disappear, on every
   platform, with the ratchet on. That is the shape this class of fix should
   use from now on.
2. **Make the hollowness visible.** A test whose only failure mode is a leak
   verdict should say so and be SKIPPED (not silently passed) when
   `YO_TEST_LEAK_VERDICT=0` — otherwise "3 passed" is a lie about coverage.
   Alternatively add one narrow CI leg that runs a small allowlisted set of
   leak-sensitive tests with `detect_leaks=1`, so the ratchet stays for the
   compiler-sized batches and real leak tests still have a gate.

Until then, treat every leak-shaped regression test in `tests/` as unverified
and re-measure with `leaks --atExit` before trusting it.
