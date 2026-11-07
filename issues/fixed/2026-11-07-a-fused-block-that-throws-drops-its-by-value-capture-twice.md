# An escape inside a fused await site releases the caller's values through the wrapper's names

**Severity:** S1: double frees and heap-use-after-free in emitted code, from safe code, on the default (fused) lowering. Any escape inside a fused await site (a throw in the wrapper's block or prologue, or an effect that unwinds) ran the CALLER's escape-path drops. Inside the site those drops render through the wrong scope. A caller temporary that the fused call had already handed to the wrapper was freed again by the state machine's dispose. A temporary that an earlier statement had already released at its own end was freed a second time. A prologue throw leaked the wrapper's argument.

Found 2026-11-07 by an extra test written for `issues/fixed/2026-11-07-a-fused-await-reads-the-callers-match-binding-of-the-wrappers-name.md` (#1817). Before #1817 that test failed with the wrong thrown message; after it, with a double free. Narrowing that one symptom showed the general defect below. (The file name records the first symptom.)

## Symptoms

Six tests in `tests/async/fusion.test.yo` fail on develop `e91a5bfc0` (#1817's stage 1): 18 passed, 6 failed.

- `a throw in a fused block releases the call's argument once` (match arm, loop body, nested block): ASan `attempting double-free` of the wrapper's by-value argument. The caller's resume frees it at the escape, and the dispose frees it again through the site's capture.
- `a throw fused after an earlier await releases each caller temp once`: a double free of a caller temporary that an earlier statement had already released.
- `a failed rename fused after an earlier await releases each caller temp once`: a heap-use-after-free on the same shape. This is the compiler's own `src/fetch.yo:957`, a rename that fails while installing into the store.
- `a throw in a fused wrapper's prologue releases its argument`: an LSan leak of the argument (clean with `YO_ASYNC_FUSION=0`).

```text
ERROR: AddressSanitizer: attempting double-free on 0x77a829fe0010 in thread T1:
    #1 _file____home_temp_103041535180771482801_state_dispose
0x77a829fe0010 is located 0 bytes inside of 3-byte region
freed by thread T1 here:
    #1 _file____home_temp_103041535180771482801_resume
```

**Note (2026-11-08):** the `failed rename` case moved to `tests/async/sm_ownership.test.yo`, which WASI skips. WASI has no `rename`, and the import alone made every batch of `fusion.test.yo` fail to instantiate on the `wasm32-wasip1` leg. The moved case still fails on #1817's stage 1 (heap-use-after-free) and passes with the fix.

## Reproducer

The wrapper of the first three tests:

```yo ignore
_throws_taking :: (fn(sink(name) : String, io : Io) -> Impl(Future(usize, IoExn)))(
  io.async(e => {
    r := e.io.await(_leaf(i32(1), e.io), e.io);
    cond(
      (r > i32(0)) => e.exn.throw(dyn(Boom(msg : name.clone()))),
      true => name.len()
    )
  })
);
```

It is awaited as `e.io.await(_throws_taking(String.from("arg"), e.io), e)` inside a match arm, a `while` body, or a nested `{ … }` block.

**A test-writing trap.** The temporary shapes reproduce only when the wrapper is defined in another file, or BELOW its caller in the same file. The escape lists order a drop against a consumption by comparing source tokens (`_variable_initialized_after_cleanup_point`), so a wrapper defined above its caller hides the drop. Five pure-Yo probes stayed clean for that reason; the new tests keep their wrappers below the caller on purpose.

## Root cause

A fused await emits the awaited wrapper's parameters, prologue, capture construction and `io.async` block inline, in the CALLER's resume function (`emit_fused_await`, `src/codegen/exprs/async.yo`). The caller's two escape-drop lists, `pending_deferred_drops` and `consumed_var_pending_drops`, stayed in force for that span, so every escape point inside the site emitted the caller's drops. In that span:

- `state_machine_variables` is swapped to the site's, so a caller temporary rendered as its bare C local, with no slot read and no zeroing;
- `emitted_deferred_drop_ids` is swapped to an empty set, so a drop already emitted at its own statement's end was emitted again;
- the drop of a value the fused call had moved into the wrapper's capture survived, because the list's token ordering compared a position in the wrapper's source against one in the caller's.

The result is a double free against the dispose, or a use-after-free of an earlier statement's temporary. At an ORDINARY await the same escape happens in the wrapper's own state machine, whose lists hold only its own values. The caller's resume emits no drops when the awaited future aborts; the dispose releases what the caller owns at `state == -2`.

#1817's filter (`_drops_outside_arms`) removed only the caller's arm bindings from the two lists, and a first attempt at this fix extended the filter to the call's arguments. Both treated symptoms of one scope error.

## Fix

In `src/codegen/exprs/async.yo`, the caller's escape lists leave the fused site together with the rest of the caller's scope:

- `_enter_wrapper_scope` (replacing #1817's `_leave_caller_arms`) takes the match-arm state AND both escape lists out for each of the two parts emitted in the wrapper's scope; `_back_to_caller_scope` restores them.
- The prologue runs under the wrapper body's OWN lists (`deferred_drop_expressions()` and `expr_info_consumed_variable_drop_expressions`), as a call does: a prologue escape releases the wrapper's parameters, which the block has not taken yet.
- The block's pending list starts empty and holds only the block body's own drops, which is what `generate_async_block_resume_function_inline` gives a non-fused block.
- `_drops_outside_arms`, `_copy_expr_list` and the `get_deferred_drop_target_atom_name` import are deleted; the file is 23 lines shorter.

This replaces #1817's per-name filter rather than adding to it.

## Verification

- `tests/async/fusion.test.yo` (24 tests): 18 passed and 6 failed on #1817's stage 1 (`e91a5bfc0`; the six above); 24/24 with the fixed stage 1, including #1817's five arm-binding tests. `a throw after a real suspension in a fused block reaches the caller's handler` passes before and after: it is a guard, not a witness.
- Classified emit-diff of the compiler's own C (develop `e91a5bfc0`'s `src/main.yo`, `--optimize 2 --emit-c`, base vs fixed stage 1; 137,880,419 → 137,837,417 bytes): 46 hunks, every one classified.
  - 42 removals: the caller's escape-path drops inside fused sites (caller temporaries and their fields, and caller slots with their `memset`). Where a block emptied, its comment and the redundant `__yo_effect_escaped = 1;` inside the `if (__yo_effect_escaped)` guard go too. Each block now matches an ordinary await's abort path.
  - 2 changes: a prologue escape releases the wrapper's own locals (`owned_batch`, `owned_blocked`) instead of caller temporaries.
  - 2 additions: a prologue escape releases the wrapper's own parameter (`storage`), which is the leak above.
- Async and ownership suites with the fixed stage 1: `async_await` 293, `async/sm_ownership` 54, `algebraic_effects` 83, `match_nested` 29, `move_only` 94, `borrowed_match_binding_place` 12, `tests/internal/build_runner` 18. The six fusion and `yo build test` cli cases pass 6/6, and a tree-binary `check ./src` returns rc 0.
