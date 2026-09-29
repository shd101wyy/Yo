# An `io.await` in a method call's receiver does not pull in the async runtime

**Severity:** S2 — a valid program fails in the C compiler; binding the await to a local first works

**Status:** fixed
**Found:** 2026-09-30, while fixing
`issues/a-closure-bound-to-a-local-inside-an-io-async-body-emits-invalid-c.md`.
**Regression test:** `tests/cli-cases/an-await-in-a-method-receiver-pulls-in-the-async-runtime`

## Symptom

A program whose only `io.await` sits in the receiver of a method call fails
in clang (v0.2.46 seed):

```rust
main :: (fn(io : Io) -> unit)({
  s := io.await(leaf(io, i32(1)), io).to_string();   // or: println(`${io.await(f, io)}`)
  println(s);
});
```

```
error: call to undeclared function '__yo_async_poll_step'; ISO C99 and later do not support implicit function declarations
```

Every template interpolation of an awaited value has this shape. The parser
desugars `${e}` to `e.to_string()` (`src/parser.yo`), so the await ends up
in the receiver. Binding the await to a local first (`v := io.await(f, io);
println(`${v}`)`) compiles and runs.

## Root cause (measured)

Codegen emits the async runtime only when the pre-pass
`preregister_async_blocks_in_expr` (`src/codegen/exprs/async.yo`) sees an
`io.await` or `io.spawn` somewhere in a function body. That sets
`uses_async`. The pass recursed into each call's ARGUMENTS only, never into
its callee.

A method call `recv.m()` is `FnCall(FnCall(".", [recv, m]), [])`, so its
receiver lives in the callee. An await there was never seen, `uses_async`
stayed false, and the runtime (with `__yo_async_poll_step`) was not
emitted. The blocking await's poll loop still called it.

## Fix

The pass now recurses into the callee as well as the arguments. For a
macro call it walks the recorded expansion instead of the raw arguments, as
`expr_contains_await` does, since the expansion is the code codegen emits.

## Verification

- The regression cli-case builds and runs the two-line program (a receiver
  await and an interpolated await) and pins both printed lines.
- Recorded with the v0.2.46 seed before the fix, it failed with rc=1 on the
  undeclared `__yo_async_poll_step`.
