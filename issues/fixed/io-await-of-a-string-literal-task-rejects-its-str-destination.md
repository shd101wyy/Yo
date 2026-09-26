# `io.await` of a string-literal task rejects its `str` destination

**Status:** FIXED (2026-09-26)
**Found:** 2026-09-26, develop's tier-1 battery after #939 (`tests/codegen-bootstrap/io_async_str.yo`, corpus golden scoring: `compile_rc=1`)

## Symptom

```rust
run :: (fn(io : Io) -> str)({
  task := io.async((io : Io) => "hello async");
  io.await(task, io)
});
```

```
error[E0601]: Cannot unify incompatible types: "comptime_str" and "str"
  --> tests/codegen-bootstrap/io_async_str.yo:4:5
```

Any `str` destination fails the same way (`(s : str) = io.await(task, io)`);
with no destination (`x := io.await(task, io); x`) the program checks and
prints `hello async`.

## Root cause

The task's output type is the async closure's result, the literal's
`comptime_str`. Before #939, `io.await`'s result binder was still unresolved
when the call's return type was synthesized against the expected `str`
(`src/evaluator/calls/helper.yo`, Step 10), so the binder was simply bound to
`str`. #939 made a binding record the binder it resolves, so the result now
resolves to the task's real output, `comptime_str`, and Step 10 met the pair
(`comptime_str`, `str`).

The synthesizer's tag-mismatch fallback accepted a comptime numeric against a
runtime numeric, but not a `comptime_str` against a `str`; its comment said
that pair "deliberately keeps throwing" because it was untested. The flow
relation accepts it (`comptime_str` flows into `str` and C-string slots,
`plans/reference/TYPE_IDENTITY.md`), so the synthesizer rejected a pair that
flow allows.

## Fix

`_flow_coercion_without_binders` (`src/evaluator/types/synthesizer.yo`), which
the extern-opaque change introduced for a C scalar into an extern opaque type,
also takes a `comptime_str` source: a pair with no SomeTs to bind is accepted
exactly when `are_types_compatible(source, destination)` holds, in the
direction the call site names (`SynthesizeOptions.expected_is_source`). A
runtime `str` is still not a `comptime_str`, and a `String` destination is not
one of the literal's flows.

Gates: `tests/async_await.test.yo`, "Test io.await of a string-literal task
into a str destination" (tail position and a typed binding), and the corpus
file itself under `scripts/bootstrap/gates_fast.sh`.
