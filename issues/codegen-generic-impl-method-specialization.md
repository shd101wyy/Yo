# Codegen: generic-impl method calls need specialization (Gap 6 / monomorphization)

## Status: OPEN — the largest remaining Phase-3 codegen-port piece

This is the true blocker for `String.from("AB").len()` (the m1 target) and any
program that calls a method from a generic impl (`impl(forall(T), C(T), ...)`)
on a concrete instantiation. Confirmed 2026-06-15 after the Gap-6 cascade
(void* fallback, value-struct ctor, comptime-only skip, skip-predicate unify —
commits e3b3297e9 / cfb84cff1 / d374f8875 / 9bae51c8e).

## Minimal reproducer (16 lines — use instead of the String path)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
MyBox :: (fn(comptime(T) : Type) -> comptime(Type))(
  object(value : T)
);
impl(
  forall(T : Type),
  MyBox(T),
  get : (fn(self : Self) -> T)(self.value)
);
make_box :: (fn(n : i32) -> MyBox(i32))(
  MyBox(i32)(value : n)
);
main :: (fn() -> unit)({
  b := make_box(i32(65));
  unsafe(_a := putchar(int(b.get())));
});
export(main);
```

- **TS reference**: compiles + runs, prints `A` (char 65), rc=0.
- **self-bin (9bae51c8e)**: `// Failed to transpile (b.get)()` in `__yo_user_main`
  → C error `expected expression`.

(`Box` collides with a prelude type — must use a different name like `MyBox`.)

## Root cause

`b.get()` dispatch in `yo-self/codegen/exprs/other_fn_call.yo`
(concrete-method branch, ~line 597) resolves the method via
`get_type_trait_methods_by_name(type_id_or_empty(recv_ty), mname)`. For a
generic impl, the methods are registered under `MyBox(T)`'s id (the generic
struct), but `recv_ty` is `MyBox(i32)` with a *fresh* instantiation id → the
lookup misses → returns `None` → falls through to "Failed to transpile".

Even if resolution fell back to `find_methods_from_generic_impls(recv_ty,
mname, env)` (in `evaluator/values/generic_impl_registry.yo`, which DOES match
`MyBox(T)` against `MyBox(i32)` via `synthesize`), the candidate it returns is
the UNSPECIALIZED method `get : (fn(self : Self) -> T)` — `T` is still a SomeT.
`should_skip_function_codegen` (declarations.yo) correctly skips it (generic
return), so it would be undeclared at the call site. **Resolution alone is
insufficient — the method must be SPECIALIZED.**

## What TS does (the target)

TS specializes the generic-impl method per concrete instantiation. For this
repro it emits:

```c
static inline int32_t
fn_<hash>_id_68_get_specialized_T_i32_Self_MyBox_u40_i32_u41__(
    __yo_struct_<hash>_id_81* self);   // (MyBox(i32)) fn(self : MyBox(i32)) -> i32
```

i.e. a concrete FuncVal with:
  - `T` substituted to `i32` (return type `int32_t`, `self.value` → i32 field),
  - `Self` substituted to `MyBox(i32)`,
  - a NEW funcId (base `_specialized_T_i32_Self_MyBox(i32)` suffix),
  - registered in `context.functions` and emitted normally (no SomeT, so
    `should_skip_function_codegen` keeps it).

The call site references the specialized funcId's C name.

In TS this specialization happens in the EVALUATOR call path
(`src/evaluator/calls/…` — `specializeFunction`/instantiation), and the
dot-access ExprInfo (`expr.func.$`) carries the resolved *specialized*
FuncVal so codegen just consumes `funcId`. yo-self's method-call ExprInfo does
NOT carry this (the callee dot-access has no ExprInfo), and the specialization
machinery itself is unported.

## Prior art / caution

Memory `yo-self-phase3-generic-impl-funcid`: a fix attempt for exactly this
(generic-instantiation method resolution → unit; "synthesize compares struct
ids, but generic instantiations get fresh random_ids; TS uses
functionValue.funcId, yo-self omits it") was made and **reverted** (dead
`evaluate_comptime_fn_call` + TypeValue clash + struct-clone id churn). So this
is known-hard and needs care — likely a `funcId` field on the specialized
struct/FuncVal, not name-based identity.

## Next steps (for a fresh budget)

1. Decide where specialization lives: faithfully, the evaluator call path
   (mirror TS `specializeFunction`) so the call's ExprInfo carries the
   specialized FuncVal; codegen then needs only to read it + the
   collection/emission already works for concrete FuncVals.
2. Alternatively (codegen-local, lower fidelity): in collection.yo +
   other_fn_call.yo, on a generic-impl method call, build the substitution
   T→concrete from `synthesize(MyBox(T), MyBox(i32))`, clone the method FuncVal
   with substituted type + a derived funcId, register + emit it. Risk:
   diverges from TS identity model.
3. Validate with this repro (TS-differential: prints `A`, rc=0) + corpus stays
   green, THEN re-test the full `String.from("AB").len()` (m1) path.
