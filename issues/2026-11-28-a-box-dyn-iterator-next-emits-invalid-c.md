# `Box(Dyn(Iterator(Item := T)))` passes `yo check` and its `next` thunk emits invalid C

**Severity:** S2 — an erased iterator `Box(Dyn(Iterator(Item := i32)))` built with `dyn(Box.new(...))` passes `yo check`, and the C compile fails in the `Dyn` wrapper for `next`; no wrong code reaches a binary. There is no workaround that keeps the erasure.

- Filed: 2026-11-28, finding 2 of [`plans/backlog/GENERATORS.md`](../plans/backlog/GENERATORS.md) §10 (VERDICTS-97 probe `p01d`). The erased form is how a recursive or stored generator is held, so the bug blocks G-2. It is a general bug and is fixed whether or not generators are adopted.
- Status: open.
- No duplicate: no doc under `issues/` names `Dyn(Iterator(`, and no file in `std/`, `src/`, `tests/` or `docs/` spells it.

## Reproducer

`issues/repros/2026-11-28-a-box-dyn-iterator-next-emits-invalid-c.yo`: an `Evens` iterator boxed as `(mut(boxed) : Box(Dyn(Iterator(Item := i32)))) = dyn(Box.new(Evens(i : i32(0), n : i32(10))));` and stepped by `boxed.next()`. Expected output `boxed: 20`.

## Output

The v0.2.80 seed (`~/.local/bin/yo`, bundled std), 2026-11-28: `yo check` reports `evaluator OK`; `yo compile`:

```text
/tmp/genplan-out/a.out.c:1277:10: error: used type '__yo_t_8199573317496628191' (aka 'struct __yo_t_8199573317496628191_struct') where arithmetic or pointer type is required
9 warnings and 1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/genplan-out/a.out.c
```

A stage 1 of `d5f2a339e` (develop `56933fcd8` plus one fix, run with this tree's std) gives the same error with another type hash.

The failing line is the `Dyn` wrapper the codegen writes for `next`:

```c
static __yo_t_8199573317496628191 __yo_wrap___yo_t_9240772080484642047___yo_t_5858210373496575943_P___yo_v_next(void* self_ptr) {
  return (__yo_t_8199573317496628191)yo_id_2691851600975676037000000(((__yo_t_9240772080484642047*)self_ptr));
}
```

`__yo_t_8199573317496628191` is the struct the C comments `//  : Option(Item)`; the impl's `next` returns the `Option(i32)` struct, and C cannot cast one struct to another.

## Root cause (first pass)

The vtable slot for `next` is typed from the trait's member signature with the associated type `Item` left abstract: the `Item := i32` binding of `Dyn(Iterator(Item := i32))` is not substituted into the slot's result type. The wrapper then casts the concrete result to the abstract `Option(Item)` struct. The same unsubstituted `Option(Item)` types `next` on an `Impl(Iterator(Item := i32))` result: `issues/2026-11-28-an-impl-iterator-result-is-not-a-for-source-and-its-next-emits-invalid-c.md`. A trait with an associated type that appears in a member's result, behind a `Dyn` with the binding spelled, is the general shape.

## Test

The test lands with the fix (G-0d): the reproducer as a case in `tests/`, plus a `for` over the box once `Box(I) <: Iterator` exists (G-2).
