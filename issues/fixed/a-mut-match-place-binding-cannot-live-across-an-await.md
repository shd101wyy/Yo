# A `mut` match place binding cannot live across an await

**Severity:** S2 — a valid program is rejected: an arm of a `mut` match (`match(&mut x, …)` or a `mut` binding scrutinee) that binds a place and awaits is a compile error instead of compiling.

## Symptom

```yo
task := io.async((io : Io) => {
  (o : Option(i32)) = .Some(i32(1));
  match(&mut o, .Some(n) => {
    io.await(yield(io), io);
    n = (n + i32(1));
  }, .None => ());
});
```

is rejected with "This arm binds `mut` places into the scrutinee and awaits: a
place cannot live across an await yet (plans/VALUES_BY_DEFAULT.md decision
26)".

## Why

Decision 26's `mut` places (landed 2026-10-10, branch
`feat/vbd-consuming-match`) bind each part as a C pointer
(`T* n = &(path)`, `_emit_place_binding_decl` in `src/codegen/exprs/match.yo`).
Inside an `io.async` body the single-pass lowering stores an arm's bindings in
task slots (`_bind_pattern_name`), and a binding's slot is typed by the
binding's value type, not the pointer, so the store would not type-check; a
C-local pointer does not survive the resume either. `mut(y) := place` local
borrows already live in slots as pointers (`_generate_inout_local_binding`,
`src/codegen/exprs/init_assignment.yo`), so the fix is to give a place
binding a pointer-typed slot the same way, with the scrutinee's root kept in
its slot to the end of the arm.

## Until then

Match by value or through `&x`, and write the new value back after the await.
The evaluator rejects the arm (`evaluate_match`, `src/evaluator/exprs/match.yo`)
rather than miscompiling it.

## Fix (2026-10-16)

The slot half of the plan above was already in place: a place binding is an
`is_ref` variable (`evaluate_match` sets it), and the suspension analysis types
an `is_ref` variable's slot as `T*` (`_capture_env_variable`,
`src/evaluator/shared/suspension_analysis.yo`), exactly as for `y := &mut x`.
`_bind_pattern_name` stores the C pointer into it and `atom.yo` reads a place
binding as `(*sm->…)`. The scrutinee's root keeps its own slot: `&mut x` is an
address-taking use (`_lv_mark_scope`), and a field root is read by the `match`
statement, which ends after the arm. So the work was:

- **The evaluator rejection is gone** (`evaluate_match`,
  `src/evaluator/exprs/match.yo`).
- **A `mut` match never copies its subject**
  (`_generate_match_expression_body`, `src/codegen/exprs/match.yo`). A field
  or dereference scrutinee had been materialized into a temp, so the places
  pointed into the copy. That is a sync bug too, filed and fixed here as
  `issues/fixed/2026-10-16-a-mut-match-on-a-field-or-a-dereference-writes-a-copy.md`
  (S1).
- **An assignment through a slot pointer saves the old value after an
  awaiting RHS** (`generate_assignment`, `src/codegen/exprs/assignment.yo`).
  `(*sm->var_s) = io.await(…)` took the plain-function path: the old value was
  saved into a C local before the RHS, while its drop reads the temp's slot, so
  the old value leaked. The same code served `y := &mut t; y = io.await(…)`,
  which leaked the same way before this change.
- **Rule 4 covers a place bound over a local borrow.** `match(cur, .Some(n) =>
  { await; n = … })` with `cur := &mut h.o` (`h` a `ref` object) does not
  register `n` as a borrow of its own (a cursor re-point must not conflict
  with it), so nothing held a borrow through the cell across the await. An arm
  that awaits now keeps such a `cur` live to `n`'s last mention
  (`local_borrow_extend_to_match_place`, `src/evaluator/utils.yo`), and rule 4
  rejects it (E0911). A direct `match(&mut h.o, …)` was already registered and
  rejected; a module-level root is rejected by rule 3 at the first call.
  Whether the arm awaits is decided by spelling before the arm is evaluated
  (`_lb_contains_await_call`): any `<recv>.await(…)` call counts. The removed
  rejection used `expr_contains_await`, whose pre-evaluation fallback sees
  only `io.await`, so an arm awaiting through another name of the task's
  `Io` (`e.await(f, e)`) was never rejected: develop compiled such arms,
  the cell cursor above included, with no E0911. The CLI case below uses
  that spelling.

## Verification

- `tests/match_async_arms.test.yo`: seven tests. A place written after one and
  two resumes; a counted payload replaced and an `ArrayList` payload pushed
  after an await; two places of one arm and a local-borrow scrutinee; two
  spawned tasks interleaving five yields each, so each resume reads its own
  task's slot; the same with the root never mentioned after the `match`
  (`&mut o` alone keeps `o` in its slot); a field place of a task's local
  struct; and a place and a local borrow assigned an awaited `String` (the
  leak above). Before the fix the file failed to compile with this doc's
  error; after it all pass under the test runner's ASan build. Running them
  as one batch exposed
  `issues/fixed/2026-10-17-a-nullable-pointer-match-binding-stores-into-a-same-named-bindings-slot.md`
  (S2, fixed here too).
- `tests/cli-cases/mut-match-place-across-an-await-through-a-cell-is-e0911`:
  the cursor-through-a-cell form, awaiting as `e.await(…)`, is E0911. The
  develop binary (`ed733408c`) checks it clean.
