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
