# A failed prelude load prints its diagnostic and then continues, so the same fault is reported twice

**Status: FIXED 2026-09-09** (`src/module_manager.yo`, `src/main.yo`).
Found while adding the integer bit batteries to `std/prelude.yo`, whose extra
530 lines moved WHERE the evaluator deadline trips and made this visible.

## Symptom

```
$ yo compile main.yo --compile-timeout-ms 1 --emit-c --skip-c-compiler
Yo compilation exceeded the configured time limit (possible evaluator hang). See issues/fixed/test-runner-no-compile-timeout.md.
Yo compilation exceeded the configured time limit (possible evaluator hang). See issues/fixed/test-runner-no-compile-timeout.md.
```

Two identical lines, no context distinguishing them. Reproduced 3/3 on an idle
machine; the control — the same binary built from a tree whose prelude was NOT
enlarged — printed it once, which is what
`tests/cli-cases/compile-timeout`'s golden records.

## Root cause

`mm_preload_prelude` printed the prelude's diagnostic and **fell through**:

```rust
if(!pre_outcome.ok, {
  match(
    _take_load_error(),
    .Some(rendered) => eprintln(rendered),
    .None => eprintln(`check: error in: ${std_path}/prelude.yo`)
  );
});
```

Its own comment said "a prelude that fails to evaluate is the ROOT cause of
everything that follows" — and then the caller carried on. The compile path
walked straight into `mm_eval_entry_exprs`, which failed for the SAME reason
and printed the rendered error a second time via `_take_load_error()` /
`emit_rendered_text`.

The deadline made it deterministic rather than causing it: the cooperative
deadline is LATCHED (`_g_eval_deadline_tripped`, `src/evaluator/exprs/_expr.yo`)
so that a swallowing handler cannot outrun it — every later dispatch rethrows.
So once the prelude trips it, the entry eval is guaranteed to trip too. With the
smaller prelude the 1 ms budget expired AFTER the prelude finished, so only the
entry eval ever reported it and the duplication never showed.

**It is not specific to the deadline.** Any prelude that fails to evaluate —
a syntax error, an unbound name, a broken `impl` — took the same path.

## Fix

`mm_preload_prelude` now returns `bool`, and the caller decides:

- `compile`, `check` and `verify` (`src/main.yo`) exit 1 immediately, adding no
  words of their own — the diagnostic is already on the stream.
- `src/lsp/diagnostics.yo` deliberately ignores the result and keeps
  degrading: a language server must not die because the prelude is broken, it
  must surface the stashed error as a diagnostic. That is exactly why the
  decision cannot live inside the helper, and the one ignoring call site says so
  in a comment.

## Gate

`tests/cli-cases/compile-timeout` goes back to matching its recorded single
line, with no golden re-record — which is the point: the golden was right and
the behaviour was wrong.
