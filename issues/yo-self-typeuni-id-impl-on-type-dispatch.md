# yo-self: `impl(Type, ...)` methods never dispatch — `TypeUni` has no id

> **STATUS: both fixes landed** (TypeUni id + generic-impl method-type
> specialization, see "Fix 2" below). The full `__derive_eq` reflection chain
> now def-evaluates with a propagating (non-swallowing) exception — every step
> typed, no errors. std + yo-self dir-checks pass.

## Symptom

Under `yo-self check`, every call to a `Type.*` reflection method
(`Type.get_info`, `Type.get_enum_variants`, `Type.get_struct_fields`,
`Type.join_fields`, `Type.map_variants`, …) soft-falls to a `unit`-typed
result instead of its declared return type. This silently poisons every
downstream binding in derive-rule bodies:

```rust
// prelude __derive_eq (enum branch) under def-time body eval:
variants :: Type.get_enum_variants(T);   // unit  (should be ComptimeList(VariantInfo))
v :: variants.get(vi);                   // unit  (method lookup on unit → soft fallback)
fname :: v.fields.get(fi).name;          // RHS has NO ExprInfo → throws
// → "Failed to evaluate, got ((v.fields).get)(fi).name" → swallowed by
//   the def-eval trial wrapper → ~30 swallow categories ("reflection-on-unknown")
```

Probed via deliberate type-mismatch bindings (`(comptime(x) : bool) = zr;`
reveals the RHS's actual type in the error):

| Probe                                     | Result type   |
| ----------------------------------------- | ------------- |
| `__yo_type_get_info(T)` (builtin direct)  | `TypeInfo` ✅ |
| `zid(T)` (plain module-level comptime fn) | `Type` ✅     |
| `ZS.zsid(T)` (static method on a struct)  | `Type` ✅     |
| `Type.zty_id(T)` (impl method on `Type`)  | **`unit`** ❌ |
| `Type.zty_id(usize)` (concrete arg)       | **`unit`** ❌ |
| `Type.get_info(usize)` at module level    | **`unit`** ❌ |

So the failure is independent of the argument and of def-eval — **no impl
method on `Type` ever dispatches through the registry**. (Derive expansion
still works because the executing CTFE path resolves the method through the
env-level `qualified` binding, not the registry.)

## Root cause

yo-self stores trait methods in a module-level registry keyed by
`type_id_or_empty(receiver_type)` (`evaluator/values/type_trait_methods.yo`).
`type_id_or_empty` had no arm for `TypeUni` → returned `""` → both:

- **registration**: `impl.yo` skips empty-id registrations, so the prelude's
  `impl(Type, get_info : ...)` block was silently dropped, and
- **lookup**: `get_type_trait_methods_by_name_from_env` early-returns `[]`
  for empty ids.

TS has no such gap because the Type universe type is a **cached singleton
with an id**: `createTypeHierarchy` (src/types/creators.ts:1030) builds
`{ id: "Type(${level})", tag: TypeTag.Type, level, trait }` — `impl(Type, ...)`
attaches to that singleton's trait slot and lookup reads it back.

This is the same class of bug as the primitive-type registration gap already
fixed in `type_id_or_empty` (primitives got `__yo_t_usize` etc. synthetic ids).

## Fix

`type_id_or_empty` maps `.TypeUni(level)` to the TS id format:

```rust
.TypeUni(level) => ((String.from("Type(") + level.to_string()) + String.from(")")),
```

Registration and lookup both go through `type_id_or_empty`, so they agree.

## Fix 2 — generic-impl method types must be SPECIALIZED (the layer underneath)

With the TypeUni id fixed, the chain advanced one step and exposed a second
divergence with a module-level minimal repro (no def-eval involved):

```rust
zlist :: comptime_list("a", "b");
zitem :: zlist.get(usize(0));   // TS: comptime_string ✅
                                // yo-self: threw "Type mismatch for parameter self:
                                //   Expected ComptimeList(T), Got ComptimeList(comptime_string)" ❌
```

`find_methods_from_generic_impls` returned the **raw** registered method type
(`self : ComptimeList(T)`) and only injected the forall bindings into the
method _value_'s captures. TS instead returns a **specialized** method type:
`findMethodsFromGenericImpls` re-evaluates the function type with the match
substitutions bound (`reEvaluateFunctionType`, impl.ts:1484), so the candidate
arrives at the call site with `self : ComptimeList(comptime_string)`.
Call-time SomeT synthesis cannot compensate because the registered `T`
SomeT's frame level is stale at the call site — the same root cause that
`_substitute_self_in_method_ty` already fixed for `Self`.

Fix: in `find_methods_from_generic_impls`, build a `Substitution` mapping each
impl forall param `(name, frame_level)` → its matched binding and return
`substitute(s, ftype)` as the candidate's `method_type`.

## Related gaps catalogued on the way (NOT fixed here)

- `zlist(usize(0))` — the `ComptimeIndex` call form on a comptime list
  soft-falls to `unit` under check (separate dispatch path).
- `Expected *(T) / Got *(u8)` at prelude.yo:5832 — `str.from_raw_parts`
  def-eval; generic EXTERN builtin (`__yo_slice_new`) call-time unification
  under type-check mode. Prints once per prelude load (swallowed); separate
  from the impl-registry paths fixed here.

## How it was found

The "reflection-on-unknown" def-eval swallow category was bisected with a
propagating diagnostic (`_trial_eval_fn_body` temporarily re-throws for
bodies in `fixme` files) + type-revealing probes. Two red herrings ruled
out on the way:

- `__yo_comptime_list_get` / property-access on unknown values are robust
  (both return typed `UnknownVal`) — NOT the domino.
- The `Expected *(T) / Got *(u8)` print at prelude.yo:5832 is a SEPARATE,
  pre-existing unification gap (fires once per prelude load during
  `str.from_raw_parts` def-eval; swallowed) — tracked separately.
