# yo-self: evaluating a fresh `___dup` expr inside a macro-generated body's def-time eval corrupts the enclosing module evaluation

**Status:** SIDESTEPPED for Stage 0 (fix direction 2 below implemented —
the marker now SYNTHESIZES the dup instead of evaluating it, and the
deferred-dup emitter declare-assigns a synthesized dup's result temp via
the get_variable_type_string choke-point). The underlying evaluator
fragility — a nested `evaluate_expression_raw` inside a derive-generated
body's def-time eval corrupting the module evaluation — REMAINS OPEN and
unowned by any current caller: the own-param marker
(`set_expr_as_needs_to_call_dup`) still evaluates, but never fires inside
derive-generated bodies today. Root-cause before adding any new nested
eval to arg-processing paths. (An `auto-generated://` token skip was
tried first and does NOT work: derive-generated bodies carry quote-
template tokens from the macro's defining file, not auto-generated
ones.)

## Symptom

With aliasing Stage 0's borrow-projection marker active in yo-self,
compiling this shape under the self-hosted binary fails:

```rust
Tok :: ref(struct(value : String));
derive(Tok, Eq(Tok));
impl(Tok, Clone(clone : (fn(inout(self) : Self) -> Self)(self)));
// error: Variable "Tok" not found   ← at the impl's `Tok` argument
```

The original presentation was the stage-2 self-emit failing on
`yo-self/token.yo` (`derive(Token, Eq(Token))` followed by
`impl(Token, Clone(...))`) — FIXPOINT_BROKEN with STAGE2_RC=1.

## Bisection (all on the tok_i minimal repro, one stage-1 build per step)

- Marker neutered before the dup evaluation → PASSES.
- Dup evaluation only (post-steps skipped) → FAILS.
- Dup evaluation under a local logging exception → **no throw observed**,
  still fails.
- The env-replacement step (`ei.env = dup_ei.env`) was removed first on the
  statement-flow-leak theory — necessary hygiene (yo-self threads env
  through statement infos where TS's dup env is same-stack) but NOT the
  vector.

So: a **successful** `evaluate_expression_raw(___dup(temp), ei.env, ...)`
run from inside the def-time evaluation of a derive-generated `==` body
(String projections `lhs.value == rhs.value` trigger the Stage-0 marker
there) corrupts state that the module evaluation still depends on — the
next module statement's type lookup misses a binding that exists. No
error is thrown or swallowed (`YO_DEBUG_SWALLOW` silent, swallow-pattern
diff between failing/passing variants empty).

Candidate mechanisms (unproven): the `(temp.___dup)()` method-dispatch
route specializing `String.___dup` mid-derive and touching shared
ctx/registry state the expansion machinery still holds; or the recorded
snapshot env's frame list being mutated by the nested eval in a way the
module statement flow observes. The own-param marker
(`set_expr_as_needs_to_call_dup`) does the same nested eval but never
fires inside derive-generated bodies (no own-params there), so this was
latent until Stage 0.

## Workaround (landed with Stage 0)

`set_expr_as_needs_to_call_dup_for_borrowed_projection` skips call sites
whose token `module_path` starts with `auto-generated://` (the same
discipline as the M3 early-return-drop walk). Parity gap vs TS: yo-self
emissions of macro-generated bodies do not carry Stage-0 projection dups
(each compiler's emission is self-consistent; the corpus diff-test judges
run behavior).

## Real fix directions

1. Root-cause the shared-state mutation: instrument what the \_\_\_dup
   method-dispatch specialization touches (ctx fields, registries,
   g_frame_indexes) during a derive body's def-time eval.
2. Or make the marker synthesize the dup WITHOUT a nested
   `evaluate_expression_raw` (build the evaluated form directly — the dup
   of a known temp needs no general evaluation).
3. Relates to plans/backlog/YO_SELF_ENV_SHARING.md (def-time body envs
   COPY what TS SHARES) — the structural fix likely falls out of that
   work.
