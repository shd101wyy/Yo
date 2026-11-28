# An `Impl(Iterator(Item := T))` result is not a `for` source, and its `next()` emits invalid C

**Severity:** S2 — a function may declare its result `Impl(Iterator(Item := i32))`, but `for` over the result is E0610, and stepping it by `.next()` passes `yo check` and fails in the C compiler; no wrong code reaches a binary. The workaround is a named result type or a `where(I <: Iterator(Item := T))` consumer.

- Filed: 2026-11-28, finding 1 of [`plans/backlog/GENERATORS.md`](../plans/backlog/GENERATORS.md) §10 (VERDICTS-97 probes `p01` and `p01b`). A generator's value is this result type, so the bug blocks G-1. It is a general bug and is fixed whether or not generators are adopted.
- Status: open.
- No duplicate: no doc under `issues/` names `Impl(Iterator(`, and no file in `std/`, `src/`, `tests/` or `docs/` spells that result type, which is why it went unseen.

## Reproducer

Two files, each with the same `Evens` iterator and `evens :: (fn(n : i32) -> Impl(Iterator(Item := i32)))(Evens(i : i32(0), n : n));`:

- `issues/repros/2026-11-28-an-impl-iterator-result-is-not-a-for-source-and-its-next-emits-invalid-c-for.yo`: `for(evens(i32(10)), v => { sum = (sum + v); })`. Expected output `for: 20`.
- `issues/repros/2026-11-28-an-impl-iterator-result-is-not-a-for-source-and-its-next-emits-invalid-c-next.yo`: `mut(it) := evens(i32(6));` stepped by `it.next()` in a `while(true, match(...))`. Expected output `manual: 6`.

The control, VERDICTS-97 probe `p01c`, passes: the same iterator under a named result type `-> Evens`, consumed through `where(I <: Iterator(Item := i32))`, `map` and `take`, prints 20 and 9.

## Output

The v0.2.80 seed (`~/.local/bin/yo`, bundled std), 2026-11-28. The `for` file, `yo check`:

```text
error[E0610]: No method "into_iter" on Impl(Iterator): the type has no field or method with that name.
Receiver slot types probed: Impl(Iterator), &Impl(Iterator), &mut Impl(Iterator), &&Impl(Iterator).
   --> 2026-11-28-an-impl-iterator-result-is-not-a-for-source-and-its-next-emits-invalid-c-for.yo:27:3
   |
27 |   for(evens(i32(10)), v => {
   |   ^
help: run `yo explain E0610` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

The `next` file: `yo check` reports `evaluator OK`; `yo compile`:

```text
/tmp/genplan-out/a.out.c:2401:32: error: initializing '__yo_t_8199573317496628191' (aka 'struct __yo_t_8199573317496628191_struct') with an expression of incompatible type '__yo_t_14164386760141089438' (aka 'struct __yo_t_14164386760141089438_struct')
7 warnings and 1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/genplan-out/a.out.c
```

A stage 1 of `d5f2a339e` (develop `56933fcd8` plus one fix, run with this tree's std) gives the same E0610 and the same C error with other type hashes.

## Root cause (first pass)

- **`next`.** The call on the `Impl(Iterator(Item := i32))` binding is typed by the trait's member signature with the associated type left abstract. The temporary's C type is the struct the emitted C comments `//  : Option(Item)`, whose `Some` payload is a `void*` (`void* __yo_pat___yo_v_v = ….data.__yo_v_Some.__yo_v_value;`); the callee, `Evens.next`, returns the `Option(i32)` struct. The `Item := i32` binding of the `Impl(...)` wrapper (the reserved SomeT `Impl`, `src/types/definitions.yo`) is not substituted into the member's result type, or the hidden concrete type is not used to type the call.
- **`for`.** `for` desugars to `.into_iter()`, which every iterator gets from the prelude's blanket `impl(generic(I : Type), where(I <: Iterator), I, into_iter : …)` (`std/prelude.yo`, "Blanket methods"). The method probe on an `Impl(Iterator)` receiver finds the trait's own members but does not try a blanket impl whose `where` bound the wrapper's trait satisfies, so every blanket combinator (`map`, `take`, …) is missing on the result too.

The `Dyn` form has the same unsubstituted `Option(Item)` in its vtable thunk: `issues/2026-11-28-a-box-dyn-iterator-next-emits-invalid-c.md`.

## Test

The test lands with the fix (G-0d): both reproducers as cases in `tests/`, `for`, `next`, a blanket adapter and a move of the result.
