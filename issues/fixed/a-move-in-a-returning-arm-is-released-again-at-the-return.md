# A move in a returning arm is released again at the return

**Found:** 2026-09-26, running the Phase 5 test binaries of `plans/TYPE_SYSTEM_SOUNDNESS.md` under
`libgmalloc` (the sanitizer substitute on this machine). **Severity:** CRITICAL (a double release in
safe code). **Status:** FIXED on `tss/phase5` before it merged; develop never had it.

## Reproducer

```rust
PBox :: ref(struct(tag : i32));
sink :: (fn(own(b) : PBox) -> i32)(b.tag);
early_return :: (fn(c : bool) -> i32)({
  b := PBox(tag : i32(5));
  if(c, {
    return(sink(b));
  });
  (b.tag + i32(1))
});
```

`early_return(true)` crashed (SIGBUS without, SIGSEGV under `libgmalloc`). The emitted C released
`b` at the early return after `sink(b)` had taken it:

```c
int32_t t = sink(b);
// Drop local variables before early return
__yo_decr_rc((void*)(b));
return t;
```

On develop the same program is rejected (`b` counts as moved after the branch), which is what
Phase 5.1 fixed.

## Root cause

Phase 5.1 keeps a returning arm's move from reaching the code after the branch. The flow log
restores `b`'s shared `Variable` to its pre-branch state: at the start of the next arm
(`reset_sibling_flow_state`), and at the join for arms that do not reach it. Codegen decides the
drops at a cleanup point (an early `return`, an effect escape after a call) afterwards, from the
same `Variable`'s single `consumed_at_token`. By then that token no longer shows the move, so the
return inside the arm released `b` again.

The Phase 5 test counted Dispose calls and passed: a second release of an already-freed object
never reaches `dispose`.

## Fix

A move the flow log undoes is kept on the variable as an `UndoneMove`: the move's token, and the
last token of the arm that made it (`variable_record_undone_move`, `src/env.yo`). The records
are made by `reset_sibling_flow_state` for the previous arm and by `keep_last_arm_moves` for the
last arm. Codegen's cleanup-point check (`_variable_moved_before_cleanup_point`,
`src/codegen/exprs/return.yo`) treats the value as moved at a point after the move and inside
that arm. A sibling arm, and the code after the branch, are outside it and still own the value.

## Tests

`tests/type_soundness.test.yo` "soundness: the returning arm releases its moved value once". A
keeper list holds one more reference, so a second release disposes the box early; it fails
before the fix. The Phase 5 test binaries run clean under `libgmalloc`.
