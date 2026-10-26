# The explicit-copy migration's insertions break B4's corpus C-identity gate

*Filed 2026-10-25 by B4-2 (VBD v0.2.71 campaign).*


## What was observed

The B4 gate ("compile a fixed corpus to C with the base and head stage-1 binaries, under one
pinned std, and require byte-identical C", `plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.1)
cannot be met by the PR it gates. On develop `fb43ea19b`, applying ONLY the 53 insertions of
`yo fix src/codegen --migrate explicit-copy` (no hand edits at all) and rebuilding, the head
binary's `src/main.yo --emit-c --skip-c-compiler` output differs from the base binary's by
~9,967 lines out of 2,017,502:

- `typedef struct …` **forward declarations are reordered** (the first divergence is at line
  1656, in the prelude region);
- **match label counters shift** (`__yo_m6325022…` in base vs `__yo_m6324523…` in head, a
  −499 offset at the first observed site): fewer labels are minted on the head run, which is
  consistent with comptime memoization hits reusing results instead of re-minting names.

A sort-normalized comparison shows only these two shapes: no semantic construct changes, and
the 21 corpus TEST files (`rc`, `rc_cell`, `async_await`, `type_soundness`, `tests/string/*`,
`tests/closure*`, `array_list`, `hash_map`, `global_lend`, …) are byte-identical base vs head.
The mechanism: each inserted `.clone()` resolves the `Clone` impl and evaluates argument
expressions at its position, perturbing the order in which types and impls are registered and
the comptime caches are hit — the emitted declaration order and generated-name counters follow.

The same property holds for B1's merged insertions (develop's own self-C shifted when they
landed); nothing gated it there either.

## The hand-edit classes are a different, real hazard

While isolating the above, two NON-noise regressions from hand-edited conversions were
observed and their edits reverted (the final B4-2 tree is insertions-only):

1. **A miscompile.** With structural edits (mem `replace`/`swap` save-restores and local
   borrows of analysis fields in `exprs/async.yo` / `async/state_machine.yo`), the head
   binary's emitted `main.c` referenced `sm->var___closure_param_0` in a state machine's
   `set_effect` while the same struct declared `__yo_param_0` — invalid C. Two readers of the
   cross-boundary result disagreed about the closure parameter's slot classification, the
   known "a second `compute_cross_boundary_variables` call that skips a filter" bug class.
2. **An ICE.** With `.clone()` hand edits in the async lowering's argument paths
   (`exprs/async.yo`, `async/state_machine.yo`, `exprs/await.yo`,
   `exprs/other_fn_call.yo`, `exprs/generation.yo`, `functions/generation.yo`),
   `E1301: the single-pass async lowering emitted await 653661 twice` — cloning
   `runtime_arg_exprs_in_order` / `FnCall` args lists breaks the once-only await emission
   contract's expression identity.

## Verdict

- The gate's byte-identity bar cannot hold for `src/main.yo` once ANY insertion lands in the
  compiler source. It needs either an order-insensitive comparison (e.g. sorted-line diff plus
  a generated-name normalization), or an explicit exemption of the self-compilation noise
  classes (typedef order, `__yo_m<N>` counters), or the corpus restricted to the test files
  (which ARE byte-identical). This decision is the maintainer's; it affects every remaining
  B4 directory PR (the evaluator's 385+ insertions have the same property).
- The deferred-site hand edits in `src/codegen` (the save/restore snapshots, the no-Clone
  payload extractions, the arm-bound copies) must be converted in SMALL steps behind an
  emit-diff that is compared base-vs-head per step — a one-shot directory conversion cannot
  distinguish the noise classes from real regressions, and two of the classes above are real.


## Recommendation

Amend the B4 gate (VBD_LOOKAHEAD §4.1, "Behaviour"): keep byte-identity for the 21 corpus
TEST files, and for `src/main.yo` compare base-vs-head after normalizing the two proven-benign
noise classes (sorting the forward-declaration block; normalizing `__yo_m<N>` and
`_u<N>`-style generated counters). Land the normalizer as a small script beside
`scripts/cli-diff-test.sh` so every B4 directory PR uses the same verdict. Separately, do the
`src/codegen` hand-edit half of B4-2 as a follow-up PR converted in ≤10-site steps, each step
gated by the normalized emit-diff — the miscompile and ICE classes observed here show a
one-shot directory conversion cannot be reviewed against a byte-identity bar.
