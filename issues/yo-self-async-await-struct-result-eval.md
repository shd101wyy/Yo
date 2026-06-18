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
