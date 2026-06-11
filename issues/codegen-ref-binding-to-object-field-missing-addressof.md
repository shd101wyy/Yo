# Codegen: `ref(r) := obj.field` emits initializer without `&` (C compile error)

**Status: OPEN** — verified 2026-06-12. NOT a silent miscompile: the
emitted C fails to compile, so no UB escapes — but the evaluator accepts
a shape codegen cannot emit.

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
