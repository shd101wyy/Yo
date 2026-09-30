# An `io.async` future stored as an enum payload emits a nested `typedef`

**Severity:** S2 — a valid program fails in the C compiler. `yo check` passes.
**Found:** 2026-09-30, writing `with_allocator` (`plans/EXPLICIT_ALLOCATORS.md` P3), whose scope guard first held an `Option(*T)`. The same error reproduces on develop at `f7f1331fb`.

## Reproducer

```rust
_Holder :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(r : Option(T))));
_wrap :: (fn(generic(T : Type), f : Impl(Fn() -> T)) -> T)({
  h := _Holder(T)(r : .None);
  f()
});
main :: (fn(io : Io) -> unit)({
  task := _wrap(() => io.async((io : Io) => i32(8)));
  println(io.await(task, io));
});
```

```
error: type name does not allow storage class to be specified
error: field has incomplete type 'struct __yo_t_…_struct'
error: unknown type name '__yo_t_…'
```

The C shows the Future interface's on-demand forward declaration written inside
the variant union of `Option(Impl(Future(i32, Io)))`:

```c
typedef union {
  struct {
typedef struct __yo_t_…_struct __yo_t_…; // Forward declaration (on-demand)
    __yo_t_…* value;
  } Some;
} __yo_t_…_data;
```

## Cause

The enum twin of
`issues/fixed/an-async-closure-capturing-a-future-parameter-emits-a-nested-typedef.md`.
Resolving a payload's C type string can fire the on-demand declaration hook into
the same buffer. `generate_struct_declaration` resolves its field types before the
aggregate opens (`_prewarm_runtime_field_types`), but `generate_enum_declaration`
(`src/codegen/types/generation.yo`) resolved each payload type after
`typedef union {` had been emitted.

## Fix

The loop that decides whether the union has members, which runs before the union
opens, now resolves every non-unit payload type. Any on-demand declaration lands
at top level. The regression test is "a future type as an enum payload declares
the payload type first" in `tests/async_generic_future_return.test.yo`. The
reproducer failed on a stage-1 without this change and prints 8 with it.

Still open, and a different defect: storing the future AND reading it back
through the struct, `issues/fixed/an-io-async-future-in-a-generic-struct-field-lowers-to-two-c-types.md`.
