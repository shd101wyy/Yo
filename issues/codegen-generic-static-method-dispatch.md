# Codegen: generic static-method dispatch (e.g. `ArrayList(u8).new()`)

## Status: SPECIALIZATION ✅ RESOLVED (commit 6ca1f10ef); one downstream layer remains

The static-method SPECIALIZATION is fixed (instrumented + 3-part fix below).
`ArrayList(u8).new()` now specializes to a concrete `ArrayList(u8)`-returning
function — `main` transpiles (was "undeclared" before), corpus 35/35, instance
keystone unaffected. The ONE remaining blocker for full `ArrayList`-in-user-code
is downstream and SEPARATE: the specialized body's value-struct CONSTRUCTOR emits
0 args (the `rewrap` edge case) — see
issues/codegen-specialized-body-constructs-generic-type.md.

### The fix that worked (commit 6ca1f10ef), found by instrumentation

Probe of `ArrayList(u8).new()` showed: it reaches the **FuncVal-call arm** with
`forall=0` (unstamped) + 240 captures including `T=u8` at the tail. Three pieces:
1. **impl.yo**: stamp the impl forall on ALL generic-impl methods (not just
   instance) so static methods carry forall and reach the spec gate.
2. **function.yo FuncVal-arm forall loop**: capture fallback — bind a forall param
   from the FuncVal's own captures (where `_inject_forall_captures` put `T=u8`)
   when args / receiver-type_arguments don't.
3. **function.yo runtime-return spec**: set `ctx.self_type` to the static
   dot-receiver around `create_specialized` so the body re-evaluates with `Self`
   concrete (the CTFE-route self_type window didn't cover the runtime-return spec).

### Remaining layer: object-ctor `runtime_arg_exprs` not recorded in the spec body

`ArrayList.new`'s body is `Self(_ptr:.None, _length:usize(0), _capacity:usize(0))`.
The specialized `.new` emits `__yo_new_<cName>()` with **0 args** (needs 3). The
object-ctor codegen branch reads `ei.runtime_arg_exprs_in_order`, which is EMPTY
for this ctor in the specialized body. Verified spec-body-specific: the same
comptime-arg object construction OUTSIDE a spec body works (`/tmp/objc.yo`,
`Box2(a:i32(1),b:i32(2))` → prints "B"). So `create_specialized`'s body re-eval
does not record `runtime_arg_exprs_in_order` for nested object constructors
(normal eval does, even for comptime-valued field args). Fix options:
(a) make the spec body re-eval record `runtime_arg_exprs` for object ctors, or
(b) codegen fallback: when `runtime_arg_exprs` is empty, emit the ctor's runtime
    field values from the FnCall's raw args / the comptime struct value (must map
    labels → runtime-field order). Same fix unblocks the `rewrap` edge case.

## (Historical) Status: OPEN — next Phase-3 target after the instance-method keystone

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
(function.yo ~line 1616, the `callee_value = Some(FuncVal)` arm; spec at ~2326,
gated on `forall_names.len() > 0`). Two attempts (self_type; step-6
capture-seeding in the `.None` arm) were on the wrong path and reverted.

## Attempt 3 (2026-06-15, reverted) — re-stamp static methods only

The FuncVal arm ALREADY has the right machinery: it binds forall params from
ARG types (function.yo:1862) and, as a FALLBACK, from the receiver's
**type_arguments** (`recv_type_args`, function.yo:1887-1899 —
`_static_dot_receiver_self_type(...).Struct({ type_arguments })`). So in
principle, re-stamping `.new` (giving it `forall_names=[T]`) should let this arm
bind `T` from the receiver's type args and specialize.

RESULT: re-stamping static methods alone STILL gives `loc4` "main body Failed to
transpile" (the FuncVal-arm spec throws). So `recv_type_args` is NOT binding `T`
— almost certainly because **`ArrayList(u8)`'s Struct does not carry
`type_arguments = [u8]`** (the comptime instantiation didn't populate that
field), so the receiver fallback finds an empty list and `T` stays unbound →
`create_specialized_function_inline` throws.

## The actual fix (next): populate / recover the receiver's type arguments

Either (a) ensure generic struct instantiation records `type_arguments` on the
Struct (so `ArrayList(u8)` carries `[u8]`), or (b) in the FuncVal-arm fallback,
recover `T` by matching the impl receiver pattern `ArrayList(T)` against the
concrete receiver `ArrayList(u8)` via `synthesize_types` (the binding
`_inject_forall_captures` already computed — route it here instead of relying on
`type_arguments`). Then re-enable static stamping. VERIFY FIRST with a probe:
print `recv_type_args.len()` for `ArrayList(u8).new` to confirm it's empty.
Validate: `loc4` prints `A` + corpus 35/35 + std/tests/yo-self.

## Attempt 4 (2026-06-15, reverted) — capture fallback IN the FuncVal arm

Added a third fallback to the FuncVal-arm forall-binding loop (function.yo ~1910):
when `T` isn't bound from args or `recv_type_args`, bind it from this FuncVal's
own CAPTURES (`cap_names`/`cap_vals`, where `_inject_forall_captures` put `T=u8`)
+ re-enabled static stamping. RESULT: `loc4` STILL "main body Failed to transpile"
— identical to attempts 2 & 3.

So one of these is true and UNVERIFIED: (a) `ArrayList(u8).new()` does NOT reach
this FuncVal arm at all (yet another dispatch path); (b) the resolved `.new`
FuncVal's captures do NOT contain `T` (the static lookup path may not run
`_inject_forall_captures`); or (c) `create_specialized_function_inline` throws
for `.new` for a reason unrelated to `T` (e.g. the body's `Self(...)` / 0-param
shape).

## STOP guessing — instrument first (next session)

Four blind fix attempts (self_type; `.None`-arm capture-seed; bare re-stamp;
FuncVal-arm capture fallback) all produce the identical "main body Failed to
transpile". Before any 5th attempt, add eprintln probes to answer, for
`ArrayList(u8).new()` specifically:
  1. Which call arm does it reach? (probe the `.Some(cv)` FuncVal arm entry vs
     the `.None` method arm vs the property-access path.)
  2. Does the resolved `.new` FuncVal carry `T` in its captures? (print
     `cap_names`.)
  3. Does `create_specialized_function_inline` throw, and at what point? (wrap /
     print before+after.)
Only then fix the confirmed layer. The safe narrowed state (cc9ae1f73,
instance-only stamping) is retained throughout. Static dispatch is a genuine
multi-layer sub-problem; the instance-method keystone (0acb43c23) is the solid,
shipped win and is unaffected.

This is a prerequisite for `String`/`ArrayList` usage in user code (their
constructors `.new()` / `.with_capacity()` are generic static methods) and hence
for the full `String.from("AB").len()` (m1) path, alongside the std-function-
body-eval gaps.
