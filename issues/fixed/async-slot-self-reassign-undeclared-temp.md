# Reassigning an RC var in an async state-machine slot emitted a drop of an undeclared temp

**Status: FIXED 2026-08-13 (both compilers, same commit).** Found while
building P2.5 Group B: `run_executable`'s new
`abs_exe = Path.new(base).join(Path.new(abs_exe.clone())).to_string();`
inside `io.async` made `./yo-cli compile yo-self/main.yo` emit invalid C.

## Symptom

```
/tmp/yo-gb.c:1329465: error: use of undeclared identifier '_yo740e2887_temp_1024050'
        fn_yo..___drop((__yo_struct_yo..)(_yo740e2887_temp_1024050));
```

Minimal repro (30 lines): `issues/repros/async-slot-self-reassign-undeclared-temp.yo`.
The essential shape: an RC (String) variable that (1) lives across an await —
so it is lowered into a state-machine slot (`sm->var_...`) — and (2) is
REASSIGNED, where the old-value drop stays in the SAME state. The await after
the reassignment is what makes the variable an sm slot; without it the
program compiles fine.

## Root cause

`generateAssignment` saves the LHS's old value into a temp before
overwriting, so the deferred drop can release it. In a state machine with an
`sm->` LHS, the save goes to the temp var's OWN sm field — but when the temp
var was never lowered into the state struct (its drop does not cross a
suspension point), the TS emitter hit a `skippedTempVar = true` arm commented
"should not happen in practice" and emitted NO save at all, while the
scope-end drop still referenced the temp name: invalid C.

yo-self's port (`codegen/exprs/assignment.yo`) was differently broken: for an
`sm->` LHS it skipped the save UNCONDITIONALLY — no captured-field save
either — so the deferred drop read whatever the field held (calloc zero = a
silent leak of the old value, the async-match-scrutinee-leak family).

## Fix

- TS (`src/codegen/exprs/assignment.ts`): the not-in-state-struct arm now
  declares a plain LOCAL temp (the drop is same-state by construction, so a
  local is the correct home).
- yo-self (`yo-self/codegen/exprs/assignment.yo`): the `sm->` branch now
  mirrors TS's full design — save into the temp's own `sm->var_<id>` field
  when the temp is a Local state-machine variable, else the local-temp
  fallback.

Verified: the repro compiles and runs (rc=0) under the fixed TS compiler;
the full self-hosted battery covers the yo-self side.
