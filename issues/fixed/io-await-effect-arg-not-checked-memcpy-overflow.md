# io.await/io.spawn accepted ANY effect argument — codegen then memcpy'd sizeof(E) out of it

**Found**: 2026-08-27 triaging the CI red streak (every platform `test` leg +
8 hollow-sweep REDs since the D5-era test files landed). **Fixed**: same day
(branch `s3/async-combinators`): evaluator layout gate in
`src/evaluator/calls/helper.yo` (Step 7c) + the 8 mis-written test files
repaired. Pinned by `tests/async/effect_bundle.test.yo`.

## Symptom

`io.await(fut, e)` (and `io.spawn`) never type-checked `e` against the
future's effect bundle `E`. All of these were accepted silently:

```rust
give :: (fn(io : Io) -> Impl(Future(usize, IoExn)))(io.async((e) => usize(11)));
io.await(give(io), { io });   // one-field record for a two-field bundle
io.await(give(io), io);       // bare Io for an IoExn bundle
```

Codegen's effect injection then did
`sm->__yo_param_0 = *((E_of_the_future*)&caller_bundle_local);` — a
`sizeof(IoExn)` (40-byte) copy out of a smaller stack local. On CI (working
ASan): `stack-buffer-overflow ... READ of size 40 in _set_effect` — the
failure behind every red `test` platform leg and 6 of the 8 hollow-sweep RED
files (the other 2 passed a bare `io`). Locally invisible: ASan is
non-functional on the dev box, and the garbage `exn` field was never invoked.

## Why the type system missed it

Two stacked holes (both remain OPEN as general problems, see
`issues/generic-type-var-rebinds-per-argument.md`):

1. **Per-argument re-binding of call generics** — the signature's two `E`
   mentions (`fut : Impl(Future(T, E))`, `e : E`) resolve through SEPARATE
   SomeT lineages; each argument's Step-8 compatibility check compares
   against bindings as of THAT argument, and each lineage is self-consistent.
2. **`are_types_compatible` is structurally lenient in BOTH directions** for
   structs — `IoExn` vs `{io}` reports compatible both ways (a face of C18's
   missing-field leniency).

## Fix

An explicit contract check at the call layer (`helper.yo` Step 7c), where
both sides are concrete: for `io.await`/`io.spawn`, when the future's effect
row has one effect type and both it and the effect argument are top-level
structs, they must share the struct id **or the exact field-label list** — so
the documented structural construction `{ io, exn }` (std/error.yo) stays
legal, while `{ io }` and bare `io` for an `IoExn` future are errors:

```
Error: Effect argument does not match the future's effect bundle:
- The future's effect type: IoExn
- The argument's type      : <struct:...>
Pass the future's own bundle (e.g. `IoExn(io : io, exn : exn)` ...) — a
mismatched record corrupts the task's effect state.
```

SomeT-bearing (unresolved/generic, def-time) sides skip — each concrete call
re-checks.

## Consumers repaired

The 8 test files (all 2026-08-26-era, all mine) that used `{ io }` or bare
`io` for IoExn futures now build a real bundle via a `_ioexn(io)` helper
(`Exception` that fails the test on any throw): `async_assign_await`,
`async_loop_buffer_await`, `async_unit_tail_await`,
`async_generic_param_capture`, `async_trait_default_await`,
`generic_impl_async_self`, `io/async_traits`, `io/bufio`.
