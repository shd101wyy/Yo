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

## Root cause

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
