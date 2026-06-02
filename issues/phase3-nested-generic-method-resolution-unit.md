# Phase 3 blocker: `.new()` on a doubly-nested generic with RC inner type → "Given unit"

## Status

Open — the **dominant remaining Phase-3 blocker** after the comptime_string /
over-CTFE knot was resolved (commits ebca49a3, 9b678519). `check ./yo-self` =
57/227; **all 170 remaining fails are this one bug**, via the shared global
`yo-self/evaluator/values/type_trait_methods.yo:130`:

```rust
(_type_trait_methods : HashMap(String, ArrayList(MethodEntry))) =
  HashMap(String, ArrayList(MethodEntry)).new();   // FAIL: Expected <HashMap struct>, Given unit
```

Every file that transitively imports `type_trait_methods.yo` fails here.
Pre-existing (fails identically on the pre-session baseline binary) — NOT caused
by the knot fixes.

## Minimal reproducer + discriminator

```rust
open(import("std/string"));
{ HashMap } :: import("std/collections/hash_map");
{ ArrayList } :: import("std/collections/array_list");
ME :: object(name : String, kind : i32);
(_m : HashMap(String, ArrayList(ME))) = HashMap(String, ArrayList(ME)).new();  // FAIL "Given unit"
```

| repro                                         | result          |
| --------------------------------------------- | --------------- |
| `HashMap(String, ME)` (object value directly) | **OK**          |
| `HashMap(String, ME).new()`                   | **OK**          |
| `ArrayList(ME).new()` (alone)                 | **OK**          |
| `HashMap(String, ArrayList(i32)).new()`       | **OK**          |
| `HashMap(String, ArrayList(String)).new()`    | **FAIL** (unit) |
| `HashMap(String, ArrayList(ME)).new()`        | **FAIL** (unit) |

So the trigger is precise: **`HashMap` whose value type is `ArrayList(X)` where
`X` is an RC/newtype/object type** (`String`, `ME`) — a doubly-nested generic
instantiation with an RC innermost. `ArrayList(i32)` (value/primitive element)
works; the object directly (`HashMap(String, ME)`) works; `ArrayList(ME)` alone
works. Only the _nesting_ `HashMap(.., ArrayList(RC))` breaks it.

## Mechanism (instrumented)

`.new()` is `.(HashMap(...), new)` — a static method call. Traced via a
breadcrumb at `evaluate_function_call`'s callee-value dispatch (function.yo:420)
and at the receiver-method branch:

- **i32 element**: the callee `.new` resolves to a FuncVal value
  (`property_access.yo` finds the static method) → dispatched normally → returns
  the HashMap type.
- **ArrayList(String)/ArrayList(ME) element**: the callee `.new` resolves to
  **NONE** — `property_access.yo` does NOT find the `new` static method on the
  `HashMap(String, ArrayList(RC))` type value. It then falls through to
  `_try_find_receiver_method`, which ALSO fails (no `DBG RECVCALL`), so the call
  lands on the final no-method path (`function.yo:1561`,
  `try_to_call_function_with_arguments` with a `None` callee value) whose
  `return_type` is **`unit`** → the annotated assignment then reports
  `Expected: <HashMap struct>, Given: unit`.

So the root is **static-method resolution failing** for a `HashMap` instantiation
whose value type is a nested `ArrayList(RC)`. The `new` method is registered once
on `HashMap`'s generic impl `impl(forall(K,V), HashMap(K,V), new : ...)`; it is
found for `HashMap(String, ArrayList(i32))` but NOT for
`HashMap(String, ArrayList(String|ME))`. The likely culprit is
`find_methods_from_generic_impls` / `try_match_generic_impl` (values/impl.yo) or
the type-trait-methods registry lookup (`get_type_trait_methods_by_name`,
`type_id_or_empty`) — the nested-RC value type changes the instantiation's
identity/shape enough that the generic-impl match for `HashMap(K,V)` fails to
bind `V = ArrayList(RC)` (note: the impl-forall binding fix 8067aa03 handles the
top-level forall, but a nested-RC type argument may still mis-match).

## Recommended next steps

1. Work the minimal `HashMap(String, ArrayList(ME)).new()` repro (above) — fast,
   no prelude noise beyond the imports.
2. Instrument `property_access.yo`'s static-method branch (the
   `find_methods_from_generic_impls` / `get_type_trait_methods_by_name` calls,
   ~lines 716/773) and `values/impl.yo`'s `try_match_generic_impl` to see WHY the
   `HashMap(K,V)` generic-impl match fails to bind `V = ArrayList(String)` while
   it succeeds for `V = ArrayList(i32)` and `V = ME`.
3. Compare the `i32` vs `String`/`ME` instantiation identities of the nested
   `ArrayList(...)` type argument (constructor_func_id / type_arguments / struct
   id) at the point of the generic-impl match.
4. ALWAYS validate with the per-file baseline-vs-fix exit-code diff (build a HEAD
   baseline binary + the fix binary, `join` per file across yo-self + std +
   tests). Current baseline to beat: yo-self 57/227, std 151/151, tests 155/182.

## Note

This is distinct from `phase3-nested-generic-instantiation-identity.md` (the
"i32 vs usize" knot, RESOLVED) — that was a synthesize/binding bug; this is a
METHOD-RESOLUTION bug. But both involve nested generic instantiations with RC
inner types, so a shared identity root is plausible.
