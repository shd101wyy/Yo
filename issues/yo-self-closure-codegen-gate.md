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

## Fix plan

Port `exprs/closures.ts` → `yo-self/codegen/exprs/closures.yo` (capture-struct
machinery + closure-function emission) and the closure-collection half of
`functions/collection.ts` / the closure-discovery pre-pass, registering each
reachable closure's C function name and capture struct so
`generate_io_async_sync_call` (and `generate_async_block`'s capture path) can resolve
them. Then re-run the BASELINE fixture → expect `42`.
