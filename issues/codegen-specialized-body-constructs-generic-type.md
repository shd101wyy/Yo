# Codegen: specialized method body that constructs its own generic type emits a bad constructor

## Status: OPEN — follow-up edge case of the generic-impl specialization keystone (0acb43c23)

The generic-impl method-call specialization keystone handles the common cases
(method returns `T`, returns a computed value, takes extra args — see corpus
fixtures `generic_impl_method`, `generic_impl_two_params`,
`generic_impl_method_arg`). This edge case is NOT yet handled: a specialized
method body that **constructs its own generic type** with a runtime argument.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(
  object(v : T)
);
impl(
  forall(T : Type),
  Wrap(T),
  add : (fn(self : Self, delta : i32) -> i32)((self.v) + delta),
  rewrap : (fn(self : Self, nv : T) -> Self)(Wrap(T)(v : nv))   // <-- this
);
main :: (fn() -> unit)({
  w := Wrap(i32)(v : i32(60));
  w2 := w.rewrap(i32(5));
  unsafe(_a := putchar(int(w.add(i32(5)))));
  unsafe(_b := putchar(int(w2.add(i32(67)))));
});
export(main);
```

- **TS**: prints `AH` (65, 72), rc=0.
- **self-bin**: C error `too few arguments to function call, single argument 'v'
  was not specified`.

## Symptoms (generated C for the specialized `rewrap`)

```c
static inline __yo_struct_yo_id_3697* yo_id_3699(__yo_struct_yo_id_3703* self, int32_t nv) {
  __yo_struct_yo_id_3703* _file____tmp__temp_1668 = __yo_new___yo_struct_yo_id_3703();  // <-- no arg!
  return _file____tmp__temp_1668;
}
```

Two defects in the specialized body:
1. The object constructor `Wrap(T)(v : nv)` emits `__yo_new_<cName>()` with **no
   arguments** — the runtime arg `nv` is dropped. (The object-ctor branch in
   `other_fn_call.yo` reads `ei.runtime_arg_exprs_in_order` for the ctor args;
   inside the SPECIALIZED (re-evaluated) body that side info is empty/missing.)
2. The function's return type is `__yo_struct_yo_id_3697*` (Wrap with the
   abstract/parameter T) but the body constructs `__yo_struct_yo_id_3703*`
   (Wrap(i32)) — the return type isn't fully concretized for the constructor that
   the specialized body builds.

## Root hypothesis

When `create_specialized_function_inline` re-evaluates the method body, the inner
constructor call's ExprInfo (`runtime_arg_exprs_in_order`, the concrete struct
id) is not produced the way the top-level call path produces it — so codegen sees
an arg-less constructor and a stale return type. The fix likely lives in how the
specialized body's expressions get their ExprInfo during re-evaluation (ensure
nested constructor calls record their runtime args + concrete types), or in the
object-ctor emitter falling back to the call's positional args when
`runtime_arg_exprs_in_order` is empty.

Lower priority than the core keystone (common method shapes already work); revisit
when extending generic-impl coverage.
