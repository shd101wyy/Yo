# Evaluator diagnostics are flattened to strings before the typed stash, so structured consumers get nothing

**Status:** OPEN. **Found:** 2026-09-17, building `yo fix`
(`plans/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` §2). **Class:** a structured
channel that exists, is populated for one error class, and is silently empty
for the most common one.

## Symptom

`take_error_diagnostics()` after a failed `mm_load_file` returns the
diagnostics for a PARSE error and nothing for an EVALUATOR error, even though
`yo check` renders the evaluator error perfectly.

Measured with a tree-built compiler, `YO_DEBUG_FIX=1 yo fix <file>`:

| file's error | typed diagnostics retrieved |
| --- | --- |
| `x := 1 && 2 && 3;` (E0003, parse) | **1** — `span.path` correct, message correct |
| `_t := (countr + i32(2));` (E0401, evaluator) | **0** |

`yo check` on the second file prints
`error[E0401]: Variable "countr" not found.` with its span, and
`--error-format json` emits the full structured object including the repair —
because the TEXT is rendered early (`render_any_error`, which is mode-aware)
and then carried as a string.

## Root cause

An error raised inside a top-level definition's body is caught by the
def-time trial / lazy-binding machinery, **rendered to text**, and re-thrown
as a plain (non-`YoError`) error:

- `src/evaluator/values/anonymous_module.yo:178` —
  `_flag_force_failure(render_any_error(_err))` stores the rendered TEXT.
- `src/evaluator/context.yo:1110` — `PendingDef.failure : Option(String)`; set
  from that text at `:2177`.
- `src/evaluator/context.yo:2290` and
  `src/evaluator/values/anonymous_module.yo:292` — re-thrown as
  `PendingResolution.Error(String)` / `exn.throw(dyn(<string>))`.
- `src/evaluator/exprs/identifer_and_operator.yo:258` —
  `exn.throw(dyn(pending_msg))`, the same flattening on the identifier path.

By the time `_eval_module_exprs_capturing_error`
(`src/module_manager.yo:1513`) calls `stash_error_diagnostics(err)`, the
`downcast(err, YoError)` fails, so nothing is stashed.

## Who this breaks

- **`yo fix`** cannot apply a repair the compiler already computed — the
  rename for a misspelled name is visible in `--error-format json` and
  unreachable to the tool. It now says so explicitly rather than reporting
  "nothing to fix".
- **The LSP's typed diagnostics channel** (`src/lsp/diagnostics.yo:558` reads
  the same stash) gets nothing for evaluator errors; it works only because it
  installs its own handlers.
- Any future consumer that wants codes/spans/repairs rather than text.

## What does NOT work as a shortcut

Reading the §3 swallowed-cause stash (`peek_swallowed_diagnostics`) instead.
Tried and rejected: a normal evaluation swallows many internal trial
failures, so its most recent entry is routinely unrelated — it offered
`check_if_function_parameter_matches_argument: arg has no ExprInfo` from
`std/prelude.yo` for a file whose actual error was an undefined name. §3's
attempt-counter guard exists precisely to prevent that, and bypassing it is
how you get `fix` acting on the wrong diagnostic.

## Fix

Carry the diagnostics alongside the text through the pending-definition path:
add `failure_diagnostics : Option(ArrayList(Diagnostic))` to `PendingDef`,
populate it where `_flag_force_failure` renders, and re-throw the original
`YoError` (or a `YoError` rebuilt from it plus the "was evaluated here
because…" note) instead of `dyn(<string>)`. The note that is currently
appended to the text becomes a `Severity.Note` diagnostic, which is what the
renderer already expects.

Gate it with: `yo fix` applying a rename end to end, the LSP typed-diagnostic
test, and the full suite (error paths are where the fixpoint is sensitive).
