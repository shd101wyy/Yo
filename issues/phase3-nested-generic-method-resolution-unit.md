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

## Refinement (instrumented `try_match_generic_impl`)

Breadcrumbing `try_match_generic_impl`'s synthesize attempt (impl.yo:317) shows
**no `HashMap(K,V)` pattern is ever tried** for the `.new` lookup — the only
generic-impl TRY patterns are builtin-type impls (`Array(T,0)`, `Slice(T)`,
`*(T)`, `ComptimeList(T)`, `iso(T)`) against the receiver structs. So `.new`
resolution does **NOT** go through generic-impl matching at all; it goes through
the **type-trait-methods registry lookup by type id** (`property_access.yo`'s
`get_type_trait_methods_by_name(type_id_or_empty(type_val_inner), "new")`).

So the narrowed root: `HashMap(String, ArrayList(i32))` carries the
`constructor_func_id` (or struct id) under which `HashMap`'s `.new` is
registered, but `HashMap(String, ArrayList(String|ME))` carries a **different /
unstamped** id, so the registry lookup misses. The nested-RC value type argument
(`ArrayList(String)`, `ArrayList(ME)`) causes the outer `HashMap` instantiation
to be built via a path that does NOT stamp the matching `constructor_func_id`
(cf. the `ret=unit` type-constructor calls seen at `function.yo`'s FuncVal gate —
nested constructors returning unit/unstamped).

**This reconnects to the genuinely-hard nested-instantiation identity problem**
(see `phase3-nested-generic-instantiation-identity.md` "Why it's hard" + memory
`yo-self-phase3-generic-impl-funcid`): per-instantiation `constructor_func_id`
stamping for nested generics is SIGBUS-prone (the cycle-guard keys on stable ids)
and was net-≤0 across ~8 attempts. The NEW, sharper handle is that it now
manifests as a **method-registry lookup miss** (`.new` → unit) rather than a
synthesize mismatch, and the precise discriminator is
`HashMap(.., ArrayList(<RC>))` vs `HashMap(.., ArrayList(i32))`. The next effort
should: instrument `type_id_or_empty` / the struct `constructor_func_id` for the
i32 vs String/ME instantiations of the nested `ArrayList(...)` AND the outer
`HashMap(...)`, and find where the RC-nested outer instantiation loses its
stamp — likely a non-memoized construction path for the outer HashMap when a
type-argument is itself a freshly-built nested instantiation.

## PRECISE PIN (instrumented `try_match_generic_impl` + synthesizer struct case)

Traced end-to-end on `HashMap(String, ArrayList(ME)).new()`:

1. `.new` is a static method on `TypeVal(<HashMap struct>)`. property_access's
   struct branch calls `find_methods_from_generic_impls(<HashMap struct>, "new")`.
2. For the i32 receiver (`struct_2363`) the HashMap impl entry MATCHES (returns 1
   method) → `.new` resolves → works.
3. For the ME/String receiver (`struct_2364`) the SAME impl entry's
   `try_match_generic_impl` **fails**: its `synthesize_types(impl_pattern,
HashMap(String, ArrayList(RC)))` recurses into fields and throws at
   `synthesizer.yo:1319`:
   ```
   DBG STRUCT-MISMATCH exp=#struct_2195/cfid=yo_id_2182  giv=#struct_2357/cfid=  (empty!)   (×20)
   ```
   So `find_methods` returns 0 → property_access falls to the registry-by-id
   lookup (`type_id_or_empty(struct_2364)`, miss) → `.new` = NONE → the no-method
   call path returns `unit`.

**The exact root: `struct_2357` (a NESTED field struct of
`HashMap(.., ArrayList(RC))`'s representation) has an EMPTY `constructor_func_id`
and an empty `name`.** The impl pattern's corresponding field (`struct_2195`)
carries `cfid=yo_id_2182`. `same_constructor` is false (one cfid empty) → the
synthesizer throws "incompatible struct types" → the impl match fails. With an
`i32` element the analogous nested field IS stamped, so the match succeeds.

So the construction of `HashMap(K,V)` with a type-argument that is itself a
freshly-built nested instantiation (`ArrayList(String)`, `ArrayList(ME)`) leaves
one nested field struct **unstamped**, whereas a primitive element (`i32`) does
not. This is the same "unstamped nested instantiation" the (resolved) i32/usize
doc described, now proven to be the cause of the `.new → unit` method-resolution
miss (NOT the cause of the String.from i32/usize, which was comptime_string).

### Fix options (next focused effort)

1. **Stamp the nested field at construction** — find where `HashMap`'s type
   constructor builds its field structs (comptime_fn.yo / type construction) and
   why an RC-nested type-arg yields an unstamped nested field; stamp it with the
   right `constructor_func_id`. This is the faithful fix but is the SIGBUS-prone
   stamping path (cycle-guard keys on stable ids; net-≤0 ×8 historically) — needs
   careful per-file measurement.
2. **Synthesizer leniency (workaround)** — at synthesizer.yo:1319, when one side's
   `constructor_func_id` is EMPTY and field labels + count match, recurse into
   fields instead of throwing. Bounded + testable, but risks reintroducing
   field-misalignment for genuinely-different same-shaped structs; measure
   per-file (yo-self 57, std 151, tests 155 baseline; watch imm_vec/imm_threading
   for SIGBUS).

Both need the per-file baseline-vs-fix diff harness. The 1-line repro
`HashMap(String, ArrayList(ME)).new()` + the `struct_2195/cfid=yo_id_2182` vs
`struct_2357/cfid=∅` evidence are the precise handles to work from.
