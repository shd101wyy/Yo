# `Dyn(A, B)` and `Dyn(B, A)` are one type to the checker and two C types to codegen

**Status:** OPEN
**Found:** 2026-09-27, Dyn upcast feasibility audit (`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 2.8).
**Measured:** yo 0.2.44 seed. `yo check` rc=0; `yo compile --optimize 2` fails in clang.
**Repro:** `issues/repros/dyn-trait-order-is-part-of-its-c-type.yo`

## Symptom

```rust
A :: trait(a : (fn(self : Self) -> i32));
B :: trait(b : (fn(self : Self) -> i32));
C :: ref(struct(n : i32));
impl(C, A(a : (self -> self.n)));
impl(C, B(b : (self -> (self.n + i32(100)))));
take :: (fn(d : Dyn(B, A)) -> i32)((d.a() + (d.b() * i32(1000))));
main :: (fn() -> unit)({
  (x : Dyn(A, B)) = dyn(C(n : i32(1)));
  r := take(x);
  println(`${r}`);
});
```

```
error: used type '__yo_t_10227950232671659701' where arithmetic or pointer type is required
  int32_t _file_… = yo_id_…((__yo_t_10227950232671659701)(x));
```

## Mechanism (READ)

The language treats a `Dyn`'s trait list as a set: the flow relation compares it in both
directions (`src/types/compatibility.yo`, DynT arm), the registry id is sorted
(`src/evaluator/values/type_trait_methods.yo`), and `docs/en-US/TYPE_REFLECTION.md` says
`Dyn(A, B)` equals `Dyn(B, A)`. But `evaluate_dyn_type` keeps the source order
(`src/evaluator/types/dyn.yo`), and codegen's `type_key` for `DynT` concatenates the trait ids in
list order (`src/types/type_key.yo`), so the two spellings get two C structs with the vtable slots
in two orders. A cast between them is not valid C; were it hidden, the slots would be read in the
wrong order.

## Fix direction

One canonical order for a `Dyn`'s trait list, established where the type is built, so every
consumer (type_key, the vtable layout, `type_to_string`) sees the same list.
