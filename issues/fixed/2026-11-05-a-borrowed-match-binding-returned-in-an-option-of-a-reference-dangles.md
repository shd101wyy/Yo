# A borrowed-`match` binding returned in an `Option(&T)` dangles

**Severity:** S1 — memory unsafety in safe code: a function returning `Option(&T)` built from a binding of `match(&x.f, …)` returns a pointer to its own stack frame (ASan: stack-use-after-return).

Found while giving `OnceCell(T).get` Rust's `-> Option(&T)` result (the `OnceCell`
move-only read S2 filed on `vbd/v5-part-b-tests`), on develop 68b45b81d.

## Symptom

```yo ignore
P :: struct(a : i32, b : i64, c : i64);
H :: struct(v : Option(P));
peek :: (fn(h : &H) -> Option(&P))(
  match(&h.v, .Some(s) => .Some(s), .None => .None)
);
```

`peek(&h)` checks and compiles. Built with `--sanitize address --allocator system`, reading
the result is `AddressSanitizer: stack-use-after-return … '__yo_v_s' <== Memory access …
inside this variable`. Reproducer:
`issues/repros/2026-11-05-a-borrowed-match-binding-returned-in-an-option-of-a-reference-dangles.yo`.

A `String` payload (`Option(&String)`) hits the same hole, but on develop 68b45b81d its C
failed to compile first: a reference to a newtype was declared before the newtype's typedef
(fixed by the OnceCell borrowing-`get` PR, `fix/oncecell-borrowing-get`).

## Root cause

The evaluator treats a binding of a borrowed `match` as a place inside the scrutinee
(VERDICTS-13 §14), so the N2b composite-result rule accepts `.Some(s)` as rooted at `h`. But
codegen lowers a `&` borrowed-match binding as a by-value copy of the payload in a local
(`__yo_t_… __yo_v_s = …`). Only a `&mut` match's binding is a pointer into the scrutinee
(`T* __yo_v_n = &(…)`). So `.Some(s)` takes the address of the local copy, which dies with
the call.

## Fix (2026-11-05, coordinator verdict (A))

Every binding of a `&` match is now a C pointer into the scrutinee's place, as a `&mut`
match's binding already was. This is uniform: Copy payloads, bindings below a cell, every
lowering. A reference the arm yields to a binding therefore points where the scrutinee does.

- **Evaluator** (`evaluate_match`, `src/evaluator/exprs/match.yo`). A binding of `match(&x, …)`,
  or of a reference binding matched bare, is `is_ref`. A reference payload's binding is the
  exception: it already holds its own pointer. The match registers `MATCH_MODE_REF` when
  its scrutinee is a place, and `MATCH_MODE_REF_TEMP` when it is a temporary
  (`src/pattern.yo`, `match_mode_binds_refs`). The predicates that read `is_ref` as "a `&mut`
  borrow" exclude `is_borrow_match_binding`: `variable_is_mut_borrow`,
  `variable_is_borrow_parameter`, the explicit-copy and closure-move diagnostics, the
  capture-write check and the unused-binding warning. So the binding stays a shared borrow,
  and every diagnostic it produced is unchanged.
- **Codegen** (`src/codegen/exprs/match.yo`).
  - Each lowering declares the binding `T* n = &(path);` and records it as a place binding,
    so reads are `(*n)`. The lowerings are the general test chain (`_emit_pattern_chain`'s
    `refs`, including or-patterns and named patterns), the tagged-union switch
    (`_emit_destructure_binds` through `_emit_arm_binding_decl`) and the nullable-pointer
    binder.
  - A place scrutinee is never copied into a temp, as for a `&mut` match.
  - A temporary scrutinee is materialized in a C local that outlives the arms.
  - In an `io.async` body, the binding's task slot is `T*`, through the suspension analysis's
    `is_ref` rule, as for a `&mut` place.
- **Captures.** An implicit closure capture of such a binding copies its part, exactly as it
  did when the binding was a copy. `anonymous_function.yo` keeps accepting it. The capture
  initializer reads `(*n)` (`_deref_place_binding`, `closures.yo`), and the closure body reads
  the field as a value (`atom.yo`). A capture list's `{ &n }` borrows the place.
- **Call operands.** A by-value operand that reads such a binding is not spilled into a
  sequencing temp, because its place is frozen while the binding lives
  (`_value_place_root`). A task slot's `(*sm->…)` read is passed as a slot read
  (`_materialize_arg`).

Test: `tests/borrowed_match_binding_place.test.yo`. An address taken through a binding is
written after the match, and the scrutinee, read by value, must show the write. The test
covers:

- the reproducer's `Option(&T)` return;
- the switch and general lowerings;
- or-patterns and named patterns;
- a reference binding matched bare;
- a borrowed element;
- a temporary scrutinee;
- a closure capture;
- an `await` in the arm.

The reproducer runs clean under ASan.
