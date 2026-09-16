# FIXED: evaluator diagnostics were flattened to strings before the typed stash

**Status:** FIXED 2026-09-17. **Found:** 2026-09-17 building `yo fix`
(`plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` §2). **Class:** a structured
channel that exists, is populated for one error class, and is silently empty
for the most common one.

> **This issue's ORIGINAL ROOT-CAUSE SECTION WAS WRONG, and that is the most
> reusable thing in it.** It blamed the lazy-binding / pending-definition path
> and prescribed carrying diagnostics on `PendingDef` plus re-throwing from
> `resolve_pending_definition`. Implementing that would have written plumbing
> for a path this error never takes, and it would have reviewed as reasonable.
> The wrong diagnosis is preserved at the bottom.

## Symptom

`take_error_diagnostics()` after a failed `mm_load_file` returned the
diagnostics for a PARSE error and nothing for an EVALUATOR error, even though
`yo check` rendered the evaluator error perfectly and `--error-format json`
emitted the full structured object *including the repair*.

| file's error | typed diagnostics |
| --- | --- |
| `x := 1 && 2 && 3;` (E0003, parse) | **1** |
| `total := (countr + i32(2));` (E0401, in a fn body) | **0** |

## Root cause (measured, not reasoned)

**The def-time trial**, `_trial_eval_fn_body` in
`src/evaluator/calls/function_type.yo`. Its swallow handler renders the error
to TEXT — `_flag_trial_swallow(_err.to_string())` — and the re-raise at the
`ts_fatal_msg` site throws that string. So an error raised inside a definition
BODY arrives at `_eval_module_exprs_capturing_error` as a plain error,
`downcast(err, YoError)` fails, and `stash_error_diagnostics` stores nothing.

`to_string()` on a `YoError` goes through the mode-aware renderer, which is why
the flattened text is a *fully rendered* diagnostic and reads as if nothing was
lost.

### How it was found, after three wrong turns

A gated hook on the channel itself (`YO_DEBUG_DIAGSTASH`, still shipped:
STORE / DROP / TAKE in `src/error.yo`) showed **one DROP and a TAKE of
nothing** — so the diagnostics were never STORED, not stored-and-lost. That
killed the overwrite theory. Then **all eleven candidate flatten sites were
instrumented at once and none fired**, while the error still arrived rendered,
which pointed outside every path that had been read.

Three eliminations along the way were each individually sound and collectively
a waste of two builds, because they narrowed by inference between probes:

- every pending-path message appends a "was evaluated here because…" note, and
  this error has none — so not the lazy-binding path;
- the walk-abort channel stores the error OBJECT and re-throws the original, so
  it preserves the type;
- all four `format_error_*` helpers return `YoError`, so the original throw is
  typed.

**Lesson: probe before building, and when a probe comes back ambiguous, WIDEN
the probe rather than resume reading.** Instrumenting all eleven at once cost
one build and ended the search.

## Fix

`src/evaluator/calls/function_type.yo` keeps a `g_trial_swallow_diags` beside
`g_trial_swallow_msg`, written by `_flag_trial_swallow_diags(err)` and cleared
by the same `_clear_trial_swallow()`. The re-raise reads it *before* the clear
and throws `yo_error_from_diagnostics(...)` (new, `src/error.yo`) when present,
falling back to the text when the swallowed error carried none.

**Kept in lockstep deliberately.** A separate channel read independently is how
a re-raise inherits an unrelated earlier failure's diagnostics — the staleness
class §3's attempt counter exists to prevent, and the reason the
swallowed-cause stash was rejected as a shortcut for `yo fix` (a normal
evaluation swallows many internal trial failures, so its latest entry is
routinely unrelated).

## The second bug this surfaced

Applying a repair made `yo fix` take a SECOND pass for the first time, and pass
2 failed inside std with `Cannot unify incompatible struct types:
"ArrayList(u8)" and "ArrayList(u8)"` — identical names on both sides.

`clear_module_cache()` is a HALF reset and does not clear
`g_cached_prelude_env`, so pass 2 re-evaluated `std/string/string.yo` from
source against a prelude from pass 1, and the unify guard in
`src/evaluator/types/synthesizer.yo` compares **ids**, never names. Identical
names is the signature of an id/era split. Two sessions converged on this
mechanism independently, each by reading a different side.

Fixed in `run_fix` by pairing `mm_clear_prelude_env()` + a re-preload with the
per-pass `clear_module_cache()`, exactly as the warm-compile path does. That is
knowingly the same HALF measure as that site: the prelude env is the biggest
thing surviving the half reset, not the only one (the struct-field and func
registries and the id-keyed `expr_info` tables survive too), and the complete
answer is the owner-tagged per-compile registry purge that
`plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md` §7 step 1 owns.

## Who this unblocks

- **`yo fix`** applies a rename end to end: `countr` → `counter`, and the file
  then evaluates. Pinned by `tests/cli-cases/fix-applies-an-evaluator-rename`,
  whose `expected_tree` holds the REWRITTEN file, so it fails if `fix` claims
  success without editing. The old case keeps the truthful-limit assertion with
  a fixture that genuinely has no unique repair.
- **The LSP's typed diagnostics channel** reads the same stash.

---

## APPENDIX: the original, WRONG root cause (kept deliberately)

> An error raised inside a top-level definition's body is caught by the
> def-time trial / lazy-binding machinery, rendered to text, and re-thrown as a
> plain error: `anonymous_module.yo:178` `_flag_force_failure(render_any_error(_err))`,
> `context.yo` `PendingDef.failure : Option(String)`, re-thrown as
> `PendingResolution.Error(String)` / `exn.throw(dyn(<string>))`, and
> `identifer_and_operator.yo:258`.
>
> **Fix:** add `failure_diagnostics : Option(ArrayList(Diagnostic))` to
> `PendingDef`, populate it where `_flag_force_failure` renders, and re-throw
> the original `YoError` instead of `dyn(<string>)`.

Every site named above is real and does flatten, and a slice-2 change even
added a `stash_error_diagnostics` call at the `_force_eval` handler for that
reason. **None of them is on the path this symptom takes**: the measured
reproducer never forces the definition at all (`YO_DEBUG_LAZY` shows only an
unrelated prelude force). The prescription was plausible, specific, cited real
line numbers, and was aimed at the wrong mechanism.
