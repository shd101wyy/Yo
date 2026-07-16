# Stage-2 behavioral divergence: s2 fails `dyn(closure)` inside the specialized `analyze_await_points` — the ONLY blocker left for the byte-exact fixpoint

Status: **ROOT CAUSE FOUND (2026-07-16 late)** — fix not yet implemented; see
"ROOT CAUSE" section at the bottom. Everything in between is the (accurate)
chase narrative.
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

## CHASED 6 probe-cycles deep (2026-07-16 evening) — current frontier

Probe chain results (each ~13-min s1+s2 rebuild cycle; probes still in the
working tree, all marked TEMP DEBUG — see "Active probes" below):

1. `[DYN]` (codegen generate*dyn_call): at the failing sites s1's recorded
   value expr = tok 15559/15710 with ty=`R#gs_yo_id_2794*\*` (gs 2794 = std
   **Box**); s2's = tok=0 id=0 ty=Type(1).
2. `[DYNIN]` (dyn.yo VALIDATING path, line ~376): both runs identical — the
   closures arrive as vk=funcval ty=`fn(...)` (raw fn type, not ref struct) →
   both take the auto-box branch. The dyn EXECUTING path never fires here.
3. `[BOXED]` (after `ne_boxed := evaluate_expression(ne_box_call)`): the
   computed expected `box_ty` is IDENTICAL in both
   (`R#gs_yo_id_2794_2499/2501/2678/2680`). s1's ne_boxed = the real
   ne_box_call node (`k=fncall:box/1`, ids 1185279/1185292/1454666/1454679)
   with info ty=Box(V) ✓; s2's ne_boxed = `k=atom:?` id=0 tok=0 — a
   make_err_expr() node whose id-0 table slot holds junk `Type(1)`.
4. `[CTORENTER]/[CTORREJ]` (try_to_call_type_with_arguments, gated by
   set_ctor_probe around the box eval): **BOTH runs reject identically** —
   4× `lbl=* exp=<bare SomeT V key> got=<capture struct key>` (the Box ctor's
   `are_types_compatible(capture_struct, V-SomeT)` fails in BOTH runs; NOT the
   divergence).
5. `[SWALLOW]` (top-level `_evaluate_expression_wrapper` throw handler, with
   deepest-active-eval context via g_swallow_tok/id): **both runs swallow the
   SAME 4 "Type mismatch for type member \"\*\"" errors at the SAME deepest
   wrapper (the ne_box_call eval, matching ids)**. make_err_expr caller-site
   histograms are also IDENTICAL (20/1125/4 at the same 3 fns).
6. Interleaving: in s1, SWALLOW(id=X) is followed by BOXED **good** with the
   SAME id X — the throw fired, was absorbed, and the ne_box_call eval still
   COMPLETED with info ty=Box(V) (signature-typed result despite the body
   throw). In s2, the same SWALLOW is followed by BOXED **err** — the unwind
   killed the whole ne_box_call eval.

**CONCLUSION: the divergence is WHICH Exception the ctor-mismatch throw
unwinds to.** The throw and the mismatch are identical; in s1 it unwinds only
an inner trial evaluation (its caller recovers, records the Box(V)-typed info
from the signature and proceeds); in s2 it unwinds the OUTER
evaluate_expression wrapper of ne_box_call itself (err node propagates into
runtime_arg_exprs_in_order → the dyn() object-type error). This is the
**effect/ctl handler threading class** — cf. memory
`yo-self-effect-unwind-part2` ("ctl-handler not marked effect_record_member;
func_id churn defeats side-table") — i.e. yo-self CODEGEN mis-emits the
Exception ctl-record threading somewhere in the box-eval call chain
(evaluate_function_call → body/trial eval → try_to_call_type_with_arguments),
so the throw resolves to the wrong handler frame in the self-compiled binary.

## Next steps

1. Map the exn threading for this chain in the SOURCE: find which intermediate
   creates the trial Exception that s1's throw lands in (candidates: the
   def-time body trial-eval in evaluate*function_call / create_specialized*
   function_inline; the validating-mode callee-body eval). Add a probe that
   tags each Exception with a serial (global counter in std/error? or wrap at
   creation sites) and print which serial the CTORREJ throw uses in s1 vs s2.
2. Then diff the emitted C (stage1 vs stage2) for the function that PASSES the
   exn (the effect-record member load / ctl dispatch) — expect a mis-emitted
   effect-record member or handler-frame capture.
3. Fix, re-run fixpoint, expect stage2/stage3 to converge (all other diffs
   were downstream of these 2 dyn failures).

## Active probes in the working tree (ALL marked TEMP DEBUG — revert before committing fixes)

- `yo-self/codegen/exprs/dyn.yo`: `[DYN]` log + eprintln/ast_expr_token imports
- `yo-self/evaluator/values/dyn.yo`: `[DYNIN]`, `[DYNEX]`, `[BOXED]` logs +
  set_ctor_probe(true/false) around the validating box eval + imports
- `yo-self/evaluator/calls/type.yo`: g_ctor_probe/set_ctor_probe/get_ctor_probe +
  `[CTORENTER]/[CTORREJ*]` logs + imports + exports
- `yo-self/evaluator/exprs/_expr.yo`: `[SWALLOW]` log in the wrapper handler +
  g*swallow_tok/id save-restore + \_get_swallow*\* helpers + get_ctor_probe import

Cycle: `./yo-cli compile yo-self/main.yo --release -o /tmp/s1_dpN` (5min) →
`/tmp/s1_dpN compile yo-self/main.yo --release --emit-c -o /tmp/stage2_dpN.c`
(2min; NOTE `-o` appends `.c`) → `clang -O2 stage2_dpN.c.c -o /tmp/s2_dpN`
(4min) → run BOTH on `yo-self/evaluator/values/anonymous_function.yo --emit-c`
(~1min each) → diff stderr logs. Yo gotchas hit: effect (`->`) handlers cannot
capture outer runtime variables OR module globals — route through module-level
`fn() -> T` getters; `is_type_value` takes Option (match `.TypeVal(_)`
directly); AstExpr.FnCall's func is a direct Self handle (no `.*`).

Binaries at time of writing: `/tmp/yo-self-fix4` (s1, both RC fixes),
`/tmp/s2_fix4` (s2 from fixed emit), `/tmp/aa_s1.c.c` / `/tmp/af_s2.c.c`
(repro emits). stage2/stage3 pair: `/tmp/stage2_fix4.c.c`,
`/tmp/stage3_fix4.c.c`; intern/REGFN logs: `/tmp/i1.txt`, `/tmp/i2.txt`,
`/tmp/r1.txt`, `/tmp/r2.txt`.

## ROOT CAUSE (2026-07-16 late — WRAPIN/WRAPOUT trace + emitted-C comparison)

The WRAPIN/WRAPOUT trace proved that after the identical swallowed throw, **s1
CONTINUES executing past the throw site** (the next nested eval runs; the
ne_box_call wrapper exits NORMALLY with the good node) while **s2 really
unwinds**. The emitted C of `_evaluate_expression_wrapper`'s throw handler
explains it exactly:

TS emit (s1) of `unwind(make_err_expr())`:

```c
__yo_effect_escaped = 1;      // unwind sets the escape flag
__yo_effect_escaped = 0;      // ← make_err_expr()'s PRE-CALL RESET (TS brackets
temp = make_err_expr();       //   EVERY user call) CLOBBERS the unwind flag
if (__yo_effect_escaped) {...}
memcpy(__yo_unwind_value, &temp, ...); return {0};
```

yo-self emit (s2) of the same source:

```c
__yo_effect_escaped = 1;
temp = yo_id_11597();         // NO pre-call reset (yo-self's may-unwind
memcpy(__yo_unwind_value, ...); return {0};   // analysis skips the bracket)
```

So in the REFERENCE compiler, `unwind(<user call>)` in a ctl handler is a
**RESUME** (flag clobbered → the throw site's `if (__yo_effect_escaped)` sees 0
→ execution continues), while `unwind(())`/`unwind(<literal>)` (no call, no
reset) really unwinds. The evaluator's entire def-time trial-eval "swallow and
continue" behavior — including the box(closure) recovery these dyn sites need —
is built on this TS-codegen flag-clobber quirk. yo-self's emission is MORE
faithful to the declared unwind semantics and therefore DIVERGES.

The pre-existing latent bug the resume papers over: the Box ctor's
`are_types_compatible(capture_struct, V-SomeT)` REJECTS in BOTH compilers
([CTORREJ], "Type mismatch for type member \"\*\"") — the resume just lets
evaluation proceed and record the signature-typed Box(V) info anyway.

## The fix (next session)

**Bug-compatible emission parity** (the only option that matches s1 behavior
GLOBALLY): make yo-self's call emission bracket user calls with
`__yo_effect_escaped = 0;` + post-call `if (__yo_effect_escaped)` check exactly
where TS does — at minimum inside `generate_unwind`'s `.Some(arg)` arm (the
TS-parity sequence `escaped=1; escaped=0; call; check; memcpy; return`), and
generally auditing yo-self's may-unwind bracket-skip analysis
(codegen/exprs/other_fn_call.yo `ou_may_unwind`, generation.yo) against TS's
always-bracket policy. Validate: the 1-min repro (s2 emits 0 dyn-error markers
on anonymous_function.yo), then the fixpoint diff.

Also file (separately, fix in BOTH compilers together, later):

1. TS unwind-clobber bug — `unwind(<call>)` resumes instead of unwinding
   (order: set flag before evaluating the argument).
2. Box-ctor compat gap — `are_types_compatible(concrete, unconstrained SomeT
V)` rejects where it should accept (or the box call should bind V before
   the ctor check); currently masked by (1).

## FIXED (2026-07-16 night, commit 546a5a25d) + the residual frontier

The fix: port TS callMayUnwind's atom-callee fallback into `_call_may_unwind`
(yo-self/codegen/exprs/other_fn_call.yo) — a direct call through an atom with a
function type is may-unwind → bracketed → the unwind-resume clobber behavior
now matches the TS-compiled compiler exactly.

Validated (clean tree, all probes reverted):

- repro: s2 dyn-error markers 1 → **0**; the four box(closure) sites produce
  byte-matching good nodes.
- corpus PASS 126 / DIFF 2 (both known pre-existing); check ./std 153/153;
  self-emit clang 0. stage2.c grew 36.7 → 59.1MB (every atom call bracketed —
  TS-shaped). stage3 emit peak RSS 10.1G → **7.4G**.
- **Fixpoint: stage2 vs stage3 normalized diff 194,267 → 184 lines** (raw 817
  bytes), ONE residual pattern: `sizeof` comptime-folding — s1's run folds
  `sizeof(Bucket(K,V))`-style sizes to constants (`24ULL`, `bucket_size`
  inlined) at ~46 std-collection allocation sites during the main.yo compile;
  s2's run leaves them symbolic (`sizeof(__yo_tN)` / runtime `bucket_size`).
  Semantically equivalent C, not byte-exact. Small-file compiles fold
  IDENTICALLY in both (verified) — the divergence needs main.yo context, same
  hunt class as before (an evaluator comptime value present in s1's run,
  Unknown in s2's). Next: locate the sizeof/size_of eval path, probe the
  failing instantiations (e.g. the compiler's own HashMap Bucket types) with
  the established 13-min cycle.

## FIXPOINT REACHED (2026-07-16 night, commit 1017e7ffd)

The sizeof-folding residual root: yo-self dropped module-TOP-LEVEL bare-atom
reassignments (`g_size_of_type_fn = Some(get_size_of_type)` in types/utils.yo)
from the emitted module init — two coupled gaps (collector shape + emitter
name-dedup), both fixed. The self-compiled binary's size/alignment slots were
never wired → every sizeof() fold failed in s2's evaluation.

**stage2.c ≡ stage3.c — RAW BYTE-IDENTICAL, 59,154,253 bytes, no
normalization** — on the 16GB box (stage3 emit peak 9.3GB, ~3 min).
Gates: corpus PASS 126/DIFF 2 (both known pre-existing), check ./std 153/153,
self-emit clang 0. Handoff item (B) is DONE.
