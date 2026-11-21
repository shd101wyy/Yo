# A reference captured by a `Thread.spawn` closure is an uncoded error that calls its type `*(i32)`

**Severity:** S3 — a correct rejection had no error code, named the reference by its internal raw-pointer field type, and suggested remedies (an `Arc`, a `Send` projection) that do not address a borrow.

## Symptom

```yo ignore
{ Thread } :: import("std/thread");
main :: (fn() -> unit)({
  x := i32(1);
  r := &x;
  t := Thread(unit).spawn({ r }(io : Io) => {
    n := r.*;
  });
  t.join();
});
export(main);
```

```text
error: Captured variable 'r' (type *(i32)) does not implement Send. To move it across threads, share it through an Arc (its contents must be Send + Sync), rebuild it on the other thread from Send values, or capture a Send projection of it instead.
  --> r2.yo:5:29
```

The rejection is right: a borrow cannot cross threads (`plans/backlog/REFERENCES_AND_ORIGINS.md` O8,
O10; a reference is never `Send`), and E0909 already lists "spawned" among the escapes of a
borrowing value.

## Root cause

A capture list's borrow entry (`{ &x }`, `{ &mut x }`, and the by-value entry `{ r }` of a reference
binding, which copies the reference, VERDICTS-44 R-CAP-1) is stored in the capture struct as a
pointer field to its place. The captured-variable record (`FuncCapturedVarInfo.ty`,
`src/evaluator/values/anonymous-function.yo`) carries that field type, `t_ptr(T)`, and
`validate_capture_trait_requirements` (`src/evaluator/utils/closure.yo`) judged it as an ordinary
captured value: a raw pointer is not `Send`, so it printed the field type and the generic advice.
None of the capture-trait violations carried a code.

The pointer field is the capture struct's representation (the field walks in `src/types/utils.yo`
already treat a borrow entry as a reference by another spelling), so the field type stays; what a
diagnostic shows is the reference the source wrote.

## Fix

- A borrow entry captured by a closure whose slot requires `Send` is E0909: "Captured variable `r`
  (type `&i32`) borrows `x`, and a borrow cannot cross threads", with a help naming the owned-value
  capture (`{ v : r.* }`, `.clone()`) and `Arc`.
- `_captured_var_shown_type` renders a borrow entry's pointer field as `&T` / `&mut T` (by the entry's
  mode in the capture struct's borrow table) in every capture-trait message: the per-variable one, the
  function-value one, the closure-level aggregate and the recorded `Send`/`Sync` verdict reasons.
- The other capture-trait violations (a captured value that is not `Send`, an `FnMut` closure in a
  `Sync` slot, a thread closure reaching a non-`Send` global) carry E0602; a closure that borrows its
  captures (the literal argument of a borrowing parameter) passed to a `Send` slot carries E0909.

## Tests

`tests/cli-cases/a-reference-sent-to-a-thread-is-e0909` and
`tests/cli-cases/a-borrow-captured-by-a-thread-is-e0909`: `error[E0909]` naming `&i32`. Before the fix the
first line was the uncoded `(type *(i32))` message above. `tests/origins/corpus.tsv` row `thread-send-origin`
(a `RefCell(&i32)` captured by a thread closure) now records E0909 as its first error, its expected verdict.
