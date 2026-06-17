# yo-self closure codegen gate (blocks the async BASELINE)

**Status:** OPEN — the next blocker after the async/await emitter ports + wiring.

## Summary

The Phase-5 async port (`exprs/async.ts` → `async.yo`, `exprs/await.ts` →
`await.yo`) is complete and wired into `codegen_c`. The canonical BASELINE async
fixture now runs the FSM transformation end to end — yo-self emits real C — but the
C does not compile because the `io.async` closure's C **function** and **capture
struct** are never emitted.

## Reproducer

```rust
{ println } :: import("std/fmt");
run :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) => { x := i32(42); x });
  io.await(task, io)
});
main :: (fn(io : Io) -> unit)({ println(run(io)); });
export(main);
```

`./yo-cli compile` (TS) → prints `42`.
`/tmp/yo-self-bin compile` → emits C, but `clang` fails:

```
void* task = /* Error: no closure function or capture type for io.async sync path */;
... __sync_future->state;  // member reference base type 'void' ...
```

The closure body (`x := i32(42); x`) appears as NO C function in the output, and
the `io.async` call falls into `generate_io_async_sync_call`'s error branch.

## Root cause (pinned 2026-06-18)

The io.async closure arg is evaluated as a **plain anon-fn value** (its ExprInfo
carries `value = FuncVal`, set by `anonymous_function.yo`), NOT as an **Impl(Fn)
closure construction** (which would set `closure_function_value` AND `capture_type`
via `closure_type.yo`'s `try_to_implement_closure_by_fn_module_type`). Consequences
for `generate_io_async_sync_call`:

- closure C function name: RESOLVED — the emitter now falls back to `cei.value`
  (commit e5ee5e93f), and the closure function IS collected via the anon-fn-value
  path (collection.yo:541).
- capture struct: STILL MISSING — `cei.capture_type` is `None` (only the Impl(Fn)
  closure path sets it), so there is no capture struct C name, and
  `_call_generate_expr(closure_arg)` returns the function-name reference
  (`_anon_fn_value`), not a capture struct VALUE like TS's
  `generateClosureConstruction` would.

So the faithful fix is **evaluator-side**: route io.async closure args through the
Impl(Fn) closure path so they carry `closure_function_value` + an (empty-for-no-
capture) `capture_type`, and wire `is_closure_construction → generateClosureConstruction`
in the codegen dispatch (so the arg emits the capture VALUE). A codegen-only hack
that synthesizes an empty capture for the anon-fn-value case would be a shortcut that
breaks for captured closures — avoid it.

**NARROWED 2026-06-18 (commit after e5ee5e93f).** io.async's parameter IS
`action : Impl(Fn(e : E) -> T)` (std/prelude.yo:8182), so the closure SHOULD route
through `try_to_implement_closure_by_fn_module_type` (closure_type.yo), which sets
`closure_function_value` + `capture_type`. But the emitter finds `capture_type` is
`None` on BOTH the runtime-arg expr AND the original `args[0]` expr (a fallback was
added to consult args[0] — harmless, kept). So the evaluator is NOT invoking the
closure-typing path for this arg; it types the anon-fn as a plain function value
instead. The remaining work is to find WHY the closure-against-`Impl(Fn)`-param path
is skipped during io.async arg evaluation (the generic-fn-call arg-coercion path not
triggering closure implementation) and fix it so `capture_type` (empty struct for
no-capture) + `closure_function_value` are set — then `generate_io_async_sync_call`
resolves the capture struct and the construction emitter produces its value.

**FURTHER (2026-06-18, commit 65ff909cf).** Added the evaluator groundwork:
`evaluate_anonymous_function_implementation` now marks io.async `=>` closures as
closures (`mark_as_closure_fn`) and builds their capture struct (`capture_type`),
scoped to `ctx.is_inside_io_async_call`. Validated SAFE (std 152/152, corpus 58/58).
BUT the BASELINE still emits `/* Error: no CAPTURE type */`, AND the closure
function body (`x := i32(42)`) does not appear in the emitted C at all. So either:
(a) `is_io_async_call(expr)` (function.yo:1770) does not fire for the baseline's
`io.async(...)` method call, so `is_inside_io_async_call` is never set during the
closure arg eval (→ the new code is skipped); or (b) the closure ExprInfo that
codegen reads (`runtime_arg_exprs_in_order[0]` / `args[0]`) is a different node than
the one the eval set `capture_type` on; or (c) the closure function is dropped by
`should_skip_function_codegen` (treated as generic). NEXT: instrument which of
(a)/(b)/(c) holds — first confirm `is_io_async_call` returns true for the baseline
call and that the closure fn is collected+emitted, then trace the ExprInfo identity
from eval to the codegen read. The marker + capture-param convention + capture_type
plumbing are all in place; the remaining work is making them connect on the actual
codegen-read node.

**SYNC-FUTURE INFRA COMPLETE 2026-06-18 (commit 82233c5a5).** The io.async
sync-future path now emits its full C (capture struct, __yo_param slot, set_effect,
resume, dispose, constructor); the future var lowers to the correct `<struct>*`
pointer (get_type_string SomeT branch consults the registry; future c_name
registered with `*`); the no-capture `__capture` is `(<cap>){0}`. Validated std
152/152, corpus 58/58.

**FINAL ROOT CAUSE of the last 2 C errors** (closure fn `closure_yo_id_*`
undeclared; await result `int32_t = void*`): the closure's SYNTHESIZED Func type
uses SomeT params + return. At the io.async call, `expected_type` is set to None for
the `Impl(Fn(e:E)->T)` param (function.yo:1807, because it `is_some_type`), so
`evaluate_anonymous_function_implementation` falls back to
`_synthesize_default_func_type`, which makes every param + the return a FRESH SomeT
(closure.yo `_synthesize_default_func_type`). Consequences:
- `is_function_type_hard_generic` is true (any SomeT param ⇒ generic), so
  `should_skip_function_codegen` SKIPS the closure function — it is never emitted,
  yet the resume calls it. (NB: hard-generic checks only PARAMS, not the return —
  so fixing the params alone would un-skip it.)
- the result type `T` is an unresolved SomeT ⇒ `void*`, so the await result
  extraction emits `int32_t = void*`.

The closure is NOT actually generic — its source is `(io : Io) => { … i32 }`
(concrete param annotation + i32 body). The fix is evaluator-side concrete typing of
the closure: either (a) thread the resolved `Impl(Fn(e:E)->T)` expected type to the
closure arg (needs io.async to resolve E=Io,T=i32 — generic specialization), or
(b) have `evaluate_anonymous_function_implementation` derive the closure's param
types from the SOURCE annotations (`io : Io`) and its return type from the
def-time-evaluated body (i32), instead of synthesizing fresh SomeTs. Option (b) is
the more localized, lower-risk path: make the closure's own concrete signature
authoritative when annotations/body are available, so it is neither skipped as
generic nor lowered to void*. This is the final, narrowly-scoped step to emit `42`.

## Original root cause

`io.async((io)=>{…})` with no `await` inside routes to the sync-future path
(`generate_io_async_sync_call`). That emitter needs two things from the closure
argument:

1. The closure's **C function name** — TS reads it from `implClosureCallMap`
   (populated by a closure-discovery pre-pass in `src/codegen/exprs/closures.ts`);
   yo-self has NO `implClosureCallMap`. The yo-self adaptation reads the closure
   arg's `closure_function_value` FuncVal → `func_id` → `get_function_entry`, but
   the closure function is **never collected into `context.base.functions`**, so the
   lookup returns `None`.
2. The closure's **capture struct C name** — TS reads `context.types[concreteType.id]`
   (the monomorphized Impl(Fn) capture type, registered even for no-capture
   closures). yo-self's `capture_type` ExprInfo field is `None` for a no-capture
   closure, and there is no registered capture struct.

Both gaps live in the **closure codegen subsystem** (`exprs/closures.ts`, ~358 LOC,
Phase-3-deferred in `plans/BOOTSTRAPPING_CODEGEN.md`): closure-function discovery +
collection, capture-struct type creation/registration, and closure-function
emission. `closures.yo` currently ports only `check_variable_is_closure_captured`.

## Not in scope of this issue

`async.yo` / `await.yo` are faithful and complete; the dispatch + `codegen_c`
wiring + runtime emission are done (corpus 58/58 with the sys-runtime now active for
every program). The async-with-AWAIT path (`generate_async_block`) has the same
closure dependency for captured async blocks. This gate is purely the closure
codegen subsystem.

## Fix plan (precise entry points)

The closure CALLING CONVENTION is the keystone. TS keys it on
`functionType.isClosure` (declarations.ts:405): a closure function's C prototype
prepends `void* closure_context` as the FIRST parameter, and the body casts it to
the capture struct. yo-self's closure functions are emitted by the ordinary
`generate_function` / `generate_function_prototype` with ONLY their declared params
— no capture param — so the sync-future resume's `cfn(&sm->__capture, …)` call
(capture-pointer first) does not match the callee. This mismatch holds even for
NO-CAPTURE closures (TS still prepends the param; the capture struct is empty).

Steps:

1. **Closure marker.** Add an `is_closure` signal for a Func — either a field on the
   `Func` TypeValue variant (large blast radius, ~all Func ctor sites) or a side-table
   keyed by `func_id` (`g_closure_func_ids`, mirroring `g_struct_field_comptime_flags`).
   Set it where closures are typed (`evaluator/calls/closure_type.yo`,
   `try_to_implement_closure_by_fn_module_type`).
2. **Capture param.** In `functions/declarations.yo` (`generate_function_prototype`)
   and `functions/generation.yo` (`generate_function`), prepend `void* closure_context`
   when the function is a closure; in the body, establish the capture-access context
   (`current_closure_capture_type_c_name` already exists) so captured-var atoms emit
   `((CaptureT*)closure_context)->field`.
3. **Capture struct registration.** Ensure every closure's capture struct (empty for
   no-capture) is collected into `context.types` with a C name, so the sync-future
   `__capture` field type and `generateClosureConstruction` can resolve it. (A
   no-capture closure currently has `capture_type = None`, closure.yo:212.)
4. **Capture-expr-per-field machinery.** `allocateClosureCapture` (and async.yo's
   `_build_async_capture_struct_literal`) need each capture field's source ATOM expr
   to emit `.field = <atom access>`. yo-self's capture `TypeField` does not carry the
   capture expr; this is the recurring gap (see the PHASE3_CAPTURE_PENDING marker in
   `async.yo`). Either store the capture expr on the registered struct fields or
   reconstruct the atom from the captured-var token + its ExprInfo.
5. **Construction emitter + registry.** Port `generateClosureConstruction` +
   `allocateClosureCapture` + `registerImplClosureCallMappings` into `closures.yo`,
   adding an impl-closure-call registry to the context (yo-self has no
   `implClosureCallMap`). Wire the closure-construction dispatch in `generation.yo`
   (`isClosureConstruction` → `generateClosureConstruction`).

Then re-run the BASELINE fixture → expect `42`, and add closure corpus fixtures
(non-async first: a captured-variable closure called directly) to lock the
convention before the async paths.

Leaf helpers already ported in `closures.yo`: `check_variable_is_closure_captured`,
`resolve_some_type_to_concrete`, `is_closure_construction`.
