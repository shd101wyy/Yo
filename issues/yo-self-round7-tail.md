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
