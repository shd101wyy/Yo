# A `Future(String, Io)` interface body was emitted before `String`'s typedef

**Status: FIXED (2026-09-27).** Found while adding `return(io.await(...))`
tests to `tests/async_await.test.yo`. The bug is pre-existing and reproduces
under the v0.2.44 seed. **Measured.**

## Symptom

```
.yo_selftest_batch_1_0.bin.c:652:3: error: unknown type name '__yo_t_14473186678385204185'
  __yo_t_14473186678385204185 result;
```

The failing struct is `struct <Future(String, Io)>_struct { ... result; ... }`
(the generic Future interface). The typedef it names,
`typedef ... __yo_t_14473186678385204185; // String`, comes about 120 lines
*later* in the declarations.

## Minimal reproducer (delta-debugged from the test batch)

```rust
main :: (fn() -> unit)({
  io :: __yo_builtin_io;
  inner := io.async((io : Io) => { return(`seven`); });
  outer := io.async((io : Io) => { n := io.await(inner, io); return(n); });
  s := io.await(outer, io);
});
export(main);
```

The trigger needs the test runner's `io :: __yo_builtin_io` form of `main`
together with a nested `io.async` whose result is a newtype (`String`).
- With `main :: (fn(io : Io) -> unit)` it compiles.
- It compiles with an `i32` result.
- It compiles without the nesting.

So any test file with that shape failed to compile as a batch, and every test
in the batch with it.

## Root cause

- The Future interface type was first met by the on-demand declaration hook
  (`_on_demand_collect_and_declare`, `src/codegen/codegen_c.yo`) while
  `generate_type_declarations` was still running its passes. A capture
  struct's field was its first use.
- The hook emitted the whole body at once. The body embeds the result type
  **by value** (`result`), and `String`'s newtype typedef is emitted by a
  later pass.
- Newtypes have no forward-declarable form (`typedef Inner* String;`), so
  the body named an undeclared type.

## Fix

- While the passes run (`CodeGenContext.type_declaration_passes_done`
  is false), the hook emits only the Future's forward typedef.
  Every use of the interface during declarations is through a pointer.
- Pass 5 (dyn/union/future), which runs after every other pass, emits the body.
- A deferred interface the hook met *during* pass 5, after its key walk had
  passed it, is emitted right after pass 5 (`on_demand_fwd_only`).
- After the passes, the hook emits bodies at once, as before.
- Emission is unchanged where the hook does not fire for a Future during the
  passes. That was verified byte-identical on three probe programs against the
  previous build.

## Regression test

`tests/async_await.test.yo` now has a batch containing both an `i32` and a
`String` nested `return(io.await(...))` test. Before the fix the whole batch
failed to compile.
