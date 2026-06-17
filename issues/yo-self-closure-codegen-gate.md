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
