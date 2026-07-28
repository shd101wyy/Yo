# TS codegen: branch inside a capture-free `->` effect handler corrupts the heap (async-emitter SIGSEGV)

## Symptom

`fs/walker.test.yo` regressed GREEN → RED (rc=139, ZERO-byte log) in the
honest #69 sweep after commit `c592f9920` (ctl force + cee observation
channel). The stage-1 binary (TS-compiled yo-self) SIGSEGVs while COMPILING
the walker test:

```
fn_yo…__emit_while_continuation
fn_yo…_generate_async_block_resume_function
fn_yo…__emit_one_deferred_async_block
fn_yo…_generate_deferred_async_blocks
fn_yo…_compile_module
```

Fault address = `0x5f5f5f656c69665f` — the ASCII bytes `"_file___"` (a C
temp-name prefix `_file____tmp…`): a pointer field was overwritten with
string data. Same string-bytes-as-pointer class as the earlier ys_ret-bridge
crash (pointer = `"esac    "`). Secondary crashes appear at process exit
(`__yo_decr_rc` / `___dispose` under `__yo_cleanup_thread_gc` after
`run_compile → exit → __cxa_finalize`) — the heap is already corrupted, and
the exit-path crash pre-empts stdio flush, which is why the log is
zero-byte (recover hidden output with `script -q /tmp/x.log <bin> …`).

## Bisect (A/B builds, each validated on `test tests/fs/walker.test.yo`)

| build     | tree                                                          | walker        |
| --------- | ------------------------------------------------------------- | ------------- |
| `ae91_s1` | `91ff0327b` (one commit before)                               | **GREEN 6/6** |
| `wk_s1`   | HEAD with `ctl_force` disabled                                | RED rc=139    |
| `wk2_s1`  | HEAD with ONLY the `_expr.yo` wrapper-handler change reverted | **GREEN 6/6** |

The trigger is the c592f9920 change to `_evaluate_expression_wrapper`'s
swallow handler (`yo-self/evaluator/exprs/_expr.yo`):

```rust
// before (green)
(err) -> unwind(make_err_expr())
// after (corrupts)
(err) -> {
  if(propagate_def_time_errors(), {
    set_cee_observed_error();
  });
  unwind(make_err_expr());
}
```

This is the hottest `->` handler in the compiler (fires on every swallowed
def-time error). With the branch + calls inside the handler body, the TS
codegen emits something that plants heap corruption; it surfaces much later
in the async emitter. This is a REAL TS codegen bug — the same handler body
shape written in a plain fn is fine.

## Workaround (landed)

Keep the handler body straight-line: the propagate-mode check moved into a
plain module fn `note_def_time_swallow()` (`yo-self/types/flowability.yo`),
and the handler body is now `note_def_time_swallow(); unwind(make_err_expr());`
— no branch in the handler. Validated: walker GREEN, cee corpus test GREEN
(TIER 1).

## Root cause: OPEN

Minimal repro not yet extracted (corruption-class; the crash site is far
from the plant site). Candidate mechanism: the `->` capture-free handler is
emitted as a C function whose frame/return path the effect-install site
assumes to be a specific shape; an `if` + nested block in the handler body
changes the emitted temp layout so the `unwind` path writes a temp (a
`_file____tmp…` C string) over an installer-owned pointer slot.

Next steps for a real fix:

1. Try a standalone repro: a `->` handler with an `if(module_flag(), {...})`
   before `unwind(...)`, installed under a deep eval loop that fires it
   thousands of times, in a program that later runs the async emitter path
   (or any large allocation-heavy phase).
2. Diff the emitted C for `_evaluate_expression_wrapper` between wk2 (green)
   and HEAD (red) — look at the handler fn's temp declarations and the
   unwind stash (`__yo_unwind_value`) writes.
