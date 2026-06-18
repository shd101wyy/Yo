# yo-self: struct-result async + field access blocked on evaluator await-result-type resolution

## Status

PARTIAL. The **codegen** side of resolving an `io.await` result type to its
concrete type is now fixed (two commits below); a struct-returning `io.async`
whose awaited value is **field-accessed** still fails because the **evaluator**
leaves the await result type as an unresolved SomeType, so the field-access
expression downstream never receives ExprInfo.

## Reproducer

```rust
{ println } :: import("std/fmt");
Point :: object(x : i32, y : i32);
run :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) => Point(i32(40), i32(2)));
  p := io.await(task, io);
  p.x + p.y
});
main :: (fn(io : Io) -> unit)({ println(run(io)); });
export(main);
```

- **TS reference**: prints `42`.
- **yo-self-bin** (after the two codegen fixes): `p` now declares correctly as
  `__yo_struct_..._Point* p = __sync_await_result;` (was `void* p`), but the tail
  expression emits `return // Failed to transpile (p.x) + (p.y);`.

Direct-use awaited values (i32 / str / bool returned or printed, NOT
field-accessed) already work — `io_async_{await_42,str,bool}` corpus fixtures —
because the awaited value is passed through opaquely; only field access on the
awaited struct exposes the missing ExprInfo.

## What was fixed (codegen, corpus 65/65, zero regressions)

1. `generate_io_async_sync_call` (`exprs/async.yo`) now **registers** the resolved
   concrete result under the future-trait output SomeType id
   (`register_some_resolved_concrete(output_some_id, result_type)`), so the
   matching `io.await` site — same future type → same output SomeType id — can
   resolve the awaited value's type.
2. `get_type_string`'s SomeType branch (`codegen/utils/index.yo`) now resolves a
   registered SomeType via `lookup_some_resolved_concrete(id)` (recursing on the
   concrete type) before falling back to `get_type_c_name` / `void*`. This makes
   the `p :=` binding declare `p` as `Point*` instead of `void*`.

## Remaining gap (evaluator)

The `io.await(task, io)` call's result type is left as the future-trait output
**SomeType** during evaluation. Because `p`'s type is therefore an unresolved
SomeType at eval time, the field-access `p.x` cannot be type-checked, so neither
`p.x` nor the enclosing `(p.x) + (p.y)` receives an ExprInfo entry — and codegen
hits the `get_expr_info == None` → `// Failed to transpile` fallthrough.

**Fix direction:** resolve the `io.await` result type to the concrete future
output **in the evaluator** (mirror the TS await-result-type resolution that pulls
the concrete output from the awaited future's type), so downstream expressions on
the awaited value type correctly and get ExprInfo. This is the evaluator
counterpart of the codegen registration above; once it lands, add a corpus fixture
(`io_async_struct_field` — currently kept OUT of the green corpus).

## COMPLETE ROOT CAUSE + FIX RECIPE (2026-06-18 — systematically traced)

Both blockers share one root: `T` is never bound to the concrete result at
**eval** time, so the future/await/spawn/unwrap chain stays `SomeType`. Traced
the exact dispatch and fix sites by elimination (two speculative attempts in the
FuncVal forall loop were implemented, tested, and reverted — see below):

1. `io.async` / `io.await` / `io.spawn` are `extern("Yo", …)` builtins
   (`std/prelude.yo:8195`). Their signatures use `Impl(Fn(e : E) -> T)` params
   and `Impl(Future(T, E))` / `JoinHandle(T)` returns. **`Impl(Fn(...))` lowers to
   an `FnTraitT`** (there is no `ImplT` TypeValue variant), `call_result = T`.
2. Extern calls do **NOT** go through `evaluate_function_call`'s `forall`
   inference loop (that path is for FuncVals/closures with bodies). They bind
   `forall` vars via **`check_if_function_parameter_matches_argument`**
   (`helper.yo:409`) → **`synthesize_types`** (`helper.yo:536`), unifying the
   declared param type against `arg_type = arg_info.ty`.
3. For the closure arg, `arg_info.ty` still carries a `SomeType` **result** (the
   body-refined concrete result lands in the func_id side-table, readable via
   `get_func_type(closure_func_id)` — the same bridge the async **codegen** uses).
   So `synthesize_types` binds `T = SomeType`.

**Fix (two coordinated sites, central synthesizer — do as a focused session with
full std + tests + corpus validation):**
- `helper.yo` ~530, before the `synthesize_types` call: when the arg VALUE is a
  closure `FuncVal` and `resolved_pt` is fn-like (`FnTraitT`), compute an
  `arg_type_for_synth` from `get_func_type(closure_func_id)` (the refined `Func`
  with the concrete result) and pass THAT to `synthesize_types` (keep `arg_type`
  for the Step-8 compatibility check).
- `synthesizer.yo` `_synthesize_fn_traits` (961-964): it extracts
  `giv_params`/`giv_result` ONLY from a `FnTraitT` given-type; a bare `Func`
  given-type falls through to `TypeValue.Unit`. Add fn-like extraction so a `Func`
  given-type's `param_types`/`result` are read (normalize `Func` + `FnTraitT`),
  so `exp_result = T` unifies against `giv_result = Point` and binds `T`.

Once `T` binds at eval time, `task : Future(Point)`, `io.await → Point`,
`io.spawn → JoinHandle(Point)`, `handle.await → Option(Point)` all resolve
naturally, `p.x` / `result.unwrap()` get ExprInfo, and both fixtures compile.
The async **codegen** registration already in place (prior commits) becomes
belt-and-suspenders.

## Dispatch-path finding (2026-06-18 — avoid this dead end)

The fix is NOT in the generic FuncVal-call `forall` inference loop in
`evaluate_function_call` (`function.yo`, the `fa_bound` direct-match +
receiver-type-args + capture fallbacks). I implemented and tested a recursive
`_infer_forall_nested` helper there (binds a `forall` from a NESTED position of a
declared param type vs the arg type — `Func` result/params, `FutureTraitT` output,
`Struct` type_arguments) and wired it as a fallback. It is correct in principle,
left the corpus at 65/65 with zero regressions, but fixed **neither** this case
**nor** `JoinHandle.await` — so it was reverted as speculative (no concrete win).

Reason: neither blocker routes through that loop.
- **struct-result async** is **builtin-dispatched** (`io.async`/`io.await` are io
  builtins). The await result type must be resolved on the builtin-call path, and
  the awaited value's type must resolve at EVAL time (not just codegen) so `p.x`
  gets ExprInfo.
- **`JoinHandle.await`** is a **field-fn call** (`await` is a function-typed FIELD
  of `JoinHandle`). `handle.await(io)` returns `Option(T)`; `T` stays SomeType so
  `result := handle.await(io)` is `Option(SomeT)` and `result.unwrap()` →
  `// Failed to transpile`. The `T` must be bound from the receiver
  `handle : JoinHandle(T_concrete)` on the **field-fn-call dispatch path** (the
  receiver's `type_arguments`), which is a different code path from the FuncVal
  forall loop. TS reference prints `42` for:
  ```rust
  run :: (fn(io : Io) -> i32)({
    task := io.async((io : Io) => i32(42));
    handle := io.spawn(task, io);
    result := handle.await(io);
    result.unwrap()
  });
  ```
  (`io.spawn(task, io)` takes 2 args; `handle.await(io)` returns `Option(T)`.)
