# A generic `io.async` body ending in a bare-variant `match` gets a second C result type

**Severity:** S2 — a valid program fails in the C compiler while `yo check` passes: any generic function returning `Impl(Future(Result(T, E), …))` whose async body ends in a `match` that builds bare `.Ok(...)` / `.Err(...)` variants.

**Status: OPEN.** Found 2026-10-03 while turning `std/async`'s `timeout` into a future (phase A1 of `plans/ASYNC_IO_API_AUDIT.md`). **Measured on:** the v0.2.49 seed and a tree build of develop `576be6e06`; both fail the same way.

## Reproducer

`issues/repros/a-generic-io-async-body-ending-in-a-bare-variant-match-gets-a-second-c-result-type.yo`:

```rust
E :: enum(X, Y);
g1 :: (fn(generic(T : Type), v : Option(T), io : Io) -> Impl(Future(Result(T, E), Io)))({
  b := Box(Option(T))(v);
  io.async((io : Io) => {
    c := b.*;
    match(c, .Some(x) => .Ok(x), .None => .Err(E.X))
  })
});
main :: (fn(io : Io) -> unit)({
  r := io.await(g1(Option(i32).Some(i32(5)), io), io);
  ...
});
```

```
error: assigning to '__yo_t_9143297697472274265' … from incompatible type '__yo_t_8666031036190591035'
error: incompatible integer to pointer conversion initializing 'void *' with an expression of type 'int32_t'
```

## Measured matrix

| Variant | Result |
| --- | --- |
| as above (generic `T`, bare-variant `match` tail) | C compile error |
| same, tail bound first: `(out : Result(T, E)) = match(...); out` | prints 5 |
| non-generic (`T := i32` written out) | prints 5 |

## Cause (not yet traced)

The tail's bare variants are inferred against the body's specialized result type in one place and against the generic `Result(T, E)` in another, so the state machine's `result` field and the value assigned to it end up as two C structs for the same Yo type. It is the same family as `issues/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.md` and `issues/io-async-variant-inference-passes-check-but-fails-compile.md`.

## Workaround in the tree

`std/async`'s `timeout` binds its result to a typed local before returning it; remove that when this is fixed.

## Fix direction

Infer the tail's variants against the specialized result type the state machine's `result` field is emitted with. Regression test: the reproducer compiles and prints 5, plus `timeout`'s tail written back as a bare `match`.
