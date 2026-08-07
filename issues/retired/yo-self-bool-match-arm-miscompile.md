# OPEN: bool-valued `match` with trait-call arms miscompiles under the self-hosted codegen

> **RETIRED — verified moot 2026-08-07.** The doc's own step 3 ran: the
> compact `found = match(..., .Some(e) => (e == s), .None => false)` form
> was RESTORED at the two canary sites carrying the miscompile comment
> (`types/type_key.yo` `_tk_seen`, `types/intern.yo` `_contains`) and the
> stage-2/stage-3 fixpoint HOLDS (stage-2 emit 0 hollow, clang clean).
> The r3-era divergence was fixed by intervening work — no single fixing
> commit is identifiable (candidates: the branch-aware dup/drop
> cancellation `ac85f6cfc`, the 2026-08-05/06 fix batch). The
> `_shell_walk_visited` / `_tts_seen` statement-arm helpers keep their
> historical shape (it predates the bug and is equivalent).

**Status:** OPEN — worked around; needs a minimal repro + fix in yo-self codegen.

## Evidence

During the memory-churn campaign (2026-08-04), four "seen/contains" helpers
(`_tk_seen` in `types/type_key.yo`, `_shell_walk_visited` in
`types/creators.yo`, `_tts_seen` in `types/string.yo`, `_contains` in
`types/intern.yo`) were rewritten from the clone-heavy form to:

```rust
found = match(xs.get(i),.Some(e) => (e == s),.None => false);
```

Under the TS-built stage-1 binary everything was green (gates_fast battery,
corpus 155/155, `check ./std` 153/153). But the **stage-2 ≡ stage-3 fixpoint
BROKE**: stage-3 grew by ~155 KB with different `__yo_tN` type numbering from
line 356 onward — the signature of the intern/type_key dedup helpers
MISBEHAVING inside the stage-2 (self-compiled) binary, i.e. the self-hosted
codegen miscompiles this expression shape while the TS codegen compiles it
correctly.

Suspect ingredients (known-bug family): a bool-valued `match` whose `.Some`
arm is a bare trait-call comparison (`e == s`, String Eq dispatch) and whose
`.None` arm is a trivial literal — compare the "branch-merge trivial-arm"
and "`||`-LHS trait-call" issues already on file.

## Workaround (in tree)

All four helpers use the statement-arm shape that `_id_already_visited`
(types/utils.yo) has always used and that the fixpoint has validated for
weeks:

```rust
match(
  xs.get(i),
  .Some(e) => if(e == s, {
    found = true;
  }),
  .None => ()
);
```

## Next steps

1. Minimal repro: a ref-enum/Option match assigning a bool from a `.Some`
   arm containing a String `==`, compiled by the stage-1 binary vs TS, then
   through stage-2 — differential the emitted C for the helper.
2. Fix the yo-self codegen arm-lowering (likely the arm-value materialization
   or the trivial-arm branch-merge path).
3. Restore the compact form in the four helpers (optional — the statement
   shape is equivalent and allocation-free too).
