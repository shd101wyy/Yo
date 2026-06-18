# yo-self: synchronous algebraic-effect codegen is unported (Phase 5)

## Status

OPEN — scoped. The **async** half of Phase 5 is working and validated end-to-end
(io.async FSM + closures, 7 corpus fixtures: i32 / str / bool / capture /
capture+operator / single-await FSM / multi-await FSM). The **effects** half —
synchronous algebraic-effect handlers (`ctl(...)` effects, `return`/`unwind`
continuations) — is not yet ported in the self-hosted codegen.

## Minimal reproducer

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
Raise :: (ctl(msg : String) -> i32);
safe :: (fn(x : i32, raise : Raise) -> i32)(
  cond(
    (x == 0) => raise(`zero`),
    true => x
  )
);
run :: (fn() -> i32)({
  (raise : Raise) = (fn(msg : String) -> i32)({
    println(msg);
    return(i32(99));
  });
  safe(0, raise) + safe(5, raise)
});
main :: (fn() -> unit)({ println(run()); });
export(main);
```

- **TS reference**: compiles + runs, prints `zero` then `104` (99 + 5).
- **yo-self-bin**: emits broken C — two distinct failure points (below).

## What the TS reference lowers this to (the target)

The synchronous effect model is **NOT** the async FSM. It is a simpler
function-pointer + thread-local-escape-flag scheme:

1. **Effect param → C function pointer.** `raise : Raise` where
   `Raise :: (ctl(msg : String) -> i32)` becomes the C parameter
   `int32_t (*raise)(__yo_struct_..._String msg)`.

2. **Effect call → indirect call + escape check.** `raise(\`zero\`)` becomes:
   ```c
   int32_t t = ((int32_t (*)(String))raise)(msg);
   if (__yo_effect_escaped) {       // set by unwind() in the handler
     /* drop locals */ return (int32_t){0};
   }
   ```
   `__yo_effect_escaped` is a `static _Thread_local int` declared once. Every
   effect-call site that may unwind gets the post-call check, dropping its locals
   before the early `return {0}` so the escape propagates up the stack.

3. **Handler binding → the function value itself.** `(raise : Raise) = (fn(...) -> i32)({...})`
   binds `raise` to the handler function (used as the fn-pointer arg to `safe`).
   `return(v)` inside the handler **resumes** (returns `v` from the fn pointer);
   `unwind(v)` **discards** the continuation (sets `__yo_effect_escaped` and
   unwinds to the enclosing `fn`).

(See `__yo_effect_escaped` usage and `fn_..._safe` in the TS `--emit-c` output.)

## The two yo-self failure points

1. **`// Failed to transpile cond(...)`** — `generate_func_call`
   (`yo-self/codegen/exprs/generation.yo:332`) hits the
   `get_expr_info(expr) == None` fallthrough for the `cond` that forms `safe`'s
   body. **Root cause is upstream of codegen**: the effect-using function
   `safe`'s body was never evaluated with the `ctl` effect param bound, so no
   ExprInfo was produced for the body / effect-call site. This is an
   **evaluator-metadata gap** (effect-param handling in the def-time body eval),
   not just a missing emitter.

2. **`void* raise = /* skip generating value */;`** — the handler binding
   `(raise : Raise) = (fn ...)` emits `comptime_value.yo:364`'s
   `/* skip generating value */` because the RHS (a `fn` value bound to a `ctl`
   type) is not lowered to a C function pointer.

## Scope of the port (next focused session)

- Evaluator: ensure effect-using fn bodies + effect-call sites get ExprInfo
  (effect param treated as an implicit fn-typed parameter during def-time body
  eval). Mirror `src/evaluator/effects/effect-analysis.ts`.
- Codegen: lower a `ctl` effect param to a C function pointer; lower an
  effect call to an indirect call + `__yo_effect_escaped` post-call check with
  local-drop-before-escape-return; emit the thread-local flag; lower the handler
  binding RHS to the function-pointer value; lower `return`/`unwind` inside the
  handler (resume = `return v`, unwind = set flag + return-up).
- Then add a corpus fixture (kept OUT of `tests/codegen-bootstrap` until green).

## Why not landed now

This is a bounded but real subsystem spanning evaluator metadata + codegen,
each iteration gated on a ~5-min yo-self-bin rebuild. Documented precisely with
the exact TS C target so it can be ported and validated in a focused session.
The corpus stays green (65/65) — no failing fixture was committed.
