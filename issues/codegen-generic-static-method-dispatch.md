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

## REFINED finding (the binding already exists; specialization is the gap)

`get_type_trait_methods_by_name_from_env` (the STATIC lookup) DOES consult the
generic-impl fallback, and `_inject_forall_captures` (impl.yo:652) ALREADY binds
`T = u8` into the resolved `.new` FuncVal's CAPTURES. So `T` is available. The
real gaps:

1. **No specialization → skipped at codegen.** A static method is NOT specialized
   (no `self` arg → the keystone's arg-driven spec doesn't fire), so `.new` keeps
   its generic `func_id` and its registered Func type still has a `Self`/SomeT
   return. `should_skip_function_codegen` (declarations.yo) therefore skips
   emitting it → the call site references an undeclared `yo_id_NNNN`. Instance
   methods avoid this because spec mints a NEW func_id with a CONCRETE registered
   type (helper.yo:1125).
2. **Stamping static methods makes spec THROW.** Re-stamping `.new` with
   `forall_names=[T]` makes step12b spec fire, but `create_specialized` binds
   forall from `arg_values.forall_args` (EMPTY for `.new`) — it ignores the
   capture-injected `T=u8` — so `T` is unbound in the spec body and it throws.

## The fix (next session)

Specialize static generic-impl methods using the CAPTURE-injected forall binding
rather than `forall_args`: in `create_specialized_function_inline`, when a forall
label isn't supplied via `forall_args` but IS present in the FuncVal's captures
(a `TypeVal` capture named `T`, injected by `_inject_forall_captures`), seed it
from there. Then re-enable stamping for static methods. That yields a specialized
`.new` with a concrete func_id + concrete registered type (return `ArrayList(u8)`)
that codegen emits and the side-table dispatches. Validate: `loc4` prints `A` +
corpus 35/35 + std/tests/yo-self.

(Earlier idea — matching the receiver pattern to get `T` — is unnecessary: the
matcher already did it and stored `T` in the captures; the work is routing the
capture into specialization.)

## CRITICAL path finding (2026-06-15, attempt 2 — also reverted)

`ArrayList(u8).new()` does NOT go through the `.None` instance-method path
(`_try_find_receiver_method` → `try_to_call`'s step-6). Its callee
`.`(ArrayList(u8), new) is a property access on a `TypeVal`, which RESOLVES
`new` to the `.new` FuncVal directly — so the call dispatches through the
**FuncVal-call arm** (`callee_value = Some(FuncVal)`), a different code path.

Evidence: attempt 2 added the capture-seeding to step-6 of `try_to_call` AND set
`ctx.self_type` in the `.None` method arm AND re-stamped static methods. `loc4`
STILL showed "main body Failed to transpile" — re-stamping `.new` makes the
FuncVal-arm specialization throw (forall `T` unbound there; the step-6
capture-seeding I added lives in the `.None` arm, which static `.new` never
reaches).

So the REAL location for the fix is the **FuncVal-call arm's specialization**
(the `callee_value = Some(.TypeVal(Func))` → `try_to_implement_function...` /
the path that calls `create_specialized_function_inline` for a directly-resolved
FuncVal), where the capture-injected `T` must be seeded before spec. The
narrowed keystone state (cc9ae1f73) — which does NOT stamp static methods — is
correct and safe; static dispatch needs the capture-seeding wired into the
FuncVal-arm spec, plus stamping re-enabled. Two attempts (self_type; step-6
capture-seeding in the `.None` arm) were on the wrong path and reverted.

This is a prerequisite for `String`/`ArrayList` usage in user code (their
constructors `.new()` / `.with_capacity()` are generic static methods) and hence
for the full `String.from("AB").len()` (m1) path, alongside the std-function-
body-eval gaps.
