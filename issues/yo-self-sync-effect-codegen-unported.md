# yo-self: synchronous algebraic-effect codegen is unported (Phase 5)

## Status

OPEN — scoped. The **async** half of Phase 5 is working and validated end-to-end
(io.async FSM + closures + JoinHandle, 9 corpus fixtures). The **effects** half —
synchronous algebraic-effect handlers (`ctl(...)` effects, `return`/`unwind`
continuations) — is not yet ported in the self-hosted codegen.

### REFINED ROOT (2026-06-18): the blocker is FIRST-CLASS FUNCTION-POINTER VALUES,
### not anything `ctl`-specific.

A plain `fn`-typed (NOT `ctl`, NOT closure) higher-order example fails IDENTICALLY:
```rust
safe :: (fn(x : i32, f : (fn(msg : String) -> i32)) -> i32)(
  cond((x == 0) => f(`zero`), true => x));
run :: (fn() -> i32)({
  (h : (fn(msg : String) -> i32)) = (fn(msg : String) -> i32)({ println(msg); return(i32(99)); });
  safe(0, h) + safe(5, h)
});
```
yo-self emits `void* h = /* skip generating value */;` (the `fn`-VALUE bound to a
variable is not lowered to a C function pointer) and `// Failed to transpile`
for `safe`'s body (the indirect call `f(...)` through a `fn`-typed parameter).
Both the `ctl` and plain-`fn` versions produce the SAME two errors.

So the prerequisite for synchronous effects is **first-class function-pointer
value codegen** (distinct from the working closure path, which is SomeT/FnTrait
`=>`-typed and captures context):
1. A bare `fn`-VALUE bound to a variable / passed as an argument → emit the fn as a
   top-level C function and the value as `&that_fn` (a function pointer).
2. A `fn`-typed PARAMETER → a C function-pointer type.
3. An indirect call through such a param → `f(args)` (already valid C for a fn ptr).
Only AFTER that does the effects layer add: handler binding = the fn pointer,
effect call = indirect call + `__yo_effect_escaped` post-call check (the TS
`isControlFunction` codegen in `async/state-code-gen.ts` + `types/collection.ts`),
and the evaluator effect-analysis (`src/evaluator/effects/effect-analysis.ts`,
263 LOC). Port first-class fn-pointer values FIRST (faithfully, mirroring TS's
fn-value codegen), then the effect-specific escape-flag layer on top.

### ⭐ MAJOR PROGRESS (2026-06-18): RESUME effect handlers WORK; only UNWIND remains.

With first-class fn-value codegen landed (below), a synchronous `ctl`-effect
handler using **`return` (resume)** now works END-TO-END:
`tests/codegen-bootstrap/effect_handler_resume.yo` runs → `zero`/`104` matching TS;
corpus 70/70. Effects ARE first-class fn values + `ctl` typing, so the resume path
fell out of the fn-value fix for free.

**`unwind` (escape/discard-continuation) is the ONLY remaining effect piece** — and
it's a CODEGEN-only gap now (it compiles, but gives the WRONG RESULT): a minimal
i32 unwind handler prints `0` where TS prints `42` (the unwound value is lost).
Root: yo-self emits the `__yo_effect_escaped` thread-local **declaration** (1
occurrence) but NONE of the post-effect-call CHECKS — TS's output has **35**
`__yo_effect_escaped` sites (the mechanism: after every effect call, emit
`if (__yo_effect_escaped) { /* drop locals */ return {0}; }` so the escape
propagates up the stack, and `unwind(v)` sets the flag + stashes `v`). So the
remaining work is porting the **escape-flag emission layer**: the
`isControlFunction` post-call checks (TS `codegen/async/state-code-gen.ts` +
`codegen/types/collection.ts`) + `unwind` setting the flag. This is a bounded,
codegen-only faithful port (the evaluator effect-analysis is NOT blocking the
resume path; whether unwind needs more analysis is TBD). NOTE: also still open —
the `i64(raise(...))`-wrapped unwind variant additionally hits "Failed to
transpile" (a separate conversion-wrapping-an-effect-call eval issue).

### PROGRESS (2026-06-18): first-class fn-VALUE codegen LANDED.

The fn-value-lowering piece is done (faithful port of `comptime-value.ts:266-283`):
`generate_comptime_value` now emits a `FuncVal`'s registered C function name (=a
function pointer) instead of `/* skip generating value */`. Combined with the
already-working fn-pointer param TYPE lowering (`int32_t (*f)(...)`) and indirect
call, these now work end-to-end (corpus fixture `fn_pointer_param.yo`, 69/69):
- a bare `fn`-value bound to a variable (`(h : (fn..)) = (fn..)({...})`)
- a `fn`-typed parameter (`f : (fn(n : i32) -> i32)`)
- an indirect call, including inside `cond` (`f()`, `f(i32(7))`)

REMAINING edge: a fn-pointer call with a **comptime_str (backtick) argument**
(`f(\`zero\`)`) still fails — the comptime_str→String coercion that
`check_if_function_parameter_matches_argument` applies on the FuncVal/try_to_call
path is NOT reached for an `UnknownVal(Func)`-callee fn-pointer call (verified: a
`__CP` probe on comptime_str args never fires for the `f`-call's String param). So
the fn-pointer-call arg path (the `UnknownVal(Func)`-callee dispatch in
`function.yo`) evaluates args WITHOUT the comptime coercion. Non-comptime args
(i32, `String.from(...)`) work; only bare backtick/comptime_str literals fail.
NEXT: find the `UnknownVal(Func)`-callee dispatch arm in `evaluate_function_call`
and route its arg eval through (or replicate) the comptime coercion. Then the
effect-specific escape-flag layer (`isControlFunction` codegen) on top.

### NARROWED (2026-06-18): the backtick arg EVAL throws, before param-matching.

The `UnknownVal(Func)`-callee call DOES route through `try_to_call_function_with_
arguments` → `check_if_function_parameter_matches_argument` (function.yo default
arm 2680). A `__CP` probe (gated on a comptime_str arg) inside `check_if` fired for
the backtick's INTERNAL machinery (`acc`/`init`/`lhs`/`rhs` comptime_str params)
but NEVER for the `f`-call's String `msg` param — and that probe sits AFTER the
arg-eval line (`evaluate_expression_raw(actual_arg, ..., expected = resolved_pt)`).
So `check_if(msg, String, …)` IS entered but THROWS at the arg-eval step BEFORE the
probe: evaluating the backtick `\`zero\`` with `expected_type = String` throws
during apply's def-time body eval (the def-eval trial wrapper swallows it → apply's
body gets no ExprInfo → `// Failed to transpile`). `String.from("zero")` with the
same expected String works. So the bug is specifically the **backtick/comptime_str
template arg evaluated against an expected `String` type** on this path — likely
the `("zero".to_string)()` desugaring's to_string resolution under an expected
String. NEXT: probe the arg-eval at check_if line ~438 (move the marker BEFORE
`evaluate_expression_raw`) to capture the throw, then fix the backtick/to_string
eval under expected-String (or coerce the expected type for the backtick arg).
NOTE: this edge only blocks backtick-literal args to fn-pointer calls; effects can
be exercised meanwhile with `String.from(...)` messages.

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
