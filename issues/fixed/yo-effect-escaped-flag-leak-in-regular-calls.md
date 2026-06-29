# `__yo_effect_escaped` Flag Leak in Regular (Non-Evidence) Function Call Path

## Error

SIGSEGV (exit 139) during the compile path when the prelude cache was
HashMap-backed. `ast_expr_id(NULL)` in `try_to_convert_to_pointer_type` —
the NULL came from `_evaluate_expression_wrapper` returning NULL spuriously.

## Root Cause

The C codegen emits a thread-local escape-flag pattern for effect-handling:

```c
__yo_effect_escaped = 0;   // (A) clear before the call
result = callee(args);      //     callee may set flag via unwind()
if (__yo_effect_escaped) {  // (B) check after the call — propagate escape
  return dummy;
}
```

The preamble (A) was emitted by `generateEvidenceCallSite` (the evidence-call
path) but was **missing** from the regular (non-evidence) function-call path.
The check (B) was emitted (via `emitEffectUnwindCheck`) for any call where
`callMayUnwind` was true, but without the preamble the check could see a
**stale** `__yo_effect_escaped = 1` left over from a _previous_ unwind that
had already been handled by a higher-level handler.

### How the flag leaks

1. A function body evaluation hits an error → `unwind()` sets `__yo_effect_escaped = 1`
2. The escape propagates up through the call stack
3. A handler catches the escape (e.g. via `return(expr)` resume)
4. Code after the handler continues — but `__yo_effect_escaped` is **still 1**
5. The next regular function call through the non-evidence path has:
   ```c
   result = next_fn(args);  // NO preamble — flag still 1 from step 3!
   if (__yo_effect_escaped) { // TRUE → spuriously propagates a non-existent escape
     return NULL;
   }
   ```
6. The spurious NULL cascades → SIGSEGV

### Affected code paths

In `src/codegen/exprs/other-fn-call.ts` and `yo-self/codegen/exprs/other_fn_call.yo`:

| Call path                          | Before fix                                | After fix                    |
| ---------------------------------- | ----------------------------------------- | ---------------------------- |
| Direct, unit return                | check only                                | preamble + check             |
| Direct, non-unit return            | check only                                | preamble + check             |
| Indirect (fn ptr), unit return     | preamble only for `isEffectRecordCapture` | preamble for `isControl` too |
| Indirect (fn ptr), non-unit return | check only                                | preamble + check             |

## Fix

Added `__yo_effect_escaped = 0;` before every regular function call whose
callee may set the escape flag (i.e. when `callMayUnwind` / `ou_may_unwind`
is true). This makes the regular-call path consistent with the evidence-call
path (`generateEvidenceCallSite`), which already emitted the preamble.

### Minimal repro

```yo
{ Exception } :: import("std/error");
no_throw :: (fn(exn : Exception) -> i32)({ return(42); });
main :: (fn() -> unit)({
  // Step 1: unwind sets __yo_effect_escaped = 1
  (fn() -> i32)({
    (exn : Exception) = ((error) -> { unwind(99); });
    exn.throw(dyn(String.from("test")));
    return(0);
  })();
  // Step 2: next call — preamble must clear the stale flag
  exn2 := Exception(throw: ((error) -> { unwind(0); }));
  no_throw(exn2);
});
```

Without the fix this SIGSEGVs; with it `no_throw` correctly returns 42.

## Verification

- All 2622 tests pass (0 regressions)
- yo-self binary compiles successfully with the fix
- Algebraic effects test suite: 72/72 pass
