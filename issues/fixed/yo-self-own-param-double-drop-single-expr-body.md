# yo-self: own-param scope-end drop emitted twice for single-expression bodies (CI glibc double-free)

**Status:** FIXED — CI-confirmed (run 31159772012 fully green on 5e4b81186, including the previously-failing glibc tier-1 gates job).

## Symptom

CI run 31152874454 (commit `f017aaf23`, "Self-hosted `test` subcommand
(yo-self tier-1 gates)") failed:

```
FAIL: battery ref_field_borrow rc=1
  ✗ "ref and own arguments of distinct objects are allowed"
  tcache_thread_shutdown(): unaligned tcache chunk detected
```

Locally (macOS) the same battery passes even under `MallocScribble` — glibc's
tcache integrity check catches the double-free, macOS malloc does not. So the
failure is real but CI-only in presentation.

## Root cause

`f017aaf23` added the own-param scope-end drop pass (begin.yo's params-frame
merge, the yo-self arm of `issues/fixed/own-param-discard-leak.md`). For a
**block** body that is correct. For a **single-expression** body
(`use_and_sink :: (fn(inout(x) : String, own(victim) : Holder) -> usize)((x.len)())`),
yo-self reuses the inner expression's node id for the begin result (TS clones a
begin wrapper — begin.ts:1016-1045), so the merged param drop lands on the
**same node as the tail call**. Two codegen consumers then each flushed the
node's `deferred_drop_expressions`:

1. the non-begin body path's flush-first (`codegen/functions/generation.yo:336`)
   — **before the body**, and
2. the call generator's post-emit flush (`other_fn_call.yo`, TS
   other-fn-call.ts:1511) — after the call.

Emitted C (self-hosted, vs TS's single drop):

```c
static inline size_t yo_id_6171(__yo_t9* x, __yo_t13* victim) {
  __yo_decr_rc((void*)(victim));            // flush-first — early AND duplicate
  size_t _t = yo_id_3476((*x));
  __yo_decr_rc((void*)(victim));            // post-call flush — correct one
  return _t;
}
```

Before `f017aaf23` this was latent: the only drops ever attached to a
single-expression body node were the call's own **arg-temp** drops, which the
flush-first skips via the undeclared-temp gate. Param drops target declared C
parameters, so they sailed through both flushes. The early emission is also a
UAF-in-waiting on its own: a body that reads the own param
(`(v.s.len)()`) would read after the drop.

## Fix — param-drop ownership split (codegen)

Param-targeted drops are function-scope; only function-level emission points
may emit them. Expression-level flushes never do.

- `codegen/exprs/drop_dup.yo`: `generate_deferred_drop_expressions` gains
  `(skip_param_drops : bool) ?= false, (only_param_drops : bool) ?= false`,
  with `_drop_target_is_parameter` resolving the drop target atom's innermost
  env binding (`is_parameter`).
- Expression-level flushes pass `skip_param_drops = true`: all 13
  `other_fn_call.yo` post-emit flush sites and the two whole-match-node
  flushes (`match.yo:553/1106`). Arm-begin flushes (match.yo:374, cond.yo:526)
  keep unfiltered — arm begins never carry param drops
  (`is_evaluating_function_body_begin_block` is false there).
- Non-begin body path (`functions/generation.yo`): flush-first skips param
  drops; a unit non-binding tail flushes params-only AFTER the statement; the
  stmt-binding tail keeps its unfiltered after-flush (assignment emitters do
  not flush node drops).
- `generate_implicit_return_statement` (`return.yo`) emits params-only at the
  correct point per tail shape: Atom — after the tail dup, before `return`;
  plain call/match/cond — after the tail's statements, before `return`;
  `unwind` tail — before the unwind code; `return(...)` tail — covered by
  `generate_return`'s own unfiltered node flush.
- The begin path (block bodies) is untouched: its body-level flushes stay
  unfiltered, and statement calls inside a block never carry param drops.

Known accepted gap: on an early-`return` path nested inside a match/cond tail
of a single-expression body, param drops are not seeded into
`pending_deferred_drops` (leak, not corruption); same class as before the
own-param pass existed.

## Verification

- `tests/ref_field_borrow.test.yo` 12/12 under the fixed stage-1 binary; the
  emitted C for `use_and_sink` shows exactly one `__yo_decr_rc(victim)`, after
  the call — matching the TS emit.
- Per-function dup/drop count diff vs TS emit for the batch (emit-diff gate).
- Full battery + corpus + `check ./std` + stage-2/3 fixpoint.
