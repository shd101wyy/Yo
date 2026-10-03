# A generic `io.async` body ending in a bare-variant `match` gets a second C result type

**Severity:** S2 — a valid program fails in the C compiler while `yo check` passes: any generic function returning `Impl(Future(Result(T, E), …))` whose async body ends in a `match` that builds bare `.Ok(...)` / `.Err(...)` variants.

**Status: FIXED 2026-10-03.** Found 2026-10-03 while turning `std/async`'s `timeout` into a future (phase A1 of `plans/ASYNC_IO_API_AUDIT.md`). **Measured on:** the v0.2.49 seed and a tree build of develop `576be6e06`; both fail the same way.

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

## Cause

Not async-specific: `-> Impl(Fn(k : i32) -> Result(T, E))` with the same tail failed the same way. A generic function's specialized return type (`spec_ret_ty`, `src/evaluator/calls/helper.yo`) substitutes the forall arguments by SomeT occurrence, collecting the occurrences with `get_all_some_types`. An `Impl(...)` wrapper is ONE SomeT to that walk, which never looks inside its required traits, so the `T` inside `Future(Result(T, E), Io)` stayed unresolved. The `io.async` call bound its own `T` to that expected output, the closure body kept it as the expected type, and the bare `.Ok(x)` took the generic `Result(T, E)` (payload `void*`) while the await site used the specialized `Result(i32, E)` (payload `int32_t`): two C structs for one Yo type. The `wrap(wrap(x))` keying fix (#1116) could not help — the two TypeValues really differ. A typed local worked because it evaluates `T` by name in the body's env.

## Workaround in the tree (removed with the fix)

`std/async`'s `timeout` binds its result to a typed local. It keeps it until `SEED_VERSION` carries this fix, because the seed compiles std/http's `timeout` call into the compiler and fails there (measured 2026-10-04 with the v0.2.50 seed: clang `initializing 'Result(HttpResponse, TimeoutError)' with an expression of incompatible type 'Result(T, TimeoutError)'`). Generation B in `plans/backlog/SEED_VERSION_AUTOMATION.md` writes it back as a bare `match`.

## Fix direction

Infer the tail's variants against the specialized result type the state machine's `result` field is emitted with. Regression test: the reproducer compiles and prints 5.

## Fix

The occurrence fallback in the specialization path (`src/evaluator/calls/helper.yo`) also collects the SomeTs inside an `Impl` wrapper's trait arguments (`collect_wrapper_trait_somes`) and applies the substitution with `_substitute_wrapper_carriers` (`src/evaluator/types/function.yo`), which resolves the carriers and keeps the wrapper's id — the async state machine is registered against it.

Regression tests: "a generic Impl(Future(Result(T, E))) body ending in a bare-variant match" and "a generic Impl(Fn(...) -> Result(T, E)) closure ending in a bare-variant match" in `tests/async_generic_future_return.test.yo`.
