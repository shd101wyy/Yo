# A `match` / `cond` call argument leaked its result on an explicit `return`

> Found 2026-09-25 by the evaluator memory campaign
> (`plans/EVALUATOR_MEMORY_REDUCTION.md`, the zero-hit `ArrayList(ArrayList(String))`
> leak roots at the end of `yo check src/main.yo`). **FIXED same day** on
> `fix/path-collection-overwrite`. Follow-up to
> `issues/fixed/match-or-cond-call-argument-result-is-never-released.md`, which
> fixed the scope-end release of the same temp.

## Symptom

A reference-counted value produced by a `match` or `cond` passed directly as a
call argument was never released when the enclosing function left through an
explicit `return(...)`:

```rust
f :: (fn(keep : Option(S)) -> i32)({
  v := read(match(keep, .Some(p) => p, .None => S(n : 0)));
  return(v);
});
// fresh arm: the S is never disposed; borrowed arm: `keep`'s value keeps an extra reference
```

Both arms leak: the fresh one leaks the object, the borrowed one leaks the
reference the arm took on the caller's value. The same function with a bare tail
`v` instead of `return(v)` was fine.

## How it was found

The deep holder census of `check src/main.yo` listed 32,291 unreachable
`ArrayList(ArrayList(String))` objects (ExprInfo path collections). The rc
event log showed each one with exactly four events after allocation: `+1` in
`expr_info_paths_for_write`, `-1` in `evaluate_identifier_and_operator`, `+1` in
`evaluate_property_access` and `-1` from one ExprInfo's destructor, ending at
rc 1. The unmatched `+1` is the match arm
`match(obj_info_opt, .Some(oi) => oi.path_collection, ...)` passed to
`build_field_path_collection` in the labeled-field branch, which ends in
`return(expr)`. In the emitted C the temp's release sat only in the dead code
after the `return`. The sibling argument `oi.variable_name` (an
`Option(String)`) leaked the same way.

## Root cause

`generate_match_expression` and `generate_cond_expression` declare their result
temp bare, before the `switch` / `if` chain (`T tv;`), and assign it inside the
branches. The emitter's block-scope stack (`_emitter_track_scope`, the liveness
signal the early-exit gates read) records only declarations of the form
`<type> <name> = …`, so the temp never entered it.

`generate_pending_deferred_drops` (`src/codegen/exprs/return.yo`), which emits
"Drop local variables before early return", keeps a pending drop only if its
target is in that stack, on both the escape path and the env path. So the temp's
scheduled `___drop` was skipped at every explicit `return` and every
`if (__yo_effect_escaped)` exit, and nothing after a `return` runs.

## Fix

`Emitter.mark_declared_in_scope(name)` pushes a name into the current C block of
the scope stack. Both emitters call it for their bare-declared result temp once
the whole `switch` / `if` chain is closed, which is the first point where every
path has assigned it:

- An early exit inside an arm still sees the temp as undeclared and skips it. It
  is unassigned there, and releasing it would read garbage.
- Every exit after the chain releases it.
- The name leaves the stack with its enclosing block, like every other
  declaration.

Zero-initializing the temp instead (`T tv = {0};`) was rejected. It would make
an in-arm exit release a zero value, and for a value struct with a user
`Dispose` that means running the user's dispose on a zero struct.

## Tests

`tests/rc.test.yo`, "a match or cond call argument is released on an explicit
return": with a `Dispose` counter, a fresh `match` arm (nested `if` + `return`)
and a fresh `cond` arm (top-level `return`) are each disposed exactly once. The
borrowed arms, called three times through the early return, keep the caller's
value alive, and it is disposed exactly once at its own scope end (the
over-release canary). Fails on the unfixed compiler.
