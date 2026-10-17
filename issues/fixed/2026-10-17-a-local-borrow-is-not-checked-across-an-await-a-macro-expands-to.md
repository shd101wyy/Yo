# A local borrow is not checked across an await a macro expands to

**Severity:** S2 — an invalid program is accepted: a local borrow through a
reference cell or a module-level place may be live across the `await` of a
`for_await` loop (or any macro whose expansion awaits), so another task can
write the place while this one is suspended.

Found by the review of #1419
(`issues/fixed/a-mut-match-place-binding-cannot-live-across-an-await.md`).
The reviewer's case was a `mut` match place; the hole is older and wider.

## Symptom

```yo
{ Stream, for_await } :: import("std/async/stream");
Holder :: ref(struct(o : Option(i32)));
// … a `Stream` impl `Countdown` …
main :: (fn(io : Io) -> unit)({
  h := Holder(o : .Some(i32(1)));
  t := io.async((e : Io) => {
    cur := &mut h.o;
    for_await(Countdown(_n : i32(3)), e, x => {
      cur = .Some(x);
    });
  });
  io.await(t, io);
});
export(main);
```

`yo check` accepts it on develop (`5425cd7bf`). The same body with the await
spelled out (`e.await(yield(e), e); cur = .Some(i32(2));`) is E0911, rule 4
of decision 18.

## Root cause

Rule 4 (`local_borrow_note_await`, `src/evaluator/utils.yo`) runs at each
evaluated `await` and asks whether a borrow is live there: the await's token
must lie in the borrow's range, `(decl, end]`, in the same module. A macro's
expansion is evaluated from its `quote` template, whose tokens belong to the
macro's own source (`std/async/stream.yo` for `for_await`). The expanded
await's token is never inside a user borrow's range, so no borrow is ever
live across it. An await the user spells inside a macro argument keeps its
own token and was checked.

## Fix

The evaluator keeps the macro calls whose expansion it is evaluating
(`local_borrow_enter_macro_site` / `local_borrow_leave_macro_site` around the
expansion in `src/evaluator/calls/function.yo`; `local_borrows_truncate`
restores the list, as `comptime_expect_error` does after a throw). Rule 4
judges an await at its own token and at each of those call sites: a borrow
live at the `for_await` call is taken as live across every await the
expansion makes, and the diagnostic points at the call. This is conservative:
a borrow last used in an argument evaluated before the expansion's first
await (`for_await(cur.stream, …)` with no later use) is rejected too.

Rule 3 (a borrow of a module-level place across any call) has the same hole
for the calls an expansion makes; it is filed separately as
`issues/2026-10-17-a-module-level-local-borrow-is-not-checked-across-a-call-a-macro-expands-to.md`.

## Verification

- `tests/cli-cases/local-borrow-across-a-for-await-through-a-cell-is-e0911`:
  the symptom above is E0911 at the `for_await` call. The develop binary
  (`5425cd7bf`) checks it clean.
- `tests/cli-cases/mut-match-place-across-a-for-await-through-a-cell-is-e0911`:
  the review's case, a `mut` match place over the cursor `cur := &mut h.o`
  written inside a `for_await` loop, is E0911. The PR's first head
  (`952bbabe5`) and develop check it clean.
- `tests/match_async_arms.test.yo`, "a mut place lives across the awaits of a
  for_await loop": a place over a task-owned local stays accepted and is
  written after each real suspension.
