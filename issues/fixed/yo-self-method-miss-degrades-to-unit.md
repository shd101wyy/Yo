# Method-resolution misses degrade to `unit` silently — the swallow class that survives the fatal trial handler

**Status: FIXED (2026-08-13, same day).** The valueless-callee gate in
`evaluate_function_call` (yo-self/evaluator/calls/function.yo, the
no-method `.None` arm) now throws TS's "No matching call found with
arguments" (function.ts:1827 parity) when the callee is not
function-shaped. Function types, SomeTs, Fn-trait carriers, Type-hierarchy
types, and closure CAPTURE STRUCTS (`capture_<id>`) keep the degrade path —
those are the legitimate valueless callees. The throw is additionally scoped
off the overload-CHECKING phase and deferred-generic trials (both are silent
thin-env channels where the degrade is load-bearing; TS discards dg-trial
errors wholesale anyway, function-type.ts:112).

Two hard-won scoping lessons, both `[vcall-throw]`-probe-pinned:
the first gate shape regressed `tests/iterator_combinators.test.yo` because
the prelude map adapter's `(self._f)(item)` callee is typed as its closure
capture struct — the throw fired inside a SILENT closure-spec channel (no
`[swallow]` print anywhere) and the aborted eval leaked a `Type(1)` stamp
downstream. Zero printed swallows does NOT mean zero throws: nested silent
exns (closure coercions, candidate dry-runs, rte/pte re-evals) absorb before
any printing handler sees them. An intermediate gate shape also tripped a TS
codegen bug (`issues/ts-codegen-undeclared-temp-in-short-circuit-option-drop.md`).

Pinned by `tests/cli-cases/compile-undefined-method` (rc=1 under both
compilers; was rc=0 + hollow binary under yo-self). Battery: sweep 188/188 +
SWEEP_GATE_OK, FIXPOINT_HOLDS, `check ./std` 154/154, `check ./yo-self`
247/247, self-compile 3607 trials / 0 swallows / 0 FTT, 10 canaries green,
all three undefined-call/method differential cases PASS.

Found 2026-08-13 while validating the def-eval swallow
campaign's endgame (`issues/fixed/def-eval-swallow-remaining-roots.md`): the
first negative probe for the fatal trial handler turned out not to swallow at
all — it never throws.

## Symptom

```rust
bad :: (fn() -> i32)({
  x := i32(1);
  x.definitely_not_a_method()
});
export(bad);
main :: (fn() -> unit)(());
export(main);
```

Reproducer: `issues/repros/method-miss-degrades-to-unit.yo`.

| compiler                          | result                                 |
| --------------------------------- | -------------------------------------- |
| TS (`./yo-cli compile`)           | **rc=1** — error at the call           |
| yo-self (fatal-handler tip, hs21) | **rc=0**, full compile, binary emitted |

The emitted C carries one `// Failed to transpile` comment for the call — a
hollow method call in a shipped binary.

## Why the campaign's fatal handler does not catch it

The def-eval swallow campaign made definition-time trial ERRORS fatal on the
concrete path (TS parity, function-type.ts:499). But this class **never
throws**: `_try_find_receiver_method` returns zero hits (`[rm-miss]`), the
call falls through to `[call-none]`, and the node is stamped `unit` — a
"successful" evaluation with garbage type. Same at specialization time, so
neither the trial re-raise nor the specialization eval rejects it. The
2026-08-12 marker-fatal backstop only fires for a marker reaching `main`;
`bad` is exported but not called from `main`, so codegen tolerates the marker.

This degrade is also what turned `.key`/`.clone` into `unit` inside the
hash_map:714 dig (there the miss was CAUSED upstream by a wrong dispatch; here
the miss itself is primary).

## What TS does

TS's property-access / call resolution throws when a method cannot be
resolved on a concrete receiver type (that is what makes the reference
rc=1). yo-self's soft fallback exists because generic-receiver trials
legitimately miss (the receiver's methods only exist after specialization) —
but the fallback fires for CONCRETE receivers too.

## Sizing / next steps (not started)

- Measure: count `[rm-miss]`/`[call-none]` (YO_DEBUG_CTFE/DISPATCH hooks are
  in-tree) over std + tests split by receiver concreteness and trial context.
  Only misses on CONCRETE receivers outside deferred-generic trials are
  candidates for a throw.
- The likely fix shape mirrors the campaign: make the miss throw where TS
  throws; the deferred-generic trial's catch (TS function-type.ts:112 parity)
  absorbs the legitimate generic-receiver misses.
- Related wider surface: the "~220 type-level swallow classes" note in
  `issues/fixed/self-hosted-compile-swallows-undefined-call.md` and the
  historical category inventory in
  `issues/retired/def-time-body-eval-swallow-surface.md` (its trial-swallow
  mechanism is closed; per-node degrades like this one are what remain).
- A cli-case (`compile-undefined-method`) should pin the fix the way
  `compile-undefined-call`/`compile-undefined-call-unreferenced` pin the
  throw-based classes. Do NOT add it before the fix — it would score
  SELF-FAIL (TS rc=1, self rc=0).
