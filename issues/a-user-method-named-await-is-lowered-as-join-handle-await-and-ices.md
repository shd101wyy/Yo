# A user method named `await` is lowered as `JoinHandle.await` and ICEs

**Severity:** S1 — an internal compiler error on a valid program: any type with a method named `await` cannot be compiled when the method is called.

**Status: OPEN.** Found 2026-10-03 by `plans/ASYNC_IO_API_AUDIT.md` (finding F8, probe 2). **Measured on:** develop `bcb57bfe7` built by the v0.2.49 seed.

## Symptom

`issues/repros/a-user-method-named-await-is-lowered-as-join-handle-await.yo`:

```rust
Thing :: struct(v : i32);
impl(Thing, await : (fn(self : Self, io : Io) -> i32)(self.v));
main :: (fn(io : Io) -> unit)({
  t := Thing(v : i32(5));
  println(`user await method: ${t.await(io)}`);
});
```

- `yo check`: evaluator OK.
- `yo compile`:

```
yo: error: internal compiler error: JoinHandle.await return type must be Option(T)
```

## Cause

The routing to the `JoinHandle.await` lowering is syntactic. `is_join_handle_await_call` (`src/evaluator/async/await_analysis.yo` 180–217) matches any `x.await(...)` whose receiver is not spelled `io`, without consulting the resolved callee (`__yo_join_handle_await`). `generate_join_handle_await` (`src/codegen/exprs/await.yo` 650–652) then asserts the return type is `Option(T)` and fails. The sibling check `_is_dot_access(expr, "io", "await")` (`await_analysis.yo` 164–170) has the mirror problem: a receiver NAMED `io` of any type is treated as the `Io` effect.

## Expected

Method dispatch by the resolved callee: the `JoinHandle.await` lowering fires only when the call resolves to `__yo_join_handle_await`, and the `io.await` lowering only when the receiver's type is `Io`. A user method named `await` compiles and runs like any other method.

## Fix direction

Key both matchers on `ExprInfo`'s resolved callee / receiver type instead of the spelling. Regression tests: the repro (prints `5`), and a struct with a field named `io` that has an `await` method. Plan: `plans/ASYNC_IO_API_AUDIT.md` A5.
