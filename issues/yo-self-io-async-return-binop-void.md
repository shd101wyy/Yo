# yo-self: io.async closure with `return(<binary op>)` tail → Future output degrades to unit/void

**Status:** OPEN — root PINPOINTED by probes (recipe below), fix not yet landed.
Files: `tests/thread.test.yo`, `tests/worker.test.yo` (both RED, rc=1, 1 marker,
`variable has incomplete type 'void'` at the awaited-result declaration).

## Differential (TS green / s1 1 marker): `/tmp/thr_B.yo`

```rust
{ yield } :: import("std/async");
{ Thread } :: import("std/thread");
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  thread := Thread.spawn((io) => {
    x := 10;
    y := 20;
    task := io.async((io : Io) => { return(x + y); });
    result := io.await(task, io);
    assert(result == i32(30), "async result should be 30");
  });
  thread.join();
});
export(main);
```

s1 emits `void _file..._temp = ;` at the sync-await result and FTTs the assert.
The sync-fut struct's result field is `uint8_t` (unit) where TS has `int32_t`.

## Probe matrix

| closure body                                            | s1   |
| ------------------------------------------------------- | ---- |
| `{ io.await(yield(io), io); (x + y) }` (bare tail)      | PASS |
| `{ return(i32(30)); }` (call arg)                       | PASS |
| `{ return(x); }` (atom arg)                             | PASS |
| `{ return(x + y); }`                                    | FAIL |
| `{ return((rx + rx) + i32(10)); }` with `rx := i32(10)` | FAIL |

→ specifically `return(<binary operator expr>)`; not comptime-int-related.

## Root, as measured (three probe builds, 2026-07-29)

1. `__DBG_REFINE` (anonymous_function.yo refinement): the io.async closure's
   def-eval body type is the bare unresolved SomeT `T` (`has_some=1`, EMPTY
   `resolved_concrete` cell) — so the concrete-result refinement
   (`register_func_type` / `register_closure_body_type`) is skipped.
2. `__DBG_ASYNCRES` (codegen async.yo io.async output resolution): NEVER fires —
   `result_type` from the Future trait output is already CONCRETE **unit**
   before codegen's fallback chain, so `get_func_type(fid)` is never consulted.
3. `__DBG_RETARG` (begin.yo return path): the return ARG `x + y` itself types
   as `T` (`ty=T expected=T`) — the operator call's RESULT became the ambient
   expected SomeT.
4. `__DBG_STEP9/10` (helper.yo return-type resolution): the deepest call in the
   chain (`__yo_op_add`, declared `fn(generic(T), x : T, y : T) -> T`,
   prelude:90) reaches Step 9 with `ret_b=T ret=T` — **its own generic `T`
   was never bound from the i32 arguments** during this eval; Step 10 then
   synthesizes it against the ambient expected `_ret` SomeT and the unresolved
   T survives as the result type. In the bare-tail variant (expected cleared by
   anonymous_function.yo:1300's io.async workaround) the same intrinsic binds
   T:=i32 fine — the ambient expected SomeT is what perturbs the forall
   binding.

TS under the same shape: the return arg types i32 (or SomeT-with-
resolvedConcreteType), and begin.ts:1603-1618's `synthesizeTypes(fn.return, returnType)`
binds `_ret` in the env. TS's arg-based forall binding is NOT perturbed by the
ambient expected.

## Landed so far (faithful-port gaps found by this hunt; kept, but not sufficient)

- begin.yo return-type check: the deferred `synthesize_types` call is now
  ported (was "partial port — synthesize_types deferred"), incl. TS's
  async-block arm (begin.ts:1642-1680). No-op for this bug while the return
  arg's type is already `T` (SomeT-vs-same-SomeT synthesis binds nothing).
- anonymous_function.yo refinement: unwraps a SomeT-with-resolved-cell body
  type before the concreteness gate (TS anonymous-function.ts:975-978). No-op
  while the cell is empty.

## Next probe

Instrument the forall-binding step for the `__yo_op_add` call (the FuncVal path
binds via `_funcval_bind_foralls`, function.yo:1095; builtins may take
function_type.yo's path) and compare `T` binding with ambient expected SET vs
CLEARED. The fix is wherever the ambient `ctx.expected_type` leaks into (or
short-circuits) argument-based forall synthesis — TS keeps those independent.

Probe recipe: `eprintln` probes ride `{ eprintln : __dbg_eprintln } :: import("std/fmt");`
(helper.yo already `open`s std/fmt — use plain `eprintln` there). Grep-strip
`__DBG_` before committing.
