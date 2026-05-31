# `Self.method()` inside a specialized generic method loses the type arguments

## Status

**Schema landed (`0f2189f6`), regression-free; html.yo still pends.** Added
`type_arguments` to `TypeValue.Struct` + populate (comptime_fn) + substitute
(substitution.yo) + a consume fallback in `function.yo`'s FuncVal-callee forall
loop. This **fixes the minimal cross-module Container reproducer** below
(std 150/151, check ./tests 66/82 — zero regressions). **But html.yo's HashMap
case still fails identically** at `hash_map.yo:59`.

Instrumentation finding (next-step pointer): the `function.yo:~1109`
forall-binding loop where the consume fallback lives **never executes** for
either repro (a `TADBG` print keyed on `fa_name == "K"` produced no output for
Container _or_ HashMap). So the real cross-module method dispatch does NOT go
through that path — it goes through
`helper.yo:create_specialized_function_inline`, which binds `forall` params from
`arg_values.forall_args` (line ~899), and that is empty for a no-arg
`Self`-dispatched method. The Container repro was fixed by the populate/
substitute stages via some other consumer; the HashMap case differs (likely
HashMap(String,String) not getting `type_arguments` populated, or the helper.yo
path not reading the receiver struct's `type_arguments`). **NEXT: instrument
`helper.yo` to find where the no-arg `Self`-dispatched method binds `forall`,
and have it bind from the receiver struct's `type_arguments` when
`arg_values.forall_args` is empty.** Determine via an instrumented build why
Container populates `type_arguments` but HashMap(String,String) apparently does
not (where-constraint? instantiation path?).

**Update (helper.yo Step 6 ruled out):** added a fallback in
`try_to_call_function_with_arguments` Step 6 (`helper.yo:~1568`) to bind a still-
`UnknownVal` forall param from `ctx.self_type`'s `type_arguments`, plus a
`HDBG` print keyed on `flabel == "K"`. **It never fired for either repro** — so
no-arg `Self`-dispatched methods do not bind their forall in Step 6 either.
Reverted. The forall binding for these dispatches flows through the method-
resolution `substitute()` path (matching the receiver against the impl pattern
yields `K→concrete`, applied to the method type). `type_arguments` fixed the
Container repro through that substitution; **html.yo's HashMap still fails
because synthesize-matching `HashMap(String,String)` against the impl pattern
`HashMap(K,V)` does not yield `K→String`** — the original knot core (the
recursive `?*(Bucket(K,V))` field and/or the `where(K <: (Eq,Hash))`
constraint defeat the unification). That is a separate, harder sub-problem;
`type_arguments` is a necessary prerequisite but not sufficient alone.

This is the current head of the **generic-method-resolution knot** cascade
(see `plans/GENERIC_METHOD_RESOLUTION_KNOT.md`). It is what blocks
`std/encoding/html.yo` (and ~all of `check ./yo-self`).

## Symptom

`yo-self-bin check std/encoding/html.yo` fails at `std/collections/hash_map.yo:59`:

```
Error: Expected compile-time value for "bucket_size".
    bucket_size :: sizeof(Bucket(K, V));
```

`Bucket(K, V)` reaches `sizeof` with `K`/`V` as unsubstituted `SomeT`
(instrumented: `field[0] SomeT id=1450`, `field[1] SomeT id=1451`), not the
concrete `String`/`String`. `get_size_of_type` correctly returns `.None` for a
`SomeT` field, so the `::` comptime binding fails.

## Minimal reproducer (cross-module, two-level `Self` dispatch)

`fixme_mod.yo`:

```rust
pragma(Pragma.AllowUnsafe);
Bkt :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(struct(key : K, value : V));
Container :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(object(cap : usize));
impl(
  forall(K : Type, V : Type),
  Container(K, V),
  _inner : (fn() -> usize)({ sz :: sizeof(Bkt(K, V)); sz }),
  make  : (fn() -> usize)(Self._inner())
);
export(Container);
```

`fixme.yo`:

```rust
{ Container } :: import("./fixme_mod.yo");
x := Container(i32, u64).make();
```

TS `yo-cli check` → OK. `yo-self-bin check` → `Expected compile-time value for "sz"`.

### Bisection (each line is one variable changed)

| Variant                                                               | Result   |
| --------------------------------------------------------------------- | -------- |
| same-file (no import), `Self._inner()`                                | **OK**   |
| cross-module, one-level (`make` does `sizeof` directly, no `_inner`)  | **OK**   |
| cross-module, two-level `Self._inner()`                               | **FAIL** |
| cross-module, two-level `Container(K, V)._inner()` (literal receiver) | **OK**   |

So the trigger is precisely: **a method dispatched via `Self`** (vs a literal
type-application receiver), inside an already-specialized generic method, in a
cross-module generic impl.

## Root cause

When a generic method is dispatched, its `forall` params (`K`, `V`) are bound in
the body's fresh env from the **receiver expression's type-application args**
(`function.yo` infers forall params from arg types / the receiver call args).

- A **literal** receiver `Container(K, V)` is a `FnCall` whose args
  (`K`, `V`) evaluate, in the caller env, to the concrete `i32`/`u64`. The
  dispatch recovers `K=i32`.
- **`Self`** is an `Atom`. It resolves (via `identifer_and_operator.yo`, the
  `Self` case) to `create_type_value(ctx.self_type)` — the bare instantiated
  object type `Container(i32, u64)`. **That `TypeValue.Struct` carries no record
  of its type arguments**, so there is nothing to recover `K=i32` from → the
  method's `forall` `K` stays an abstract `SomeT`.

TS does not hit this because `StructType` carries `env: Environment`
(`src/types/definitions.ts:496`, "the env when the struct type is created") —
the instantiation env in which `K=i32`, `V=u64` are bound by name. A
`Self`-dispatched method re-derives its substitution from `struct.env`.
yo-self's `TypeValue.Struct` (`yo-self/types/definitions.yo:114`) has only
`id, name, field_labels, field_types, is_reference_semantics, is_atomic_rc,
is_newtype, constructor_func_id` — **the creation env / type arguments were
dropped**.

## Fix options

1. **Faithful (preferred): carry the type arguments (or creation env) on the
   instantiated type.** Either add `env : Environment` to `TypeValue.Struct`
   (mirrors `StructType.env`; risks an Environment↔TypeValue import cycle) or a
   lighter `type_arguments : ArrayList(TypeValue)` set at the comptime-fn return
   site (alongside `constructor_func_id`), then have the method-dispatch path
   bind each `forall` name to the corresponding stored type argument when the
   receiver is a bare type value (`Self`). Schema change to a core variant —
   threads through the synthesizer, `substitute`, compatibility, and the
   hundreds of `.Struct(...)` match sites (same magnitude as the
   `constructor_func_id` add, `0d4e951f`).

2. **Narrow alternative:** since `make` and `_inner` share the _same_ `forall`
   in the _same_ impl, when dispatching `Self.method()` inside a specialized
   body, seed the callee's fresh env with the enclosing env's `forall`
   bindings (`K=i32`, `V=u64` are already bound in `make`'s fresh env). Smaller,
   but only covers `Self.method()` within the same impl — not a general
   bare-type-value receiver.

## Validation

- Reproducer above must pass under `yo-self-bin check`.
- `std/encoding/html.yo` error must move past `hash_map.yo:59`.
- `check ./std` per-file: only html.yo may change; regressors
  (imm_vec/imm_threading/priority_queue) stay green.
