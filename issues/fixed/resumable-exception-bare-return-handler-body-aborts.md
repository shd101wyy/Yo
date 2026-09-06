# A `ResumableException` handler written as a BARE `err -> return(v)` fails to transpile and aborts at runtime

**Status: FIXED** 2026-09-05 (PR `fix/resumable-handler-bare-return`).

**Real root cause:** the anonymous-function definition-time body trial
(`_trial_eval_anon_body`, `src/evaluator/values/anonymous_function.yo`) routed
the body around `evaluate_begin_expression`. `return` is recognised ONLY as a
`begin` STATEMENT (`evaluate_begin_expression`, `src/evaluator/exprs/begin.yo`
— it has no entry in the expression dispatcher `src/evaluator/exprs/_expr.yo`,
unlike `unwind`, which does). A body that is a bare `return(...)` call was
therefore evaluated as an ordinary function call, threw
`error[E0401]: Variable "return" not found`, and the def-eval wall swallowed
it — leaving the handler with no `ExprInfo`s, which codegen turns into an
`abort()` stub.

**The filed hypothesis was WRONG.** This doc originally suspected
`should_defer_body` / "the effect-record-member stub gate". Neither was
involved: `ctl_force` in `evaluate_anonymous_function_implementation` already
clears `should_defer_body` for every `ctl` handler (both spellings), and the
`__yo_effect_escaped = 1; return ZERO;` stub gate the
`c-codegen.instructions.md` section described no longer exists — it was
replaced by the generic FTT (`abort()`) stub in PR #275. That stale
instructions paragraph was rewritten as part of this fix.

**Found:** 2026-09-05, while building a loop reproducer for
`issues/fixed/dyn-box-dispose-is-emitted-with-an-empty-body.md`. Reproduced
identically on the pre-fix compiler, so it was independent of that fix.
**Severity:** silent miscompile — the program compiled clean and aborted
(SIGABRT, no diagnostic on stderr) the first time the handler ran.

## Symptom

```rust
open(import("std/string"));
open(import("std/fmt"));
open(import("std/error"));

risky :: (fn(exn : ResumableException(i32)) -> i32)(exn.throw(dyn(`boom`)));

main :: (fn(io : Io) -> unit)({
  println(`start`);
  exn := ResumableException(i32)(throw : (err -> return(i32(0))));
  _r := risky(exn);
  println(`one throw done r=${_r}`);
});
export(main);
```

```
$ yo compile g5.yo --std-path ./std --optimize 2 --allocator system -o g5.out
$ ./g5.out
start
$ echo $?
134
```

No message on stdout or stderr beyond `start`.

Wrapping the same `return` in a block compiled and ran correctly, which is why
`tests/error.test.yo`'s existing `ResumableException` tests (all block-form)
never caught it:

```rust
exn := ResumableException(i32)(throw : (err -> { return(i32(0)); }));   // worked, r=0
exn := ResumableException(i32)(throw : (err -> return(i32(0))));        // ABORTED
```

## Diagnosis

`YO_DEBUG_SWALLOW=1 yo check` names the swallowed error exactly:

```
[anon-trial] g5.yo:8:49
[var-miss] name=return env_module=.../g5.yo frames=6
[anon-swallow] error[E0401]: Variable "return" not found.
  --> g5.yo:9:50
9 |   exn := ResumableException(i32)(throw : (err -> return(i32(0))));
  |                                                  ^^^^^^
```

The emitted C then marked the handler's C function as untranspilable and
turned it into an `abort()` stub:

```c
__attribute__((error("yo: the body of fn_yo_id_10204 failed to transpile — its
  definition-time evaluation failed and was swallowed (run yo check with
  YO_DEBUG_SWALLOW=1); this call would abort at runtime")))
static inline int32_t fn_yo_id_10204(__yo_t14 err);
...
  abort(); /* untranspilable body in a value-returning fn: aborting beats falling off the end (UB) */
```

The `__attribute__((error(...)))` never fired because the call is emitted
through a function POINTER (evidence passing), so nothing was reported at C
compile time either.

## Why only the bare form

`_trial_eval_anon_body` called
`evaluate_expression_raw(wrap_body_in_begin(body), ...)`. `wrap_body_in_begin`
(`src/expr.yo`) deliberately wraps ONLY bare-ATOM and bare 2-arg field-access
bodies — everything else was handed to the expression dispatcher unwrapped. A
`{ ... }` body already IS a `begin(...)` node, so the braced spelling reached
`evaluate_begin_expression` and its `return` statement handling; a bare
`return(...)` body is a plain `FnCall`, so it did not.

The two sibling body-eval sites had already been converted to call
`evaluate_begin_expression` directly — `_trial_eval_fn_body`
(`src/evaluator/calls/function_type.yo`, for the same reason plus an arg-temp
drop leak, `issues/fixed/yo-self-tail-expression-arg-temp-drop-missing.md`) and
the closure-call body eval (`src/evaluator/calls/closure_type.yo`). The
anonymous-function trial was the last holdout, which is why a bare
`return(...)` worked as a NAMED fn body (`f :: (fn() -> i32)(return(i32(0)))`)
but not as a lambda body.

## Fix

`_trial_eval_anon_body` now calls
`evaluate_begin_expression(body, env, ctx, ArrayList(Variable).new(), true, inner_exn)`,
matching TS `anonymous-function.ts:829` (which always routes through
`evaluateBeginExpression`) and its two siblings. `evaluate_begin_expression`
treats a non-`begin` input as a one-statement begin ON THE SAME NODE ID, so the
body node keeps carrying the info codegen reads — and codegen's non-begin
function-body path already ASSUMED this invariant ("Since `_trial_eval_fn_body`
routes every fn body through `evaluate_begin_expression`, the body node carries
the begin scope-end drops on its SHARED id",
`src/codegen/functions/generation.yo`). Closures were the one shape violating
it.

After the fix the two spellings emit byte-identical handler bodies (modulo temp
numbering):

```c
static inline int32_t fn_yo_id_7471(__yo_t14 err) {
  int32_t _file____User_temp_9419 = 7;
  return _file____User_temp_9419;
}
```

`__yo_effect_escaped` stays 0, so the throw site resumes with the returned
value — the resume path, not an escape.

## Regression tests

`tests/error.test.yo`:

- `a bare-arrow ResumableException handler resumes like the braced form` —
  bare and braced handlers side by side, plus five resumes through the same
  bare-arrow handler.
- `a bare-arrow handler may compute its resume value from the error` — a bare
  `return(<expression over the handler parameter>)` body.
- `a bare-arrow Exception handler still unwinds` — canary for the bare-arrow
  `unwind` spelling, which never took the broken path (`unwind` HAS a
  dispatcher entry) and must not regress.

All three were verified RED on the pre-fix compiler and GREEN after.
