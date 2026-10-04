# A body-tail `inout` binding of an RC-holding value struct redeclares the C parameter

**Status: FIXED (2026-10-04).**

**Severity:** S2 — a valid program (a method taking `inout(self) : Self` on a value struct with an RC field, returning `self` as its body tail) is rejected by the C compiler; no wrong code is produced.

## Symptom

```rust
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
Bag :: struct(items : ArrayList(i32), n : i32);
impl(
  Bag,
  touched : (fn(inout(self) : Self, x : i32) -> Self)({
    self.n = x;
    self
  })
);
main :: (fn() -> unit)({
  b := Bag(items : ArrayList(i32).new(), n : i32(1));
  c := b.touched(i32(5));
  println(b.n);
  println(c.n);
});
export(main);
```

`yo compile` (seed v0.2.50 and develop) fails in clang:

```
error: redefinition of '__yo_v_self' with a different type: '__yo_t_…' (aka 'struct …') vs '__yo_t_… *'
  __yo_t_… __yo_v_self = (*__yo_v_self);
error: returning '__yo_t_… *' from a function with incompatible result type '__yo_t_…'; dereference with *
  return __yo_v_self;
```

The emitted body was

```c
static inline Bag touched(Bag* __yo_v_self, int32_t __yo_v_x) {
  (*__yo_v_self).__yo_v_n = __yo_v_x;
  Bag __yo_v_self = (*__yo_v_self);            // shadows the pointer parameter
  Bag temp_dup_struct_0 = (*__yo_v_self);
  temp_dup_struct_0.__yo_v_items = __yo_incr_rc(temp_dup_struct_0.__yo_v_items);
  temp_dup_struct_0;
  return __yo_v_self;                          // the pointer, not the value
}
```

The same happens for a plain `inout(x) : Bag` parameter and for a generic
struct (`HashMapEntry(K, V)`-shaped `inout(self)` methods). A struct of
scalars only compiled: its tail carries no deferred dup, so it took the plain
`return (*self);` path. An explicit `return(self)` and a `cond`/`match` arm
tail were already correct.

## Root cause

`generate_function_body` (`src/codegen/functions/generation.yo`), the
deferred-dup branch of the body-tail return: it materialized the tail into
its eval temp unless the temp's name equalled the tail's rendering. The tail
atom `self` is SELF-NAMED — its recorded `variable_name` is the variable
itself, not a minted temp — so the "temp" is `__yo_v_self`, while an `inout`
binding renders as `(*__yo_v_self)`. The spellings differ, so it declared
`T __yo_v_self = (*__yo_v_self);` and later returned the temp name, i.e. the
pointer parameter. The explicit-`return` path (`generate_return`) and the
call-tail path (`handle_func_call_deferred_dup`) in `return.yo` already skip a
self-named atom and use its rendering; the body-tail path lacked that guard.

## Fix

The body-tail deferred-dup path checks `is_self_named_atom`: a self-named
tail declares nothing and returns its own rendering (`(*__yo_v_self)` for an
`inout` binding). The struct dup still runs, incrementing the shared `items`
handle, so the returned bit-copy owns its own reference.

## Test

`tests/ref_params.test.yo`:

- "returning an inout self of an RC-holding value struct as the body tail"
- "returning a plain inout parameter of an RC-holding value struct as the body tail"
- "returning an inout self of a generic RC-holding value struct as the body tail"

Each asserts the caller's place, the returned copy, and `ref_count(...) == 2`
for the shared list (the copy holds its own +1).
