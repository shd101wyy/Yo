# RESOLVED (commit e3936a98)

**Fixed.** Comptime-fn cache collision: `_ctfe_args_equal`'s concrete branch used
lenient `are_types_compatible` (TS uses `requireExactMatch=true`), and
`compatibility.yo`'s struct comparison was name-only while all yo-self structs
have empty names — so `ME` and `Bucket` compared equal and `(?*)(Bucket)` hit a
cached `(?*)(ME)`. Fix: concrete cache branch → `are_types_compatible_exact`;
struct comparison under `require_exact` → structural (field labels + recursive
field types, cycle-guarded). **check ./yo-self 57→227/227 (COMPLETE), std
151/151, tests 155/182, 0 regressions / 0 SIGSEGV.** Full investigation
(5 eliminated theories → exact root) retained below.

---

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

## Tried + REJECTED: synthesizer leniency (option 2)

Implemented the leniency at synthesizer.yo:1318 — `same_constructor` also true when
one cfid is empty AND field shapes match. Two gates tried:

- **field-labels equal**: did NOT trigger (struct_2195/2357 are anonymous — empty
  name AND no matching labels), so the repro stayed failing.
- **field-types count equal** (`one_cfid_empty && exp.field_types.len ==
giv.field_types.len > 0`): the isolated repro `HashMap(String, ArrayList(ME)).new()`
  PASSED, but the full per-file measurement was a **regression**: yo-self stayed
  57/227 (net 0 files flipped) AND introduced **2 NEW SIGSEGVs** — the count-only
  gate makes the synthesizer recurse into structs that shouldn't unify, and on
  recursive types the cycle-guard blows up (the imm_vec/imm_threading SIGBUS the
  memory warns about). Reverted.

**Conclusion: option 2 (synthesizer leniency) is a dead end** — same net-≤0/SIGBUS
trap as the prior ~8 attempts. The ONLY viable path is **option 1: stamp the
nested field `struct_2357` at construction** so it carries the real
`constructor_func_id` (matching `struct_2195`'s `yo_id_2182`). The next effort
must trace `HashMap`'s type constructor (comptime_fn.yo / the nested-field build
path) to find why an RC-nested type-argument yields an unstamped nested field,
and stamp it there — NOT in the synthesizer. Repro:
`HashMap(String, ArrayList(ME)).new()`; evidence: `struct_2195/cfid=yo_id_2182`
(pattern, stamped) vs `struct_2357/cfid=∅` (concrete, unstamped).

## Construction-path trace (stamping origin)

- `struct(...)` (`evaluator/types/struct.yo:159-169`) ALWAYS builds with empty
  `constructor_func_id` + empty `type_arguments` ("set later at the comptime-fn
  call site").
- `evaluate_comptime_fn_call` (`comptime_fn.yo:717-731`) stamps ONLY the outer
  returned struct (sets cfid = the constructor func id + type_arguments), NOT
  nested field structs.
- `substitute()` (`substitution.yo:239`) PRESERVES cfid AND the struct id.

Therefore `struct_2357` (id ≠ the pattern's `struct_2195`, empty cfid) was
**freshly built inline and never routed through `evaluate_comptime_fn_call`'s
stamping**, while the impl pattern's equivalent field WAS stamped (`yo_id_2182`).
The asymmetry to resolve: why does the impl pattern's nested field get stamped
but the use-site instantiation's equivalent field gets built inline+unstamped for
an RC type-arg (and NOT for `i32`)? A blanket "stamp all nested structs" is wrong
— genuinely-anonymous structs (e.g. `String`/`struct_2052`) correctly carry empty
cfid. The fix needs to either (a) route the use-site nested-field construction
through the same memoized/stamped path the pattern used, or (b) match by
`type_arguments` when cfid is empty — but `struct_2357` also has empty
type_arguments, so (b) needs the construction to populate type_arguments too.

**This is the hard core (net-≤0 ×8, SIGBUS-prone). It needs a dedicated effort
with full per-file validation budget**, tracing where the use-site builds the
nested field inline vs the pattern's stamped path — not a quick synthesizer or
blanket-stamp change (both proven to regress/SIGBUS).

## ★★★ STAMPING PREMISE DISPROVEN — it's a field-MISALIGNMENT, not unstamped identity

Instrumenting struct construction (`struct.yo:159` + `comptime_fn.yo:721` stamp)
on the ME repro identified the two mismatched structs by SOURCE:

- `struct_2195` (cfid `yo_id_2182`) = **`Bucket(K,V)`** = `hash_map.yo:24`
  `struct(key : K, value : V)` (2 fields). It IS stamped
  (`DBG STAMP id=struct_2195 -> cfid=yo_id_2182`).
- `struct_2357` = **`ME`** = `src/tests/fixme.yo:3` `object(name : String, kind :
i32)` (2 fields). It is NEVER offered to the stamping block — and that is
  CORRECT: `ME` is a plain non-generic object, like `String`/`struct_2052`; it
  SHOULD carry an empty `constructor_func_id`.

**So the synthesizer is comparing `Bucket(K,V)` against `ME`** — two unrelated
2-field structs at the same recursion position. That is a **field-MISALIGNMENT**
in how `HashMap(String, ArrayList(ME))` is structured vs the `HashMap(K,V)`
pattern (object/RC element triggers it; `i32` does not), NOT an unstamped-nested-
instantiation problem.

**Consequences for the prior theories (all now refuted):**

- The "stamp the nested field" fix is based on a WRONG premise — `struct_2357`
  (`ME`) must stay unstamped. Stamping it would be incorrect.
- The synthesizer-leniency SIGSEGV'd precisely because it forced
  `Bucket(K,V) ≡ ME` (same field count) and then recursed two incompatible
  structures.
- The `i32` case works because `ArrayList(i32)`'s layout aligns with the pattern;
  the object element `ME` (and `String`, an RC newtype) makes the concrete
  HashMap's field structure diverge so a `Bucket(K,V)` position meets `ME`.

### Real next step (corrected)

Find WHY the impl-match `synthesize_types(HashMap(K,V) pattern,
HashMap(String, ArrayList(<RC>)))` aligns a `Bucket(K,V)` field against `ME`.
Instrument `synthesizer.yo`'s struct field-unify loop to print the FIELD PATH
(which HashMap field → which sub-field …) that reaches the `Bucket` vs `ME`
comparison, for the ME repro vs the i32 repro. The divergence is in the concrete
instantiation's field LAYOUT for an object/RC value type — likely a substitution
or field-evaluation difference when `V = ArrayList(<object/RC>)`, NOT in
`constructor_func_id` at all. The fix is to make the concrete instantiation's
field structure match the pattern's (correct substitution/layout), so the
synthesize aligns `Bucket` with `Bucket` and binds `V = ArrayList(ME)` cleanly.

## ★★★★ CONCRETE ROOT (field-path instrumented): HashMap.data pointee collapses Bucket→ME

Instrumenting the synthesizer's struct field-unify loop + the pointer case on the
ME repro gives the exact field path:

```
DBG SF-ENTER struct_2350(cfid=yo_id_2188) VS struct_2364(cfid=yo_id_2188)   (HashMap vs HashMap, same ctor)
DBG PTR exp_pointee=u8 giv_pointee=u8                                        (field[0] ctrl : ?*(u8)  — OK)
DBG PTR exp_pointee=<struct_2195>  giv_pointee=<struct_2357>                 (field[1] data  — MISMATCH)
            = Bucket(K,V)              = ME
```

So `HashMap`'s `data : ?*(Bucket(K, V))` field, in the CONCRETE instantiation
`HashMap(String, ArrayList(ME))`, has pointee **`ME`** instead of
`Bucket(String, ArrayList(ME))`. The nested **`Bucket(K,V)` instantiation
collapsed to `ME`** (the innermost element of the `V = ArrayList(ME)` type arg)
when the value type is an object/RC. With `V = i32` the pointee is the correct
`Bucket(String, i32)`, so it matches and `.new` resolves.

So the bug is NOT in the synthesizer, NOT stamping, NOT method resolution — it is
in **constructing `HashMap(String, ArrayList(ME))`**: evaluating the field type
`?*(Bucket(K, V))` with `K=String, V=ArrayList(ME)` yields `?*(ME)`. The nested
generic `Bucket(K,V)` field resolves to the innermost RC element `ME` instead of
`Bucket(String, ArrayList(ME))`.

### Next step (now exact)

Instrument HashMap's data-field-type construction (the comptime_fn body eval of
`object(... data : ?*(Bucket(K, V)) ...)` with `V=ArrayList(ME)`) to see where
`Bucket(K, V)` → `ME`. Likely suspects: (a) a comptime_fn cache collision for
`Bucket(...)` keyed on `(func_id, arg_values)` where the RC arg `ArrayList(ME)`
mis-compares (`_ctfe_args_equal`) and returns a wrong cached value; (b) a
substitution/self-type confusion between HashMap's `data` field and ArrayList's
own `data : ?*(ME)` field (both named `data`, both `?*(...)`), so `V`'s inner
pointee leaks into HashMap's `data`. Repro: `HashMap(String, ArrayList(ME)).new()`;
discriminator: `ArrayList(i32)` works, `ArrayList(ME)`/`ArrayList(String)` collapse.

## ★★★★★ EXACT ROOT (comptime-fn arg trace): `(?*)` gets ME instead of Bucket

Instrumenting `evaluate_comptime_fn_call` (func id + arg types + result) on the ME
repro gives the full picture. HashMap's `data` field is `?*(Bucket(K, V))` =
`(?*)(Bucket(K, V))` (`?*` = prelude `(fn(comptime(T):Type)->Type)(Option(*(T)))`,
`func=yo_id_1690`). The calls (in completion order):

```
L507  func=yo_id_1950 args=[ME(struct_2357)]                  -> ArrayList(ME)(struct_2359)
L510  func=yo_id_2182 args=[String(2052), ArrayList(ME)(2359)] -> Bucket(struct_2369)   ✓ correct Bucket
L511  func=yo_id_2188 args=[String(2052), ArrayList(ME)(2359)] -> HashMap(struct_2364)
      func=yo_id_1690 args=[ME(struct_2357)]                  -> Option(*(ME))(enum_2362)  ✗  <-- data field
```

- The `Bucket(K,V)` constructor IS invoked correctly during HashMap's body eval
  and returns `struct_2369` (a proper `Bucket(String, ArrayList(ME))`).
- BUT `(?*)` (`func_1690`) — the operator wrapping the `data` field type — is
  called with **`ME` (struct_2357)**, NOT `struct_2369`. There is NO
  `(?*)(struct_2369)` call anywhere. So the `Bucket(K, V)` ARGUMENT EXPRESSION fed
  to `(?*)` resolved to the innermost RC element `ME`, not the Bucket.
- Pattern side is correct: `func_1690 args=[Bucket(struct_2195)] -> enum_2198`.
- `i32` works because its element is a value type; the divergence is specific to
  an RC/object innermost element (`ME`, `String`).

So the EXACT bug: when evaluating `data : ?*(Bucket(K, V))` during the concrete
`HashMap(String, ArrayList(ME))` body eval, the argument `Bucket(K, V)` passed to
the `?*` operator evaluates to `ME` instead of `Bucket(String, ArrayList(ME))` —
even though `Bucket(...)` is separately/also evaluated to the correct
`struct_2369`. The wrong value (`ME` = the deeply-nested element of
`V = ArrayList(ME)`) leaks into the `?*` argument.

### Next step (final layer)

Instrument the evaluation of the `?*`/`(?*)` call's ARGUMENT in the data-field
context (or `Bucket(K, V)` as an argument expression) to see why it yields `ME`.
Likely an ExprInfo/value aliasing or arg-evaluation bug where a nested generic
application used as a call argument picks up the innermost type of a sibling/RC
type argument. The fix makes `Bucket(K, V)` (as the `?*` argument) resolve to the
already-computed `struct_2369`. Repro: `HashMap(String, ArrayList(ME)).new()`.
