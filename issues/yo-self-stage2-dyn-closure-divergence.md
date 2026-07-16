# Stage-2 behavioral divergence: s2 fails `dyn(closure)` inside the specialized `analyze_await_points` — the ONLY blocker left for the byte-exact fixpoint

Status: OPEN (root not yet found) — 2026-07-16
Repro (fast, ~1 min): `compile yo-self/evaluator/values/anonymous_function.yo --emit-c`

- s1 (TS-compiled yo-self): emitted C has **0** `dyn() requires an object type` markers
- s2 (self-compiled yo-self): emitted C has the marker at the specialized
  `analyze_await_points` body — BOTH `dyn()` struct-field args fail:
  `__yo_new___yo_tNNN(/* Error: dyn() requires an object type (use box() for value types) */, /* Error: ... */)`
  (also INVALID C — empty ctor args — so a stage3 built from an emit containing
  a REFERENCED instance of this cannot compile)

## How this was found (fixpoint text-diff → one root)

After the two RC-leak fixes (container-dispose + reassign-initialized-token) the
main.yo self-emit completes on 16 GB (10.1 GB peak, ~4 min) and stage2/stage3
sizes differ by only 9.6 KB. Both emits are individually byte-DETERMINISTIC
(re-run → identical), so the diff is a stable s1-vs-s2 behavioral divergence.
Chased it with sequence logs (all reverted after use):

1. `[INTERN]` log in `_intern_type_c_name` (codegen/types/collection.yo): both
   runs intern the SAME 858 type_keys; s1 interns `R#gs_yo_id_2794_3226/3228`
   at #341-342, s2 at #833-834 → the whole ±2 typedef-id cascade.
2. `[REGFN]` log in `register_function` (codegen/utils/index.yo): sequences
   identical EXCEPT s1 registers 2 extra specializations of `yo_id_2799` (a
   generic ctor for gs_yo_id_2794) right after registering
   `closure_yo_id_277110`/`277120` — the capture-struct ctor wrappers for the
   two closures below. s2 never registers them.
3. The call site in stage2 vs stage3: `yo_id_251606_rtparam0_...` (the
   specialized `analyze_await_points`) — s1 builds both dyn-wrapped closures;
   s2 emits the two error comments instead. Error-marker histogram: stage3 has
   EXACTLY +2 `dyn() requires an object type` vs stage2; everything else in the
   194K-line normalized diff is downstream reordering.

## The source site

`yo-self/evaluator/async/await_analysis.yo:393-401`:

```rust
result := analyze_suspension_points(
  body.clone(),
  get_info,
  SuspensionPointDetector(
    detect : dyn((expr, parent_expr, points) => {
      detect_await_expr_(expr, parent_expr, points, await_extras, get_info);
    }),                                              // captures await_extras + get_info
    should_skip_body : dyn((expr) => is_io_async_call(expr))   // empty capture
  )
);
```

`dyn(anon_closure)` must see the closure's `Impl(Fn…)` SomeT carrying
`resolved_concrete = <capture struct>` (the values/dyn.yo carve-out: box the
capture struct). In s2's evaluator that resolution is missing/not visible at
the dyn() eval, so it takes the "value type" error path. s1 and s2 run the SAME
evaluator source — so yo-self CODEGEN miscompiles something in the
closure-creation → `register_some_resolved_concrete` → dyn() read chain
(the "stage-2 self-capture family" class).

Note: only the SPECIALIZED instantiation fails — compiling
`await_analysis.yo` alone (unspecialized/def-time path) is clean in BOTH.
The repro module `anonymous_function.yo` imports and CALLS
`analyze_await_points` (forcing the specialization with concrete rtparams).

## Next steps

1. Probe (needs instrumented s1+s2 rebuild, ~12 min): in values/dyn.yo's
   "requires an object type" error arm, eprintln the arg's type_key, whether it
   is SomeT, and `resolved_concrete` presence; also log
   `register_some_resolved_concrete` calls for the two closures. Diff s1-vs-s2
   probe output on the repro module.
2. Then bisect where the chain breaks in s2: closure creation
   (anonymous-function eval), the resolved-concrete side table
   (register/lookup keying), or specialization-time type substitution dropping
   the resolution (Step-10 re-eval / declared-vs-ExprInfo discard family — see
   memory yo-self-intern-key-somet-wrong-merge: "resolutions get DISCARDED
   downstream — probe both sides").
3. Fix, then re-run the fixpoint: stage2/stage3 should converge to
   ID-normalization-identical (then chase any residue).

Binaries at time of writing: `/tmp/yo-self-fix4` (s1, both RC fixes),
`/tmp/s2_fix4` (s2 from fixed emit), `/tmp/aa_s1.c.c` / `/tmp/af_s2.c.c`
(repro emits). stage2/stage3 pair: `/tmp/stage2_fix4.c.c`,
`/tmp/stage3_fix4.c.c`; intern/REGFN logs: `/tmp/i1.txt`, `/tmp/i2.txt`,
`/tmp/r1.txt`, `/tmp/r2.txt`.
