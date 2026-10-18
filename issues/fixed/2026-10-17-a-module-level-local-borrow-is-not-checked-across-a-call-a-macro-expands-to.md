# A module-level local borrow is not checked across a call a macro expands to

**Severity:** S2 — an invalid program is accepted: a local borrow of a
module-level place may be live across a call that a macro's expansion makes,
and that callee can reach the place by name.

Found with
`issues/fixed/2026-10-17-a-local-borrow-is-not-checked-across-an-await-a-macro-expands-to.md`
(the review of #1419), which fixed the same hole for rule 4.

**Status:** FIXED — by #1419 itself, not by a later change (verified
2026-10-18; this doc records the verification, no code change landed for it).

## Symptom

Rule 3 of decision 18 (`plans/VALUES_BY_DEFAULT.md`) rejects a borrow of a
module-level place that is live across a runtime call
(`local_borrow_note_call`, `src/evaluator/utils.yo`):

```yo ignore
y := &mut G;        // G a module-level binding
touch_g();          // E0911: touch_g can reach G by name
y = …;
```

When the call comes from a macro's expansion instead (a macro whose `quote`
template calls `touch_g()`), the call's token belongs to the macro's source,
so it never lies inside `y`'s live range and the program is accepted.

## Root cause

The same as the rule 4 hole: liveness compares the call's token with the
borrow's range in the borrow's module, and an expansion's calls carry the
macro's tokens.

## Recommendation for the fix

Judge an expansion's runtime calls at the macro call sites too, as rule 4 now
does (`g_lb_macro_sites`, `local_borrow_note_await`). Before landing, check
`yo check ./std` and `./src` for new E0911s: a module-level borrow passed to a
macro call (`mac(y)`) would then be rejected the way `f(y)` is, which is
consistent but may need sweeping. A test: a user macro (`Pragma.AllowMacroDef`)
whose template calls a function, invoked while a module-level borrow is
live, as a `check` cli-case expecting E0911.

## Resolution (verification only)

The hole this doc predicted is not constructible on develop: #1419 — the very
PR whose review filed this doc — made the MACRO CALL ITSELF a runtime call
for rule 3 (`_local_borrow_note_call_site` on every non-std, non-comptime
call, `src/evaluator/calls/function.yo`), judged at the call's own token. A
borrow live across a macro call is E0911 naming the macro call
("Cannot call `toucher` while `y` is live"), and since the expansion runs
inside that call, every runtime call the expansion makes is covered
conservatively — even an expansion that makes no runtime call is rejected,
which is stricter than this doc asked for.

Probed on a tree-built binary of develop `9fb88177f` (the mechanism is
#1419-era; the seed v0.2.65 and the develop tip agree), each rejected with
E0911:

- a user macro (`Pragma.AllowMacroDef`) whose `quote` template calls
  `touch_g()` (which reaches the module-level place by name), invoked while
  `y := &mut g_items` is live — E0911 at the macro call;
- the same with the expansion's value comptime-shaped
  (`quote({ touch_g(); i32(0) })` — the runtime call keeps the macro call's
  value unknown, so it stays a runtime call);
- the borrow passed to the macro (`usermac(y)`, the shape the doc predicted
  would need sweeping) — E0911;
- the `&` (read-only) form of the same borrow — E0911;
- `for(&mut <another module-level list>, …)` while `y` is live — E0911
  "Cannot call `for`";
- `for_await(…)` while `y` is live — E0911 (rule 4, the sibling fix);
- an `assert` reading the place while an exclusive `&mut` borrow is live —
  E0911 (rule 2 exclusivity fires first).

The narrower machinery this doc recommended (judging the expansion's own
calls at the macro call sites) would matter only if a macro call could be
SKIPPED as a compile-time call while its expansion still makes a runtime
call; every probe of that shape keeps the macro call a runtime call, so no
such program exists today. If a future change makes macro calls comptime-
skippable with live runtime calls inside their expansions, THIS doc is the
record to reopen (the fix shape is the Recommendation above).

A pin test lands with this doc (`tests/macro_def_pragma.test.yo`,
`comptime_expect_error` "a module-level local borrow is not live across a
macro call"): not a fails-before shape — every candidate is already rejected —
but the invariant this verification rests on (a macro call with a runtime call
inside its expansion is itself a runtime call) now has a guard, so a change
that makes macro calls comptime-skippable trips it instead of silently
reopening the hole.
