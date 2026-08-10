# Async match scrutinees leaked: their deferred drops hit a zeroed slot

**Status: FIXED (TS) 2026-08-10** (`src/codegen/async/state-code-gen.ts`,
`src/codegen/exprs/match.ts`, `src/codegen/exprs/async.ts`,
`src/codegen/functions/context.ts`). **yo-self port pending** — its
`_store_temp_var_to_state_machine_if_needed` is a documented no-op stub, so
the same class exists there.

Found by PR #92's CI: Linux runs the language suite under LeakSanitizer
(macOS cannot), and the new awaitless-arm regression test leaked both of its
`Task` payloads. Reproduced locally with macOS's `leaks --atExit`
(6 leaks / 192 bytes → 0 after the fix).

## Root cause — three stacked gaps

A `match` whose scrutinee is an owning temp, inside an async state machine:

1. **The scrutinee's deferred drops referenced `sm->var_<temp>`, but nothing
   ever STORED the local temp into that slot.** Every drop — the post-await
   remaining code, the awaitless inline path, the escape dispose — was a
   silent no-op on calloc zero, and the payload leaked. Fixed by calling
   `storeTempVarToStateMachineIfNeeded` after generating the scrutinee, in
   BOTH match paths (`generateMatchWithAwait` and the normal `match.ts` path,
   which awaitless arms inside a state machine still take).
2. **With the store in place, the escape dispose would double-drop**: it
   lists every cross-boundary local, and a pattern BINDING (`.Some(x)` → x)
   borrows the scrutinee's ownership (its store does not dup). Binding fields
   are now recorded in `asyncPatternBindingFieldIds` and skipped in the
   `state == -2` drop list.
3. **A nested match claims the outer arm's dispatch slot** (`sm->cond_branch_N`
   is overwritten), so the outer arm's remaining-code `case` — where its
   deferred drops lived — was unreachable at resume. When the outer arm's
   remaining exprs are trivial (unit atoms; the drops ride
   `deferredDropExpressions`), the arm now attaches as a `chainedBranches`
   layer, which runs after the branch switch regardless of dispatch value —
   safe because RC drops are no-ops on the zeroed slots of arms that never
   ran. Arms with REAL trailing statements keep today's placement; running
   them cross-arm would be wrong. That those statements silently never run is
   a PRE-EXISTING gap of the same family as the if-in-while bug — tracked
   separately.

## Verification

`leaks --atExit`: 6 → 0 on the reducer; async 153/153, algebraic_effects
74/74, rc 35/35.

## Worth remembering

- macOS cannot run LeakSanitizer; `leaks --atExit -- <binary>` is the local
  stand-in, and it reproduced CI's finding exactly.
- Every deferred drop that names `sm->var_X` needs a matching STORE on every
  path that reaches it — grep for drops of `var__yo.*temp` slots when adding
  state-machine codegen.
