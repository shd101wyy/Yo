# An async state machine's slot lookup ignores the capture struct for an outer variable

**Severity:** S2 (latent: no Yo program reaches it, shown below). If it were
reached, the slot would name a field no state-machine struct declares: a C
compile error at best, and a read of a zeroed slot if a field of that name
ever existed. That is the failure class of
`issues/fixed/an-awaiting-io-async-body-captures-a-local-alias-without-retaining-it.md`.

**Status: FIXED 2026-10-05**, as a correctness invariant with a direct test.

## The defect

`sm_slot_of_variable` (`src/codegen/async/state_machine_naming.yo`) returned
`sm-><local field>` for every entry it found, `.Outer` included. For an
`.Outer` entry, `sm_local_field_name` has no registration
(`register_sm_captured_names` skips outer entries), so the result was
`sm->var_<id>`. An outer variable's storage is the capture struct,
`sm-><sm_capture_slot>.<name>`. The atom emitter's own lookup
(`_generate_sm_atom`, step 1) already had that branch; this function was its
duplicate without it.

## Why no program reaches it

`sm_slot_of` resolves a NAME through `scope_variables(key, env, name).last()`
and passes the binding to `sm_slot_of_variable`. The six callers:

| Caller | The name | Can it resolve to a capture? |
| --- | --- | --- |
| `await.yo` (an await's result slot) | the await's minted result temp | no: minted in the body |
| `drop_dup.yo` (a dup result's slot) | the dup's minted result temp | no |
| `closures.yo` (a closure literal's slot) | the literal's minted temp | no |
| `init_assignment.yo` `_sm_binding_slot` (`:=` and destructuring) | the name the body binds | no: the no-shadowing rule rejects a body `:=` or destructuring with a captured name in scope |
| `atom.yo` (a break/continue drop's `in_slot`) | a drop target | only `.is_some()` is read |
| `return.yo` (a return's drop `in_slot`) | a drop target | only `.is_some()` is read |

`sm_storage_id` does not redirect onto an outer entry either: an alias whose
owner is `.Outer` keeps its own id. The two bindings that may share a captured
name, a `match` pattern binding and a nested closure parameter, never reach
`sm_slot_of`. A pattern binding's slot comes from `_inline_binding_sm_field`
(`match.yo`), and a nested closure is emitted as its own C function. That holds
even before the name-matching re-kind was fixed
(`issues/fixed/the-io-async-capture-re-kind-pass-matches-captures-by-name.md`),
which could re-kind a pattern binding `.Outer`. The A/B emission diff of
#1218 and of this fix shows no change from this function in `src/main.yo` or in
the async test batches.

## Fix

`sm_slot_of_variable` and `sm_slot_of` take the context's `sm_capture_slot`
(`__capture`, or `<prefix>capture` at a fused await site). An `.Outer` entry
returns `sm-><capture_slot>.<sanitized name>`, named by the entry's NAME and
never the map key (an outer capture is registered under its id and under its
label, `resolve_var_name_in_context`). A `.Local` entry keeps the
alias-or-field lookup. Every caller passes `context.sm_capture_slot`.

## Tests

`tests/internal/state_machine_naming.test.yo` calls the function directly:

- an `.Outer` entry returns `sm->__capture.__yo_v_count`;
- with a fused site's capture slot it returns `sm->__yo_fuse_3_capture.__yo_v_count`;
- a field alias keyed by an outer entry's id does not redirect it;
- controls: a `.Local` entry returns `sm->var_<id>`, or its alias; a variable
  missing from the map returns `.None`.

With the old `.Outer` arm restored (`sm_local_field_name(id)`), the first three
fail.

## Verification

AB_PLACEHOLDER
