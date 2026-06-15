# Codegen: generic static-method dispatch (e.g. `ArrayList(u8).new()`)

## Status: OPEN — next Phase-3 target after the instance-method keystone

The generic-impl **instance**-method specialization keystone (commit 0acb43c23,
narrowed cc9ae1f73) handles `recv.method(args)` where the type params come from
the concrete `self` ARGUMENT. **Static** generic-impl methods — `Type.method()`
with no `self`, e.g. `ArrayList(u8).new : (fn() -> Self)` — are NOT yet handled.

## Reproducer (`/tmp/loc4.yo`)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/collections/array_list"));
main :: (fn() -> unit)({
  al := ArrayList(u8).new();
  unsafe(_a := putchar(int(i32(65))));
});
export(main);
```

- **TS**: prints `A`, rc=0.
- **self-bin (cc9ae1f73, instance-only stamping)**: compiles but `ArrayList`
  method emitted-then-undeclared (`yo_id_NNNN`), C link/decl error. (This is the
  *pre-existing* mode; the instance-method keystone deliberately leaves static
  methods here — see the narrowing commit.)

## Attempt that did NOT work (reverted)

Re-stamped static methods with the impl forall AND set `ctx.self_type` to the
concrete receiver (`ArrayList(u8)`) around `try_to_call_function_with_arguments`
in function.yo's method-call arm, so specialization would re-evaluate `.new`'s
body with `Self` bound. RESULT: `loc4` regressed to "main body all Failed to
transpile" — specialization for `.new` STILL throws (swallowed → main body gets
no ExprInfo).

## Why it throws (the real requirement)

`self_type` binds `Self` = `ArrayList(u8)`, but `.new`'s body constructs the
struct via the type parameter `T` directly (the field is `?*(T)`). `T` is a
SEPARATE forall var and is NOT bound by setting `self_type`. The instance-method
keystone works because `synthesize_types` binds `T` from the concrete `self`
ARGUMENT's type during param processing; a static method has no `self` arg, so
nothing binds `T`, the body's `?*(T)` / `T`-typed construction sees an unbound
`T`, and specialization throws.

## The fix (next session)

Bind the impl's forall vars (`T`) into the specialization env by matching the
impl RECEIVER PATTERN (`ArrayList(T)`) against the concrete receiver type
(`ArrayList(u8)`) — i.e. `synthesize_types(ArrayList(T), ArrayList(u8))` → `T =
u8`. The generic-impl matcher already computes exactly this binding
(`try_match_generic_impl` / `find_matching_generic_impl` /
`_resolve_one_forall_binding` in evaluator/values/impl.yo) but discards it. Route
those bindings into `create_specialized_function_inline`'s `callee_env` (or seed
them before `try_to_call`) for static method calls, then re-enable stamping for
static methods. Validate: `loc4` prints `A` + corpus 35/35 + std/tests.

This is a prerequisite for `String`/`ArrayList` usage in user code (their
constructors `.new()` / `.with_capacity()` are generic static methods) and hence
for the full `String.from("AB").len()` (m1) path, alongside the std-function-
body-eval gaps.
