# `dyn(...)` auto-boxing drops a cell-handle view as the box type

**Severity:** S3 — no user program can reach it (a safe file cannot retype `Rc`), but it kept the v0.2.73 seed from lowering V5's `Rc`/`Arc` over `__yo_cell`, which moves V5 cells Generation B (the std retype) from v0.2.74 to v0.2.75.

**Status:** fixed in the compiler by V5 cells Generation A (`vbd/v5-gen-a-completion`). The arm is dead in the tree until `Rc`/`Arc` are views. The regression rows go live with cells Generation B (v0.2.75), which moves this doc to `issues/fixed/`.

## Symptom

`std/prelude.yo` was retyped to V5's shape (`plans/VALUES_BY_DEFAULT.md` §3.5, "Left to V5"):

```yo ignore
Rc :: (fn(comptime(V) : Type) -> comptime(Type))(newtype(_cell : __yo_cell(V)));
Arc :: (fn(comptime(V) : Type, where(V <: (Send, Sync))) -> comptime(Type))(newtype(_cell : __yo_atomic_cell(V)));
```

The v0.2.73 seed was then run over it with `--std-path`. `Rc.new`, `Rc.clone`, `ref_count`, auto-dereference, `.*`, `downgrade`/`upgrade`, `try_unwrap`, `make_mut` and `Arc.new`/`Arc.clone` all compile and run. Every `dyn(...)` of a value fails in the C compiler:

```
tmp/dyn2.out.c:2397:110: error: expected expression
 2397 |   __yo_t_9194311686767144431 __yo_v_f = /* Error: dyn() requires an object type (use rc() for value types) */;
```

A recognized `dyn(Rc.new(<closure>))` is rejected one step earlier:

```
error[E0613]: Cannot infer the type parameter `T` of `Rc` in `Rc.new(...)`: no argument binds it.
```

Reproducer (run against the retyped std):

```yo
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  (f : Dyn(Fn(x : i32) -> i32)) = dyn((x : i32) => (x + i32(1)));
  assert(f(i32(1)) == i32(2), "dyn");
});
export(main);
```

## Root cause

`_create_box_type_via` (`src/evaluator/values/dyn.yo`) evaluates the prelude's cell type constructor (`Rc`, or
`Arc` for a `Dyn(..., Send)`) over the payload type. It kept the result only if `is_reference_struct_type`, which
is the old `ref(struct((*) : V))` shape. A view (`cell_handle_view`) is a newtype, so the function answered
`.None`. That led to two failures:

- The auto-box path built no box. The payload stayed unboxed, and codegen refused it (`generate_dyn_call`'s
  object-type guard).
- The recognized `dyn(Rc.new(<closure>))` path got no type to preset on `Rc.new`'s receiver, so static-argument
  inference had nothing to bind `T` with (E0613).

The v0.2.71 seed-predicates work (`feat/v5-seed-predicates`) taught every handle predicate "old shape or view"
and tested each one with test-local handles (`tests/fixtures/cell_handles.yo`). The auto-box picks the prelude's
`Rc` by name, though, and a test-local handle cannot stand in for it. So this site was never exercised.

## Fix

`_create_box_type_via` accepts `is_reference_struct_type(bt) || cell_handle_view(bt).is_some()`. The rest of
the box path already handled views: `_unwrap_box_for_method_lookup`, codegen's `generate_dyn_call` guard
(`is_counted_handle_type`), and the box wrappers (`_dyn_data_c_type`, `src/codegen/functions/dyn.yo`).

## Verification

- Generation A: `src/main.yo`'s emitted C is byte-identical, because the arm is dead while `Rc`/`Arc` are `ref`
  objects. A tree-built binary runs `tests/handle_constructors.test.yo`, `tests/dyn.test.yo`,
  `tests/rc.test.yo`, `tests/arc.test.yo` and `tests/async_await.test.yo` over the retyped std (branch
  `vbd/v5-cells-gen-b`); the results are in the PR body.
- Generation B: those files' `dyn(...)` rows (`dyn(i32(1)) boxes through Rc(i32).new`, the recognized
  `dyn(Rc.new(<closure>))` rows) are this doc's regression tests against the shipped std.
