# A `match` arm's pattern binds a borrowing future and escapes the freeze

**Severity:** S2 — the program wrote a place while a future it was lent to
was alive: stale reads (`10` where 50 was right) and an aliased `&mut`.

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

```yo ignore
v := match(tenfold(&c, io), f => {
  c.n = i32(5);          // writes the place `f` borrows
  io.await(f, io)
});
```

compiled and printed `10`; with `&mut c` (`p44b_match_bind_mut.yo`) the
program wrote `c` while `&mut c` was lent and printed `101`. `f := tenfold(&c,
io)` is rejected ("would hold a borrowing future").

## Root cause

`note_second_class_binding` (decision 38 A's binding rule, and A2's
"a borrowing future is never bound") ran for `:=` and `=` bindings only.
`evaluate_match` (`src/evaluator/exprs/match.yo`) added pattern bindings
without it, so no freeze was placed and the future rule never ran. Before A2
no second-class temporary could reach a scrutinee (a function cannot return
a borrowing closure).

## Fix

`evaluate_match` calls `note_second_class_binding` for each runtime pattern
binding: a borrowing future is rejected at the binder, and any other
second-class value freezes what it borrows for the arm.

Regression test: `tests/async_await.test.yo`, "a match arm cannot bind a
borrowing future, and _ := cannot discard one".
