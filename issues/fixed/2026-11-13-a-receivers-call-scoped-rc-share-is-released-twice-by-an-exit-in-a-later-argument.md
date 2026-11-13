# A receiver's call-scoped `Rc` share is released twice by an exit in a later argument

**Severity:** S1. A regression from #1924 (6c90536aa): a heap-use-after-free in accepted code, and develop's battery went red on
every platform's shard 0, wasm and the self-hosted hollow sweep. An exit (`break`, `continue`, `return`) inside a later argument of a method call
whose receiver is read through an `Rc` (`hs(usize(0)).peek_k(cond((i == i32(3)) => break, true => i), …)`) released
the share the caller takes on the receiver's handle twice. The cell was freed while the list still held it, and the next
`hs(usize(0))` read (`__yo_incr_rc`) touched freed memory.

## Reproducer

`tests/rc.test.yo`, "an exit from a later argument releases the share a receiver took through an Rc" (added by #1573),
under the test runner's ASan:

```text
==…==ERROR: AddressSanitizer: heap-use-after-free … READ of size 4
    #0 in __yo_incr_rc
freed by thread T1 here:
    #1 in __yo_rc_free
    #2 in __yo_decr_rc
```

The emitted C of `_rcv_exit_loops`, at the `break`:

```c
__yo_t_… share = __yo_incr_rc(*__yo_fs_…(&__yo_v_hs, 0ULL));   // the call-scoped share
…
if (((__yo_v_i) == (3))) {
  __yo_decr_rc((void*)(share));     // #1573's pending share drop
  __yo_decr_rc((void*)(share));     // #1924's M3 exit drop: the second release
  break;
}
```

## Root cause

#1924 (`issues/fixed/2026-11-11-a-temporary-argument-leaks-when-a-later-argument-returns-continues-or-unwinds.md`) taught
the M3 exit walk (`_m3_operand_moves_variable`, `src/evaluator/exprs/begin.yo`) that a temporary minted for an operand
is moved by the call, wherever its move is recorded. It did not check whether that temporary is a call-scoped share
(`mark_call_scoped_share_dup`). Aliasing Stage 0's caller-owned +1 of a borrowed receiver is "consumed at the dup by
design": the call borrows it, and the post-call flush releases it. #1573 already keeps that release pending for every exit in the
later arguments (`_call_share_drops_to_pend`, `src/codegen/exprs/generation.yo`). The M3 walk then attached a second
drop of the same temporary to the exit. The tests #1924 added cover by-value (moved) temporaries only.

## Fix

`_m3_operand_moves_variable` declines an operand that carries a call-scoped share dup
(`_m3_operand_carries_call_scoped_share`): the call does not move that temporary. The `return`/`break`/`continue` walk
and the `ArgMoveRegion` escape gate both go through this predicate, so the region is no longer recorded for a share either.

**Regression test:** `tests/rc.test.yo`, "an exit from a later argument releases the share a receiver took through an
Rc" (fails on 6c90536aa and passes with the fix). The A45 tests in `tests/move_only.test.yo` still pass.
