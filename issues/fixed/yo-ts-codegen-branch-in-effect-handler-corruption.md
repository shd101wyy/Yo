# TS codegen: `unwind(<call>)` — the escape flag was raised before the argument ran, so a may-unwind call in the argument cancelled the unwind (was: "branch in effect handler corrupts the heap")

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

## Root cause: FOUND + FIXED (2026-08-07)

**The unwind emitter raised `__yo_effect_escaped = 1` BEFORE evaluating the
unwind argument.** A may-unwind CALL inside the argument emits the standard
caller-side protocol — `__yo_effect_escaped = 0; <call>; if
(__yo_effect_escaped) ...` — and that pre-call clear CANCELLED the
in-progress unwind. Emitted handler (crashing shape, minimal repro):

```c
static inline Node* raise(String msg) {
  __yo_effect_escaped = 1;          // unwind raises the flag FIRST
  __yo_effect_escaped = 0;          // arg call's pre-call clear CANCELS it
  Node* _t = make_err_node();
  if (__yo_effect_escaped) { return (Node*){0}; }
  { Node* _unw_val = _t; memcpy(__yo_unwind_value, &_unw_val, ...); }
  return (Node*){0};                // dummy returned with the flag DOWN
}
```

The raise site sees `__yo_effect_escaped == 0` and treats the dummy NULL as
the real result; NULL flows onward and the first tag/field read faults
(`ldr w8, [x26, #0x8]` with x26 = 0). The "branch in the handler" framing
was a proxy: what c592f9920 changed is which calls the argument path makes —
the trigger is any unwind whose ARGUMENT contains a call the effect analysis
marks may-unwind (`unwind(make_err_expr())`). Inline constructions never
emit the clear, which is why the straight-line workaround appeared to fix
it. The original heap-corruption presentation in the compiler is the same
mechanism at one remove: NULL/dummy results flowing into evaluator state
corrupt invariants long before the crash site.

**Fix (both compilers):** evaluate the argument first, THEN raise the flag.

- TS: `src/codegen/exprs/generation.ts` `generateUnwind` — flag emission
  moved into the no-arg branch and to after `generateExpr(arg, ...)`.
- yo-self: `codegen/exprs/return.yo` `generate_unwind` — same split
  (`.None` arm start / after `argc := _call_generate_expr(...)`).

**Minimal repro** (SIGSEGV before, `acc=358` after):
`scratchpad/unwind_ref_min5.yo` — ctl handler `(msg) ->
unwind(make_err_node())` where `make_err_node` is a module fn returning the
ref-enum result type; 30-iteration loop over raise/non-raise inputs.
Discriminator pair: `unwind(<inline ctor>)` green, `unwind(<call>)` red.

**Regression test:** tests/algebraic_effects.test.yo
"unwind argument built by a may-unwind call" — verified RED under the
pre-fix self-hosted binary (rc=1) and GREEN under the fixed TS compiler
(74 passed).
