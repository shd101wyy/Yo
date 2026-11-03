# A borrowed `for` loop through a cell is not checked across an `await` in its body

**Severity:** S3: a static rule gap. Decision 18 rule 4 says a borrow of a place that passes through a reference cell may not be live across an `await`. The loop's hidden borrow broke that rule and was never reported. The run-time borrow flag the loop holds (`__borrow_guard`) still makes a conflicting write from another task panic deterministically, so nothing reads freed memory. The program is accepted when it should be rejected.

**Status:** FIXED 2026-11-02 by macro plan B1 (`plans/backlog/MACRO_AND_ISO_REMOVAL.md` Part B, branch `vbd/macro-b1-for-desugar`). Found while gating that desugar.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ yield } :: import("std/async");
Holder :: ref(struct(items : ArrayList(i32)));
main :: (fn(io : Io) -> unit)({
  h := Holder(items : ArrayList(i32).new());
  h.items.push(i32(1));
  t := io.async((e : Io) => {
    for(&mut h.items, x => {
      x = (x + i32(1));
      e.await(yield(e), e);
    });
  });
  io.await(t, io);
});
export(main);
```

`yo check main.yo` on develop `6b30f9107` reports no error. The loop's borrow `c := &mut h.items` is live for the whole loop, and the walk reads the next element through it after the task resumes, so the `await` is inside its live range. Writing `cur := &mut h.o; …; e.await(…); cur = …` by hand is E0911 (`tests/cli-cases/local-borrow-across-an-await-in-a-loop-through-a-cell-is-e0911`).

## Root cause

The prelude's `for` macro declares the hidden borrow in its own quote template, so the borrow's declaring token is in `std/prelude.yo`. `local_borrow_register` gives such a borrow the macro call's extent (`_lb_macro_site_of`). Rule 4's check, `local_borrow_note_await` → `_lb_first_site_in`, compares the await's token against the borrow's `(decl, end]` range only when both tokens are in the same module. A prelude-module `decl` never matches an `await` the caller wrote, so the borrow was never judged. The element `x`, which the caller names, was judged, but only while `x` was still used after the `await`.

## Fix

B1 desugars `for(...)` at parse time (`desugar_if_calls` → `_desugar_for_call`, `src/expr.yo`). Every node the desugar builds carries a token at the `for` call's position in the caller's module, so the hidden borrow is an ordinary caller-module local borrow. `local_borrow_register` gives it the whole loop as its extent: the site is recorded in `g_for_desugar_sites` and looked up with `for_desugar_site_of`. Rule 4 now sees the `await` inside that range. The message names the loop: `_lb_raise_across_await`'s note "this `for` loop borrows `h.items` for its whole extent (its hidden local `for_coll0`)".

## Test

`tests/cli-cases/borrowed-for-through-a-cell-across-an-await-is-e0911` checks the program above. It fails before the fix (rc 0, no E0911) and passes after.
