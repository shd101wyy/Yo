# `comptime_expect_error(expr, "text")` never checked `text`, so cases went green on unrelated errors

**Status: FIXED 2026-09-25** (found during Phase 2.7 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

**Severity: test-suite soundness.** The second argument was used only as the message printed when
the expression raised NO error. When an error was raised, any error passed. 94 cases across 9
files passed a diagnostic's text as the second argument, and `tests/type_soundness.test.yo`'s
header claimed that this stops a case from going green on an unrelated error. It did not.

**Found** 2026-09-25: a red probe that changed an expected text to `"... ZZZ"` stayed green.

## Fix

- `comptime_expect_error` records the text of every error observed while it evaluates the
  expression. Both channels record it: the local `throw` handler, and the def-time swallow's
  observation channel in `flowability.yo`.
- When a second argument is given, one recorded error must contain it. Otherwise the call fails
  with `the expression raised an error, but not the expected one` and prints both texts.
- The text compared is the diagnostic's message plus its help (`error_message_text` in
  `src/error.yo`), never the rendered source excerpt. An error anchored on the
  `comptime_expect_error(..., "text")` line would otherwise quote the expected text back and
  match itself, which is what the first cut of this fix did.

## What the check found

14 cases in 6 files had been matching a different error than the one they named:

| File | Case | What happened |
| --- | --- | --- |
| `tests/iso.test.yo` (4) | moved value, non-owning isolate | Text drift: the messages gained backticks or were reworded. The right errors. |
| `tests/closure.test.yo` (3) | Impl reassignment, branch closures | Text drift. The right errors. |
| `tests/type_soundness.test.yo` | comptime_str argument | Capitalization: `incompatible types`. |
| `tests/fn.test.yo` | outer local in a `fn` literal | Expected a removed message. A `fn` literal does not capture, so E0401 "not found" is the documented error. |
| `tests/basic.test.yo` (2) | initialize an outer variable | The assignments sat inside `fn` literals, which cannot see the outer variable at all, so the rule under test never ran. Rewritten with closures, which reach it. |
| `tests/basic.test.yo` (2) | nominal struct mismatch | One case expected the never-real text `error: type Mismatch` and passed on a SYNTAX error (`:=` with a type annotation). Rewritten to test the mismatch. |
| `tests/basic.test.yo` (2) | dereference `*void` | Expected a removed message. |

The rewrite exposed an internal message, `(2) Failed to evaluate the tuple fields. Expected type
to be: Point1`, for a tuple literal assigned to a struct type. Both messages in that function are
now coded E0601 "Incompatible types" diagnostics (`src/evaluator/values/tuple.yo`).

`tests/spec/contracts_phase0.test.yo`'s "label the return" case expects text that lives in the
diagnostic's help, which is why help is part of the compared text.

## Verification

- A red probe (`"Yo does not upcast Dyn ZZZ"` in `tests/dyn.test.yo`) fails, naming both texts.
- All 9 files with 2-argument cases pass.
- The fast suite passes.
- `.github/instructions/testing.instructions.md` and the syntax and workflow cheatsheets document
  the checked form.
