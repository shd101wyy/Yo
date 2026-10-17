# A module-level local borrow is not checked across a call a macro expands to

**Severity:** S2 — an invalid program is accepted: a local borrow of a
module-level place may be live across a call that a macro's expansion makes,
and that callee can reach the place by name.

Found with
`issues/fixed/2026-10-17-a-local-borrow-is-not-checked-across-an-await-a-macro-expands-to.md`
(the review of #1419), which fixed the same hole for rule 4.

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
