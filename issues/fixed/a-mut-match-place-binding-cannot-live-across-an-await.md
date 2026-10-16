# A `mut` match place binding cannot live across an await

**Severity:** S2 — a valid program is rejected: an arm of a `mut` match (`match(&mut x, …)` or a `mut` binding scrutinee) that binds a place and awaits is a compile error instead of compiling.

## Symptom

```rust
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
