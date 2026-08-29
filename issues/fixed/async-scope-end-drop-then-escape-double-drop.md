# Async body: scope-end drop of a cross-boundary local, then an escape → double drop (heap-use-after-free)

**Status: FIXED** (2026-08-29, `src/codegen/exprs/rc_fns.yo` `generate_drop`).
Regression test: `tests/async_await.test.yo`
"escape after an awaiting cond branch closed does not re-drop its locals".
Surfaced by audit item C53 (chunked HTTP, #350): the Linux hollow sweep of
`tests/http/http.test.yo` crashed (`malloc(): unaligned fastbin chunk detected`,
rc=134) and AddressSanitizer reported `heap-use-after-free` in `__yo_decr_rc`
called from `_fetch_once`'s state-machine **dispose**, on an object already
freed by the same state machine's **resume**.

## Symptom

```
==3886==ERROR: AddressSanitizer: heap-use-after-free on address 0x5030000021d0
    #0 __yo_decr_rc
    #1 _file____home_temp_18513_state_dispose      ← _fetch_once's SM dispose (state == -2 sweep)
    #2 __yo_dispose_dispatch
    #3 __yo_decr_rc
    #4 _file____home_temp_18634_resume             ← the aborted parent (_fetch_follow) releasing it
freed by thread T1 here:
    #1 __yo_decr_rc
    #2 _file____home_temp_18513_resume             ← the same SM's scope-end drop
previously allocated by thread T1 here:
    #1 __yo_new___yo_t44                            ← a std/net/addr value (addrs / addr)
```

## Root cause

An `io.async` body's locals that live across an await are fields of the
state-machine struct (`sm->var_N`). Two places release them:

1. **Inline, at scope end.** When a cond branch (or any block) that awaited
   finishes, its deferred drops are emitted into the resume function —
   `__yo_decr_rc((void*)(sm->var_233603));` — and the field is left dangling.
2. **The dispose sweep.** `generate_async_block_state_dispose_function`
   (`src/codegen/exprs/async.yo`) emits `if (sm->state == -2) { if (sm->var_N
   != NULL) { __yo_decr_rc(...); } ... }` over EVERY cross-boundary local,
   because an `unwind` can leave the body at any await and dispose cannot
   know which scopes had already closed.

So a body whose scope closed and THEN escaped released the scope's locals
twice. `_fetch_once` (`std/http/client.yo`) is exactly that shape: the
transport `cond` branch owns `addrs`, `addr`, `stream` (all across awaits);
the branch ends; `parse_response(raw_response)` throws `HttpError.Other("Invalid
status line")` → `__yo_effect_escaped` → `sm->state = -2` → the parent
releases the future → dispose re-decrements the three fields.

## Why it was Linux-only in practice

Nothing platform-specific in the codegen. In `tests/http/http.test.yo` the
throw comes from the **timed-out** fetch of "fetch throws Timeout when the
server never answers": `fetch_with` aborts the request task, but the nested
`_fetch_once` state machine stays live with a `recv` in flight; when the
silent server closes ~400 ms later the read completes with 0 bytes, the empty
response fails to parse, and the whole chain above runs. On macOS `main` had
already returned and the process exited before that point; on Linux the
runtime stays alive while any I/O is pending, so the resume happened. A
server that answers with a garbage status line reproduces it on macOS too
(`issues/repros/linux-post-timeout-hang.yo` phase 3 under GuardMalloc: rc=139
in `__yo_decr_rc`).

## Fix

`generate_drop` (`src/codegen/exprs/rc_fns.yo`): when the dropped value is a
state-machine field (`context.in_async_state_machine` is set and the operand
renders as `sm->var_…`), the inline drop is followed by
`memset(&(sm->var_N), 0, sizeof(sm->var_N))`. Every dispose guard (`!= NULL`,
`.data != NULL`, the enum tag switch) then sees an empty slot, so the sweep is
idempotent for every field shape. One site, no per-caller patching (the
emitters of branch remainders, loop iterations and last-segment completion
all render drops through this hook).

## Not the same bug

- The Linux **hang** of the chunked test in the same sweep was a different
  runtime bug — the event loop blocking on unrelated I/O after completing the
  awaited future: `issues/fixed/event-loop-blocks-after-completing-the-awaited-future.md`.
  This crash was the second failure hiding behind it.
- C56 (`issues/io-await-effect-bundle-ignored-inside-io-async.md`) is about
  which handler a throw reaches; this is about what happens after it does.
