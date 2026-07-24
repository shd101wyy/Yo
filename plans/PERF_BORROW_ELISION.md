# Perf: borrow-elision for RC dup/drop pairs (the 55→15 min arc)

_Status: PLANNED 2026-07-25. Prereq reading:
`issues/yo-self-compile-performance-rc-string-eq.md` (profiles, negative
results, why this is THE lever)._

## Problem

The yo-self self-compile spends ~60% of CPU in `__yo_decr_rc` and
~20% in `String ==` — and they are the same traffic: codegen emits a
`__yo_incr_rc`/`__yo_decr_rc` pair around every RC-typed value read
that feeds a call argument, match scrutinee, or method receiver, even
when the callee only BORROWS the value for the duration of the call.
The runtime fast path is already optimal (`static inline`, untracked
short-circuit); the remaining lever is emitting fewer pairs.

## Approach

Teach the emitter that an argument position which (a) reads an
already-owned place (local variable, field of a live local) and (b)
feeds a callee that does not retain the value (pure/borrowing) needs NO
dup before / drop after — the caller's existing ownership covers the
call's duration.

Candidate tiers, safest first:

1. **Borrowing builtins allowlist**: String `==`/`len`/`hash`,
   ArrayList `.len()`/`.get()` receiver — hand-verified non-retaining.
   Gate elision to args that are PLAIN variable reads (no temporaries).
2. **`inout(self)` receivers**: already by-reference semantically;
   audit whether the emitter still dups the receiver handle.
3. **General non-owning params**: any param that is not `own(...)` and
   whose type is RC — requires the callee to be compiled with the same
   convention (callee must dup where it stores). This is the TS
   `param_is_owning` model — verify both emitters agree before eliding.

## Hard constraints

- **Paired change**: `src/codegen` (TS) and `yo-self/codegen` must emit
  IDENTICAL C — the corpus diff-test (`PASS 140 / DIFF 0`) enforces it;
  STRICT_FIXPOINT enforces yo-self self-consistency. Land each tier as
  one commit with the FULL gate battery.
- The dup/drop pair optimizer (`_optimize_dup_drop_pairs`,
  evaluator/exprs/begin.yo + TS begin.ts) already does begin-block-scope
  elision — reuse its ownership analysis; do not fork a second model.
- ASan corpus run (`--sanitize address --allocator libc`) per tier —
  elision bugs are use-after-frees, the most expensive class to chase
  later (see tests run with `./yo-cli compile --sanitize address`).
- Measure per tier: `time <s1> check ./std` (~80s baseline, cheap
  proxy) + one full stage2 emit for the tier that claims victory
  (~60 min baseline @ 2026-07-25, /tmp/r3 chain).

## Expected payoff

Tier 1 alone plausibly cuts 20-30% (the String==/env-lookup traffic);
tiers 2+3 target the bulk of the 60% decr_rc share. Goal: stage2 emit
55-60 min → ~15-20 min, halving every future gate chain.
