# A `match` arm with a mid-body `return(...)` at an async body's TAIL hangs the state machine

**Found**: 2026-08-28 adding the walk-pattern filter to `std/fs/walker.yo`
(branch `p1/glob-expansion`). **Status**: OPEN — std avoids the shape (the
filter moved into a sync helper called as the tail expression); the shape
itself remains a codegen hazard.

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
