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

### UNWIND mechanism — complete TS map (2026-06-18), for the faithful port.

The `unwind`/escape layer has three coordinated parts (all in `src/codegen/`):
1. **`unwind(v)`** (`generation.ts:285-440`, the `generate_unwind` stub at
   yo-self `generation.yo:382`): emit
   `{ T _unw_val = <v>; memcpy(__yo_unwind_value, &_unw_val, sizeof(T)); }`,
   then `__yo_effect_escaped = 1;`, then drops (handler-param drops + pending
   deferred drops + consumed-var drops, with the SUPPRESSION of drops for the
   escaping value's own temp — it transfers via `__yo_unwind_value`), then
   `return (RetT){0};` (a dummy the caller ignores). Zero-arg `unwind()` skips the
   stash.
2. **Post-effect-call check** (`other-fn-call.ts:2770` `emitUnwindCheck`, invoked
   at the effect/control-fn call sites): after calling a fn that may set the flag,
   emit `if (__yo_effect_escaped) { <drops>; <T _unw_result; memcpy(&_unw_result,
   __yo_unwind_value, sizeof(T)); return _unw_result;> } ` — propagating the
   unwound value up, OR at the INSTALL site clearing the flag
   (`__yo_effect_escaped = 0;`) and yielding `_unw_result` as the handled value.
3. Runtime globals `__yo_effect_escaped` (thread-local int) + `__yo_unwind_value`
   (a buffer) — yo-self emits the FLAG decl already (1 site) but neither the
   buffer nor the checks.

So the faithful port = `generate_unwind` (part 1) + an `emit_unwind_check` helper
(part 2) wired at the effect-call sites in `other_fn_call.yo`/`generation.yo` +
the `__yo_unwind_value` runtime global. Intricate (woven with the drop machinery)
but bounded and codegen-only. Validate against `effect_handler_resume.yo` (must
stay green) + a new `effect_handler_unwind` fixture (currently prints the wrong
value: 0 vs TS 42).

### PART 1 LANDED (2026-06-18): generate_unwind ported; PART 2 (the harder half).

`generate_unwind` is ported (commit fdff43d42, corpus 70/70) — it sets
`__yo_effect_escaped`, drops, stashes into `__yo_unwind_value`, returns a dummy. A
minimal i32 unwind now RUNS (was failing) but computes `42+8=50` instead of
escaping with `42`: the flag is set but never ACTED ON.

PART 2 = the post-call escape checks (`emitEffectUnwindCheck`,
other-fn-call.ts:2778) that DISCARD the continuation. It is the harder, intricate
half: it is wired at ~6 sites in `other-fn-call.ts`'s **evidence / effect-passing
call path** (call sites 1378/1505/1687/1703/1786/1799), and the crucial
`isHandlerInstallation` flag is derived from the evidence-arg processing
(other-fn-call.ts:1167/1543). At an INSTALL site it emits
`if (__yo_effect_escaped) { drops; __yo_effect_escaped = 0; <extract
__yo_unwind_value as the call result>; }`; at a transitive/propagation site it
returns a dummy to propagate the escape up. So PART 2 requires porting the
evidence/effect-passing call codegen (the largest part of yo-self's
`other_fn_call.yo`, currently noting "effect-unwind propagation (Phase 5)" as
deferred at line 661) — a substantial faithful port, NOT a single helper. The
resume path works WITHOUT it because resume just returns through the handler fn
pointer; unwind alone needs the escape-propagation.

### ALL DEPENDENCIES CONFIRMED PRESENT (2026-06-18) — ready for a focused port.

Verified yo-self already has everything `generate_unwind` + `emit_unwind_check`
need (so this is pure transcription, no infra to build first):
- Context fields: `current_function_type`, `is_effect_record_member_function`,
  `effect_handler_param_drops`, `override_return_type_str`,
  `current_evidence_params`, `in_async_state_machine`, `pending_deferred_drops`,
  `consumed_var_pending_drops` (all in `functions/context.yo`).
- Drop helpers: `generate_pending_deferred_drops` +
  `generate_consumed_var_drops_for_escape` (ported + exported in `return.yo`).
- Async escape: `emit_async_future_escape` (ported in `async_completion.yo`;
  sig `(emitter, indent, result_code : Option(String), debug_label :
  Option(String))`).
- Runtime globals: `__yo_unwind_value` buffer + `__yo_effect_escaped` flag (both
  emitted in `functions/gc_runtime.yo`); `_call_generate_expr` (`_expr.yo`);
  `get_type_string`/`is_unit_type`.
- ONLY absent: `continuation_variables` (the nested-resume-handler escape branch,
  generation.ts:206-241) — skip it; it's an edge for nested handlers.

`generate_unwind` is a near-1-to-1 transcription of `generation.ts:198-448`
(minus the continuation_variables branch): async-SM branch → `emit_async_future
_escape`; else `__yo_effect_escaped = 1`, eval arg (with the escaping-value
drop-suppression — snapshot/restore `pending_deferred_drops`/
`consumed_var_pending_drops` lengths + filter by argCode), drops, then for an
effect-record-member/evidence fn `memcpy` the arg into `__yo_unwind_value` +
`return (RetT){0}`, else `return <argCode>`. Then `emit_unwind_check`
(other-fn-call.ts:2770) at the effect-call sites. Replace the
`generation.yo:382` TODO stub. Both parts must land together (part 1 sets the
flag/stash; part 2 propagates) before `effect_handler_unwind` passes.

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

### FURTHER NARROWED (2026-06-18): backtick eval throws under expected-String.

A `__CPB` probe at `check_if`'s arg-eval confirmed: `check_if(msg)` IS entered with
`resolved_pt=String`, the "enter" probe fires, but the "after-argeval" probe does
NOT — so `evaluate_expression_raw(\`zero\`, …, expected_type=String)` THROWS during
apply's def-time body eval (swallowed → no ExprInfo → `// Failed to transpile`).
So this is NOT a fn-pointer-coercion gap — it's the **backtick/comptime_str
template arg evaluated against an expected `String` type** that throws (the
`("zero".to_string)()` desugaring under expected-String, during def-eval).
`String.from("zero")` with the same expected String does NOT throw. NARROW edge —
synchronous effects work with `String.from(...)` messages
(`effect_handler_resume.yo` is green). NEXT (deprioritized vs unwind part 2 +
parallelism): probe inside the backtick/template eval (or to_string method
resolution) to find why expected-String throws under def-eval, then fix.

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
