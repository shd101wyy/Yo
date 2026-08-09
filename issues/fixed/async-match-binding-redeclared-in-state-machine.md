# A match-arm destructuring binding is declared twice inside a state machine

**Status: FIXED** (2026-08-09) in `src/`. Found while wiring `build`/`fetch`/
`install` to subcommands (plans/P1_CLI_PARITY.md §1); the last of the five
classes that seam exposed
([write-up](fixed/async-await-in-nested-match-arms.md)).

Invalid C, so it was loud — not a silent miscompile.

**This one is a case of the SELF-HOSTED compiler being more faithful than the
reference.** `yo-self/codegen/exprs/match.yo` has had the whole mechanism for
some time — `_shadow_add` called from `_emit_destructure_binds` for both the
labeled and positional forms, and `_remove_arm_shadows` after the arm body. Only
`src/` was missing it, in exactly the path described below. No port was needed;
the fix went the other way.

## Symptom

```c
__yo_enum_yo65c93212_id_3 p = parsed_result.data.Ok.value;   // the destructuring
__yo_enum_yo65c93212_id_3 p = sm->var_yo65c93212_p_2;        // the SM "load"
```

`error: redefinition of 'p'`. Four instances in the emitted C for
`yo-self/main.yo` with `build`/`fetch`/`install` dispatched: `'p'` twice (in
`install_command.yo`), `'sub_path'` and `'it'` (in `fetch.yo`).

## Root cause

The arm's destructuring declares `p` as a C local. The state machine then
re-declares the same name to materialise a hoisted local of that name out of its
struct field.

`FunctionGenerationContext.localShadowedVariables` is exactly the mechanism for
this. Its comment reads:

> Variables that are locally shadowed (e.g., in match destructuring patterns).
> When a variable name is in this set, use the local C variable instead of
> `sm->var_...`

`codegen/exprs/atom.ts:266` consumes it. But it is only ever POPULATED by the
NULLABLE-POINTER match path (`codegen/exprs/match.ts` ~line 383, which
registers the destructured name, generates the arm body, then unregisters it).
The ordinary tagged-union destructuring path a few hundred lines below — the one
that emits `T varName = matchedValueCode.data.Variant.field;` and then stores it
into the state-machine field — never registers its bindings.

## Fix

Register each destructured name in `localShadowedVariables` in the tagged-union
path too — both arm blocks, both the labeled (`.Circle(r : radius)`) and
positional (`.Point(x, y)`) forms — and unregister it after the arm body,
mirroring the nullable-pointer path and yo-self.

Watch for the case the two `p`s are genuinely DIFFERENT variables (an arm
binding shadowing an outer local of the same name, which is what the `_2` suffix
in `var_yo65c93212_p_2` suggests). `localShadowedVariables` is keyed by NAME, so
it makes every reference in the arm body resolve to the local — correct for the
shadowing case, and the reason the registration has to be scoped to the arm body
and undone afterwards.

## Blast radius

Only reachable from a `match` arm whose destructuring binds a name that is ALSO
a hoisted state-machine local, inside an async body. It blocks dispatching
`build`/`fetch`/`install` from `yo-self/main.yo`; their implementations,
`check`, and their differential corpus (`tests/cli-cases/pending/`) are all in
place and waiting on it.
