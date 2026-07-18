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
