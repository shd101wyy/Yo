# The leak-verdict vacuity probe re-declares the prelude's `__yo_malloc`, so the job fails before any allowlisted test runs

**Severity:** S3. The failure is in CI only, and it is loud: the job goes red at its first step. Nothing passes vacuously. But while it lasted, the weekly `leak-verdict.yml` job ran none of its allowlisted leak-sensitive tests, so a leak regression in those files would have gone unseen.

**Status:** FIXED 2026-10-17 (PR #1417). Found when PR #1417 dispatched `leak-verdict.yml` on its branch (run 39004893402).

## Symptom

The job's first step, `Vacuity probe (the leak verdict must fail a deliberately leaking test)`, fails with this:

```text
error: Failed to define variable "__yo_malloc":
     --> /home/runner/work/Yo/Yo/std/prelude.yo:9909:1
yo: error: test: /tmp/leak-probe.test.yo — 0 of 1 tests in this batch ran: the batch failed to compile (exit != 0).
##[error]the leaking probe test failed for a reason OTHER than the leak verdict — read the log above
```

The allowlist step is then skipped. The last green run, 38116074837 on 2026-10-11, predates the cause.

## Root cause

The probe embedded in the workflow begins `extern("Yo", __yo_malloc : (fn(size : usize) -> ?*void));`. Since #1328 (2026-10-13, the unique `Box(V)`), `std/prelude.yo` declares the same `extern("Yo", __yo_malloc : …, __yo_free : …)` for the allocator hooks a `Box` cell uses. Every module sees the prelude's bindings, so the probe's `extern` redefines a name that is already bound. The evaluator rejects that.

## Reproducer

The workflow's probe body, as a file:

```yo
pragma(Pragma.AllowUnsafe);
extern("Yo", __yo_malloc : (fn(size : usize) -> ?*void));
{ assert } :: import("std/assert");

test("deliberate leak (the vacuity probe)", {
  p := __yo_malloc(usize(65536));
  ok := match(
    p,
    .Some(_) => true,
    .None => false
  );
  assert(ok, "allocation succeeded");
});
```

`yo check` on it fails with `Failed to define variable "__yo_malloc"`. Without the `extern` line, it reports `evaluator OK`.

## Fix

The probe drops its `extern` line and calls the prelude's `__yo_malloc` directly. A comment above the step records why.

## Test

The probe step is the test: it must fail with `Memory leak detected`. It failed to compile before the fix; the branch's re-dispatch of `leak-verdict.yml` is the after-fix run.
