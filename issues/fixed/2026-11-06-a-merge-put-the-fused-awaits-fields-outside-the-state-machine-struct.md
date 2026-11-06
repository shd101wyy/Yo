# A merge put the fused await-site fields outside the state-machine struct

**Severity:** S1 — invalid C: the single-pass async emitter closed the state-machine struct before the fused-site fields were emitted, so every use of a `__fz*` field in the resume function failed to compile in C. Introduced (and removed again) inside the `vbd/v5-part-b-s-env` merge of develop `8d475cd81`; it never reached another branch.

## Symptom

Compiling anything with a fused await site (an `io.async` wrapper inlined into its
caller, `plans/backlog/ASYNC_AWAIT_SITE_FUSION.md`) with the mis-merged compiler:

```
error: ‘_file_..._state_t’ {aka ‘struct _file_..._state_t_struct’} has no member named ‘__fz507515_live’
error: ‘_file_..._state_t’ {aka ‘struct _file_..._state_t_struct’} has no member named ‘__fz507515_capture’
```

Two gates caught it before any merge to develop:

- `tests/internal/build_runner.test.yo` — the batch failed to compile in C (18/18 tests reported failed). That batch is the failing test: it fails at ea0523d30's parent (`996c75edc`) and passes at `ea0523d30`.
- The byte-identical-C gate (base `src/main.yo` compiled by the develop-tip base binary vs this branch's binary): 104 differing lines, every one a moved `};` — the fused fields and the named locals' move flags after the struct's close instead of inside it.

## Root cause

`src/codegen/exprs/async.yo` emits the state-machine struct field by field and then
calls `_emit_fused_site_fields` — INSIDE the struct — before `emit_declaration_line("};")`
(develop's order, #1803). The merge resolution kept the branch's two closing lines
(`};` and the blank) ahead of develop's call, so the declaration buffer received the
fused-site fields and the `__yo_mv_*` move-flag lines after the struct had already
closed. The conflict had both sides touching adjacent lines, and the branch side
(`context.base.emitter.…`, un-aliased) was combined with develop's insertions in the
wrong order.

## Fix

`ea0523d30` restores develop's emission order: `_emit_fused_site_fields(...)` first,
then the struct close, then the `_init_move_flags` function. Verified by the two gates
above (byte-identical C restored; `build_runner.test.yo` 18/18).
