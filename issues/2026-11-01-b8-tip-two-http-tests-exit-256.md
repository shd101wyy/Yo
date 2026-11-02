# Two http tests exit 256 on the B8 branch tip (not on develop)

**Status (B8 owner, 2026-11-01, updated):** SUSPECTED SEED ARTIFACT, triage stood down per the
coordinator: the trace was taken with the installed SEED binary (v0.2.73 codegen, pre-flip)
against the flipped std — a frankenbuild whose ref-counted handling of now-value types is
exactly double-free-shaped. Verify by re-running the two http tests under the first TREE
binary of this branch; reclassify (and only then triage) if the tree run is clean. The class is
codegen-level unwind/task dispose (#1684/#1697 family) exposed by the flip; reproduction and
the fix verdict wait for the probe branch's first tree build (the flip probe gates it). If the
fix turns out to be evaluator/codegen surgery beyond the flip's scope, it splits into its own
PR before B8 merges.

**Severity:** S2 — two `tests/http/http.test.yo` cases fail on the B8 probe
tip (`vbd/b8-arraylist-string-flip-r3`, `9dd7414b2`, 2026-11-01), with and
without develop merged; they pass on develop `cdcd14d3e`. Found by the B11
flip gate (its base is B8's tip), so it blocks nothing of B11's own, but it
WILL block B8's language-suite gate.

## What fails

    yo test tests/http/http.test.yo --std-path ./std --parallel 1 \
      --test-name-pattern "chunk size"
    yo test tests/http/http.test.yo --std-path ./std --parallel 1 \
      --test-name-pattern "unreadable Content-Length"

- `a malformed chunk size is a typed HttpError, not a garbage body` — exit 256,
  no assertion text printed.
- `an unreadable Content-Length is a typed HttpError, not a silent absence` —
  same shape.

Both spawn the throwing `fetch_with` as its own task (`unwind`-only handler)
and assert the task unwinds (`.None`). The neighboring test of the same shape
(`fetch throws Other on a garbage status line`, port 19967) passes.

## Mechanism (ASan, batch binary run directly with `YO_TEST_INDEX=0`)

`AddressSanitizer: attempting double-free` on a 44-byte region, both frees on
thread T1 inside the client task's async teardown:

- first free: `__yo_dyn_release` → `__yo_dispose_dispatch` → `__yo_venum_drop`
  (an enum payload holding a closure value, dropped while the task unwinds);
- second free: `_state_dispose` → `_state_dispose_locals` → the same
  `__yo_venum_drop` chain — the state machine's dispose drops the SAME payload
  again.

I.e. the unwound task's dyn payload is released once by the unwind-driven
dispose and again by `state_dispose_locals` — a dup/drop-pair /
dispose-ordering regression in B8's rounds, not an http-logic change (the
chunk-size parse itself throws correctly; the neighbor test that also throws
and unwinds passes because its payload shape differs).

## Measured (2026-11-01, seed v0.2.73, this box)

| tree | result |
| --- | --- |
| `origin/develop` `cdcd14d3e` | both pass |
| `9dd7414b2` (B8 tip alone) | both fail, exit 256 |
| B8 tip + develop merge `b49562c0b` | both fail, exit 256 |
| B11 flip on that merge | same two fail, no additional failures (53/55) |

So the regression is B8's own (somewhere in rounds 11–13 or their earlier
async/dispose/dup-drop work), not the merge and not B11's std flip.

## Reproducer

The existing tests above ARE the repro (no new fixture needed): they pass
before B8's regression window and fail on the tip. Minimal isolation: run the
first pattern on the three trees in the table.

## Ownership

B8's agent (their branch, their gate). Filed from the B11 flip so the
coordinator can route it; when B8's fix lands, this doc moves to `fixed/`
with the fixing PR referenced here.
