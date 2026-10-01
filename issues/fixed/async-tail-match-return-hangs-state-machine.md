# A `match` arm with a mid-body `return(...)` at an async body's TAIL hangs the state machine

**Severity:** S1 — a mid-body `return` in a tail match makes the state machine hang forever at runtime, even off the arm

**Found**: 2026-08-28 adding the walk-pattern filter to `std/fs/walker.yo`
(branch `p1/glob-expansion`). **Status**: FIXED by the single-pass lowering
(#1002/#1018, phase 5, which deleted the segment lowering this hung under).
Verified 2026-10-01 with the original recipe; see the last section.

## Shape

At the very END of a large `io.async` body (walk_with's — a while loop with
awaits above), this tail:

```rust
match(
  options.pattern,
  .Some(pat) => {
    kept := ArrayList(WalkEntry).new();
    // ... plain sync loop over `results` ...
    return(kept);          // resume-with-value, the unix.yo mid-body style
  },
  .None => ()
);
results                     // tail expression for the None path
```

compiled clean but the produced state machine HANGS AT RUNTIME — even a walk
that never takes the `.Some` arm (pattern `.None`) spins forever (`rc=124`
under `timeout`, on the FIRST plain-walk call). Reverting to a single tail
expression (`_filter_by_pattern(results, root_s, options.pattern)`, a sync
call) fixes it with identical semantics.

## Notes for the fix

- The mid-body `return(...)` inside cond/match arms is a supported, widely
  used shape (std/net/unix.yo). The differentiator here is the position —
  the LAST statement group of the async body, after the awaiting while loop,
  with the real tail expression following the match. Likely the completion
  segment / final-state splitter mishandles a returning arm in the tail
  segment (sibling territory to C25's effectively-unit tail handling and the
  cond-branch dispatch machinery).
- Repro recipe: take walk_with as of commit a39ab3777's parent, append the
  match/return tail above, run any walk. A minimal standalone repro was not
  distilled (the walker body is large); distilling one is the first step of
  the fix.

## Re-verified 2026-09-28 (async state-machine audit)

Tree build of develop `af62bdb28`, and the v0.2.45 seed unless noted. See `plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.3.

**CANNOT REPRODUCE** (seed and tree build). Two reconstructions (an awaiting `while`, then a tail `match` with `.Some => { …; return(kept) }`, then `results`) print the right lengths with no hang. `_emit_last_segment_completion`'s tail-only return check (issues/fixed/build-smoke-hangs-registry-perturbation.md) probably covers it.

## Re-verified 2026-09-29 (async state-machine plan phase 5)

The segment lowering this was observed under is deleted: an `io.async` body
is now emitted once, through the ordinary expression generators
(`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5). A reconstructed minimal
shape passes both on the v0.2.45 seed and on the single-pass lowering, so
there is still no reproducer. Left open until one is distilled from a real
failure; if you meet it again, file the reproducer rather than rewriting
around it.

## Verified fixed 2026-10-01 (v0.2.47 seed, the single-pass lowering)

**Measured**, using the doc's own recipe: a copy of develop's std with the
original tail put back into `walk_with`. The tail is the `match` on
`options.pattern` whose `.Some` arm filters and does `return(kept)`, with
`results` after it.
- **Without it:** a plain walk hung on its first call (`rc=124`).
- **With it now:** `tests/fs/walker.test.yo` passes 8/8 with no hang, plain walks and glob walks alike.

The regression test is `tests/async/sm_shapes_4.test.yo`'s
`shape tail_match_return`, which runs both arms with a yielding and a
synchronous inner future against the same body written synchronously. It
passes.

std keeps the filter in a sync helper (`_filter_by_pattern`), which is
plain structure, not a workaround. Its comment no longer blames a hang.
