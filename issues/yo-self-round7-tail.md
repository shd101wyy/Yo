# yo-self round-7 tail — the 10 remaining #70 divergents (signatures)

Scoreboard: 51/61 green (plans/YO_SELF_STAGE2_HANDOFF.md). Logs in
/tmp/s2_sweep_yoself_r7\*/. The 10 files and their C-level signatures:

## Family A (4 files, ONE cause): fn-returning-fn C type render

`phase6_verify`, `phase6c_macro`, `phase6d_reflection`,
`phase6f_macro_helpers`:

```
error: expected parameter declarator            (col ~4206 of a giant decl)
error: function cannot return function type '__yo_t56 **(__yo_t52 **, size_t)'
```

A higher-order function type (fn returning fn) is emitted as a direct C
function-return-function declaration instead of a pointer/typedef form.
Fix locus: get_type_string's Func arm (or the declaration emitter) — the
inner fn type needs `(*)`-wrapping / a typedef when in return position.
TS compare: emit the same test under TS and diff the declaration.

## lexer.test.yo: typeid redefinition

```
error: redefinition of '__yo_typeid___yo_t35'
error: field designator 'value' does not refer to any field ...
```

Two distinct types interned onto one C name emit duplicate `__yo_typeid_*`
definitions AND a field-layout mismatch — the type-identity/intern-dedup
family (same root as the g_stable_to_key work; the alias machinery dedups
type_key collisions but something re-registers the same c-name with a
different layout).

## The rest (untriaged beyond one line)

- `cache.test.yo` — `use of undeclared identifier '_file____User_temp_NNNN'`
  (a temp declared in one arm referenced in another / declaration dropped).
- `effect_analysis.test.yo` — `use of undeclared identifier
'effect_parameter_name'` (an evidence/effect param not threaded into a
  nested fn).
- `suspension_analysis`, `evaluator_index`, `install_command` — rc=1,
  signatures not yet extracted (use YO_KEEP_BATCH=1 with the canonical s2).

All are batch-shape findable: `YO_KEEP_BATCH=1 /tmp/s2 test <file>` keeps
the synthesized .yo/.c for inspection (ff97e1ffc).

## effect_analysis ROOT ANALYSIS (2026-07-18, batch captured)

`__yo_traverse___yo_t169` (EffectHandlerInfo) walks
`obj->effect_parameter_name.tag / .data.Some.value` — an OPTION walk — while
the emitted `struct __yo_t169_struct` declares that field as `__yo_t10`
(String). Both the decl emitter and the traversal generator consume the
SAME registry entry (`entry.ty` — constructors.yo:354-365), so the split
means: entry.ty's field IS an Option-typed rendition (the evolved copy)
while `get_type_string(field.ty)` mapped it to t10/String via a type_key
ALIAS. PRIME SUSPECT: a FALSE MERGE in the stable-identity dedup
(`g_stable_to_key` / `stable_type_identity`) — if an Option instance's
stable render collides with String's (both enum-backed; check the
`g_sti_visited` cycle-guard rendering both to the same cut string), the
second arrival aliases onto the first's C name and every consumer that
walks the VALUE (the traversal, the field designators) diverges from every
consumer that renders via the KEY (the decl).

VERIFY FIRST: dump `stable_type_identity` for the two types in a probe
build (the batch is kept: yo-self/tests/.yo_selftest_batch_1.{yo,c} at this
commit's HEAD state; sources of the field: EffectHandlerInfo in
yo-self/evaluator/effects/effect_analysis_types.yo:88/114 — declared
`effect_parameter_name : String`, so the Option-fielded entry.ty rendition
is itself an artifact worth tracing).

If the false-merge confirms, the alias must require FULL structural
equality (variant names + labels included) rather than the depth-cut
render — or key the stable render with variant names uncut. NOTE this
implicates the 2026-07-18 alias-recursion change's PREMISE ("same type,
evolved render") — an alias between genuinely different types is the
failure mode to rule out for cache.test.yo's undeclared-temp too.

## effect_analysis RESOLVED ANALYSIS (2026-07-18, final)

The "false merge" suspicion was WRONG — retract it. `String` IS
`newtype(_bytes : Option(ArrayList(u8)))` (std/string/string.yo:19), so the
GC traverse walking a String field as an Option is CORRECT BY DESIGN, and
the old "field designator 'value'" error was the (already fixed,
ecdee47db) create_option_type label bug.

The CURRENT effect_analysis failure is a MISSING CLOSURE CAPTURE:

```c
static inline void closure_yo_id_241719(void* closure_context, ...) {
  __yo_t129* effect_extras = ((__yo_t315*)closure_context)->effect_extras;
  __yo_t10 _t = yo_id_4570((&(effect_parameter_name)));   // ← never captured
```

The closure's capture struct carries ONLY `effect_extras`; the body also
references outer `effect_parameter_name`, `effect_field_path`, and
`include_transitive_calls` — all emitted as bare undeclared identifiers.
Fix locus: the capture ANALYSIS (evaluator anonymous-function capture
collection) missing these under the batch shape — find which yo-self
source closure this is (a lambda in evaluator/effects/effect_analysis.yo
taking (expr, parent_expr, points)), then diff TS's capturedVariables for
the same lambda. cache.test.yo's "undeclared \_file\_\_\_\_User_temp_NNNN" is
plausibly the same capture-miss class (a temp belonging to the outer fn
referenced from a closure body).

### effect_analysis capture-miss — narrowed (repro-negative note)

The three uncaptured variables are all PARAMETERS of the enclosing
`analyze_effect_call_points` (effect*analysis.yo:781-817); the LOCAL
`effect_extras` was captured. But a minimal param-in-dyn-closure repro
(param used only inside a `dyn((x) => ...)` stored in a struct field) is
GREEN under s1 — the miss needs more of the real shape. Distinguishing
candidates to add one at a time: (a) the captured params are passed as
CALL ARGUMENTS (`detect_effect_expr*(…, effect_parameter_name.clone(), …)`)
rather than used in expressions; (b) an `Impl(Fn(...))` evidence-ish param
(`get_info`) is also captured; (c) the closure sits alongside a second
`dyn` field (`should_skip_body`); (d) the enclosing fn returns a struct
that flows through `analyze_suspension_points`. The real lambda is
closure_yo_id_241719 in the effect_analysis batch (keep with
YO_KEEP_BATCH=1).

### CAPTURE-MISS REPRO CAPTURED (45 lines, deterministic)

`issues/repros/dyn-closure-implfn-capture-loss.yo` — a dyn closure whose
captures include an `Impl(Fn(...))` PARAM of the enclosing fn loses its
OTHER captured params:

```
error: use of undeclared identifier 'name'
error: use of undeclared identifier 'flag'
```

Remove the `probe : Impl(Fn(v : i32) -> i32)` param (and its use) and the
same program is green — the Impl(Fn) capture flips the closure onto the
DEFERRED-generic path (anonymous*function.yo:1128 "a deferred generic
closure has none → empty struct"), and the call-site specialization that
later evaluates the body does not rebuild/attach the capture struct with
the params it references. The recorder itself is
identifer_and_operator.yo:203-227 (`variable.frame_level <
closure_frame_level` gate) — check what frame_level the enclosing fn's
params carry inside the SPEC re-eval env (create_specialized_function*
inline builds a fresh env; the params likely land at >= the closure's
frame count and are never tracked).

Fix expectation: TS's soft-generic closure path (helper.ts:1911-1929 +
closure-type.ts) records the concrete capture struct at the call-site
specialization — mirror that: after the spec body eval, feed the
spec-eval's captured_variables through enrich_captured_variables +
create_capture_type_and_value and register the closure capture info for
the SPEC fid (the same post-eval sequence the non-deferred path runs at
anonymous_function.yo:1140-1162).

This class covers effect_analysis and plausibly cache (undeclared temp) —
2 of #70's remaining 4.

### Capture-loss fix design (final analysis — implement next session)

`create_specialized_function_inline` (calls/helper.yo:1326) CLEARS
`ctx.captured_variables` around the spec body eval (correct for regular
fns, per its comment). For a DEFERRED closure this must instead:

1. Set a FRESH capture map (detect: the original fid has
   closure-capture info / `is_closure_fn`), so the spec body eval records
   the closure's real captures via the identifer_and_operator.yo tracker.
2. Post-eval, run the anonymous_function.yo:1140-1162 sequence
   (enrich_captured_variables → generate_captured_variable_dup_expressions
   → create_capture_type_and_value → register_closure_capture_info) for
   the SPECIALIZED fid.
3. BILATERAL: the closure CREATION site's capture-struct VALUE emission
   reads the def-time `ExprInfo.capture_type` (empty for deferred) — the
   creation-site info must be updated to the spec-time capture struct too
   (or codegen's closure-creation resolves capture info by the spec fid).
   Without (3), the fn side reads `__capture->name` while the creation
   site builds an empty struct.

Repro gate: issues/repros/dyn-closure-implfn-capture-loss.yo (s1 compile;
currently rc=1 with "undeclared identifier 'name'/'flag'"). TS mirror:
helper.ts:1911-1929 + closure-type.ts (records the concrete capture struct
at specialization; TS creation sites resolve through the SomeType's
resolvedConcreteType so both sides agree).

### Capture-loss — DEFINITIVE localization (tracker gate, not enrichment)

Relaxing enrich_captured_variables' `fl < n_frames` drop did NOT fix the
repro (reverted) — the params are dropped EARLIER, at the tracking gate:
`identifer_and_operator.yo:216` `variable.frame_level <
closure_frame_level` compares the variable's frame_level (stamped in the
env generation where the ENCLOSING fn was CALLED — deep) against the
closure's def-eval env frame count (shallow) — params stamped deeper than
the closure's frame count are never tracked at all, while the enclosing
fn's LOCALS (stamped in the def-eval generation) pass. The fix must
normalize the comparison across env generations — e.g. track when the
variable is NOT bound within the closure's own frames (name-based
resolution against the closure's params + inner bindings), which is what
TS's per-object env identity gives it for free. Blast radius: ALL closure
capture tracking — gate the change on the full corpus + the repro + the
non-Impl(Fn) variants (dyncap2/dyncap3 shapes, both currently green).

### Capture residual — final probe data (2026-07-18)

IDREF/CAPTRK2 probes during the repro compile:

```
8× IDREF name fb=true caps=true  spec=false   (def-time evals — tracked)
4× IDREF name fb=true caps=true  spec=true    (a spec eval WITH a map — tracked, fl=1)
2× IDREF name fb=true caps=false spec=true    (a spec eval with NO map — tracker skipped)
```

So THREE eval generations touch the closure body; at least one
spec-generation eval DOES track `name` (caps=true spec=true), yet the
EMITTED closure fid's capture struct lacks it — either that eval's struct
build was swallowed before registration, it registered under a fid that is
not the emitted one, or the mapless (caps=false) eval is the one whose
FuncVal/fid codegen ultimately consumes. NEXT: log fid at the
anonymous*function struct-build (closure_capture_type registration) and at
the FuncVal mint, correlate with the emitted `closure_yo_id*\*` — one
rebuild answers which generation owns the emitted fid; then either route
that generation's eval through a map (the deferred-path map gap at
anonymous_function.yo:961-979) or reuse the tracked generation's struct.

### Capture residual — SOLVED ANALYTICALLY (fid ownership answered)

CAPBUILD probe: the repro's closure is evaluated in ~10 generations; two
early generations build the COMPLETE capture struct (nf=4:
name+flag+extras+probe — fids closure_yo_id_5451/5462), but codegen emits
the fid of the LAST spec-generation FuncVal (closure_yo_id_5498, nf=2).
Fresh fids per generation defeat every fid-keyed merge.

THE FIX (two coordinated pieces, both sides now fully specified):

1. **Source-token-keyed fid sharing**: at the FuncVal mint in
   anonymous_function.yo, key a registry by the closure's SOURCE position
   (token file/row/col — stable across clone_expr_fresh_ids) and reuse the
   first-minted fid for every re-eval of the same source closure. With one
   fid, the existing keep-larger registration (5d69b2b7f) makes the nf=4
   struct win for the capture-access rewriting.
2. **Capture-MAP union for the value side**: register the ENRICHED map
   (not just the struct type) per fid, unioned by name across generations;
   the closure-creation emission must initialize the full field set from
   the unioned map (a struct field without a recorded initializer would
   zero-fill — silently wrong at runtime).

Verify with the in-repo repro + dyncap2/3/5 controls + full gates. This
closes effect_analysis + cache (and the collections files sharing the
class) once landed.

### cache.test.yo — auto-declare attempt REVERTED (2026-07-18)

An emitter-level auto-declare (`__typeof__(rhs) temp = rhs;` for
assignments to temps missing from declared_c_var_names) BROKE the stage-2
binary (env-check abort): the declared-names set does not cover every
declaration shape (params, named locals, decls emitted before the
declared_ref recording attaches), so the transform REDECLARED live
variables and shadowed them. Reverted cleanly.

The principled fix remains: find why the MIDDLE nested cond/match level's
result-temp declaration is skipped while its arm assignments are emitted
(batch evidence: `__yo_t10 _file____User_temp_7019;` and `..._7021;`
declared, `_7020` assigned in an arm chain `7020 = 7019; 7021 = 7020;`
with no decl anywhere). The decl gate (match.yo:1089 / cond.yo:589) skips
only on is_unit or a missing ei.variable_name — instrument WHICH of the
two held for 7020's node (per-pass ExprInfo overwrite suspected: the decl
moment read a different info generation than the arm emission). Use the
kept batch + YO_KEEP_BATCH=1.

### cache.test.yo — ROOT CAUSE FOUND: cond comptime-degenerate + begin-wrapper identity (2026-07-18)

A begin.yo decl-gate widening (declare whenever `!(is_unit)`) did NOT fix it
(same undeclared temp in the s2t20 retest) — reverted. The missing temp is
NOT a begin temp: it is the **cond's result temp on the comptime-degenerate
path**. Minimal 37-line repro (deterministic, byte-identical under s1t20 AND
s2t20 — `src/tests/fixme.yo` snapshot below): a match arm whose body is
`cond((platform == Platform.Windows) => ..., true => match(home_dir(), ...))`
— yo-self/cache.yo:44-62's exact shape (`get_global_cache_dir`).

Mechanism (TS vs yo-self):

- TS `evaluateBeginExpression` (begin.ts:1016-1045) on a NON-begin body
  builds `begin(cloneExpr(inner))` and **rewrites the node in place**
  (`replaceFuncCallExprWithFuncCallExpr`) — the cond's arm slot IS a begin
  node afterwards, holding its own temp; the inner match is a separate clone
  with its own temp. TS cond eval (cond.ts:269-276) adopts the begin's temp;
  TS cond codegen (cond.ts:107-158) skips the decl on canOptimizeToDirect
  and calls generateExpr(value) → generateBegin DECLARES the adopted temp,
  returns it, cond emits a harmless self-assign. Verified in TS emission:
  `decl 43926; { // begin block ... 43926 = 43922; } 43926 = 43926;`.
- yo-self `evaluate_begin_expression` (begin.yo:555-564) wraps a non-begin
  body in a synthetic 1-element ARG LIST ONLY — no AST rewrite. One node id
  serves as both "begin result" and "inner match"; the begin finale stamps a
  fresh out*info onto that shared id (begin.yo:1323) and attaches a fresh
  temp (6480), which the cond adopts — while codegen's walk of the arm body
  hits generate_match, which emits with the match-generation temp (6479).
  The adopted 6480 is declared by NO emitter → `6480 = 6479; 6481 = 6480;`
  with 6480 undeclared. (Same class as the documented shared-id clobbers at
  begin.yo:1273-1322 — runtime_arg_exprs_in_order / index*\* / deferred-dup
  carries — but for variable_name the clobber goes the OTHER way.)

Probe run (ATTACH/COND-ADOPT/CG-COND/CG-MATCH eprintln probes) CONFIRMED the
stamp order: `[ATTACH match=6479] → [COND-ADOPT adopted=6479] →
[ATTACH cond=6480]` — the adoption works; the OUTER match's arm-body
begin-wrapping then re-mints a fresh temp over the COND's shared-id info,
orphaning the adopted name.

**Fix attempt 1 (REVERTED — fixpoint breaker):** carrying `variable_name`
across the shared-id begin finale (out_info.variable_name =
last_info.variable_name, carry_runtime_args-gated) fixed cache (6/6) and all
behavior gates (corpus 130/2, std 153/153, battery 5/5, env-check, prior
flips) but **broke the stage2≡stage3 fixpoint** — and the double-emit test
showed the same binary emitting DIFFERENT bytes on identical input
(S1FIX_NONDETERMINISTIC, first divergence at the same byte as the fixpoint
break; ~1.4M diff lines of wholesale \_\_yo_tN renumbering + differing
Option-instantiation populations). The attach `.Some`-branch update path
(get_variables_from_env + in-place var update / re-home) makes downstream
comptime decisions sensitive to per-run-random variable-id state. LESSON:
**any eval-side change touching attach/env var bookkeeping must pass a
same-binary DOUBLE-EMIT determinism check, not just one fixpoint compare.**

**Fix landed (consumer-side):** cond codegen's collapse-to-direct path
(codegen/exprs/cond.yo, direct-value branch) now emits a TYPED
declaration-assignment when `value_code != tv` — exactly the orphaned-adoption
case; the healthy case (tv == value_code, TS-identical self-assign) is
byte-unchanged. Zero evaluator changes → deterministic. Corpus regression:
tests/codegen-bootstrap/cond_comptime_arm_match_temp.yo.

## phase6_verify round-10 one-off — suspected GC-corruption flake (2026-07-18 night)

`s2e test yo-self/tests/phase6_verify.test.yo` passed 3/3 in the combined
gate battery, then FAILED in the round-10 sweep ~45 min later with the SAME
binary (byte-copied pin): the ~1M-line whole-compiler batch C came out with
2 errors (`use of undeclared identifier 'result'` at 365802, `expected
expression` at 1063147). Same source, same binary, different output across
two runs. The GC trigger is allocation-count-based (deterministic), but a
latent traverse bug freeing LIVE memory corrupts in an ADDRESS-dependent —
i.e. per-run — way, and phase6_verify's batch has the largest heap of any
test file (the gc-traverse family, cf.
issues/fixed/yo-self-gc-traverse-value-struct-field.md).

PROBE (once no sweep owns yo-self/tests): run the file 3x under the pinned
binary with YO*KEEP_BATCH=1, diff the batch .c across runs; also 2x under
/tmp/s2t18 (pre-today) to test whether the flake predates today's fixes.
Failures that move/vanish across runs = GC/heap corruption class (audit
\_\_yo_traverse*\* for the missed-field class); identical stable errors =
deterministic emission divergence (re-triage).
