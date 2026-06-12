# Codegen: `ref(r) := obj.field` emits initializer without `&` (C compile error)

**Status: FIXED 2026-06-12.** Three coordinated changes:

1. Codegen (src/codegen/exprs/initialization-assignment.ts): a ref
   binding with a property-access RHS now generates the raw field LVALUE
   (no temp materialization) and takes its address —
   `T* r = (&(h->s));` — the same `&` discipline as projection methods.
2. Evaluator (initialization-assignment.ts): the RHS temp of a borrow
   binding is marked NON-owning (no dup happened, so its scope-end drop
   over-released the field).
3. Evaluator (assignment.ts, BOTH compilers): reassignment no longer
   flips a `ref` binding/parameter to RC-owning — writing through a
   borrow stores into the OWNER's storage; the flip generated a spurious
   scope-end `drop((*r))` → double free (gmalloc-verified). The yo-self
   mirror also restores `is_ref`/`is_parameter` across reassignment
   (they were dropped to `false`, silently disabling ref-aware gates).

Regression tests: tests/ref_field_borrow.test.yo (object field read,
write-through, scalar field, value-struct field) — write-through shape
gmalloc-verified clean (was exit 139).

## Repro

```rust
Holder :: object(s : String);

main :: (fn() -> unit)({
  h := Holder(s : String.from("hello"));
  ref(r) := h.s;     // evaluator OK
  println(r);
});
```

`yo-cli compile` fails in the C compiler:

```
error: initializing '__yo_struct_..._23 *' with an expression of
incompatible type '__yo_struct_..._23'; take the address with &
  __yo_struct_..._23* r = _yo..._temp_40758;
```

The field projection materializes the field VALUE into a temp and binds
the `ref` (a `T*`) to it without `&` — the binding emission for
`ref(r) := <property-access>` must either take the address of the field
lvalue in place (`&h->s`, matching `xs.project(i)`'s `&` discipline) or
reject the shape in the evaluator if field-borrows of object fields are
not meant to be expressible this way.

Note: the working borrow idiom today is a projection method returning
`ref(T)` (e.g. ArrayList.project's `unsafe(&(bytes(pos)))`). Direct
`ref(r) := obj.field` is the gap.
