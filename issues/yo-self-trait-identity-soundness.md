# yo-self: `Type.impls` / trait satisfaction is identity-unsound

## Symptom

Three integration tests fail under the def-eval / `is_executing` build because
`Type.impls(T, Trait)` returns the wrong answer for _negative_ queries:

- `tests/atomic_object.test.yo` — `comptime_assert(Type.impls(RegularPoint, Send) == false, …)`
  fails (a plain `object` wrongly reports `Send`).
- `tests/thread_safety.test.yo` — `JoinHandle must not be Send` fails (same class).
- `tests/negative_impl.test.yo` — `negative generic impl should override
auto-derive for Container(i32)` fails (separate; see §3).

These pass on the committed `is_executing=false` build only because their
module-level `comptime_assert`s never run there.

## Root cause — trait identity is matched by NAME, and yo-self traits are nameless

`type_implements_trait` (yo-self/evaluator/trait_checking.yo) step 4 calls
`is_type_registered_as_trait`, which compares the queried trait against the
type's auto-derived trait list (`g_type_trait_registry`) with
`are_types_compatible`. yo-self's `TraitT` compatibility (types/compatibility.yo
~line 499) is **name-based** (`aname == ename`), and **every marker trait
(`Send`/`Rc`/`Acyclic`/`Comptime`/`Runtime`) is nameless** (empty name — see
trait.yo:1097 `trait_name_str := String.from("")`).

Consequence: `"" == ""` makes **every marker mutually compatible**. A plain
`object` auto-derives `Rc`/`Runtime`/`Acyclic` (utils.yo) but NOT `Send`; yet
`Type.impls(obj, Send)` matches the registered `Rc` by empty name → wrongly
`true`. (TS compares trait types by `id`, compatibility.ts:543-549.)

## Why the obvious fix (compare markers by `id`) regresses

Switching `is_type_registered_as_trait` to compare by `_trait_type_id` (id)
fixes the simple marker case (`RegularPoint` no longer `Send`) but **breaks
every positive method-trait query** — e.g. `Type.impls(Dog, Greet)` for
`impl(Dog, Greet(...))` starts returning `false`. Reason: concrete
method-trait satisfaction is **recorded nowhere** that `type_implements_trait`
checks by identity:

- `register_type_trait` (the `g_type_trait_registry` step-4 list) is called
  ONLY for the 5 auto-derived markers (utils.yo) — never for explicit impls.
- concrete `impl(Dog, Greet)` registers its methods via
  `register_type_trait_method` with **empty `source_trait_id`** (impl.yo:1810,
  1819-1829 — "direct-on-type methods don't carry a source-trait link").
- the generic-impl registry / step 8 only holds `forall(...)` impls.

So `Dog impls Greet` ONLY ever resolved via the same step-4 **name-collision
accident** (nameless `Greet` matched `Dog`'s nameless markers). Removing the
collision (id-compare) removes the only path that answered method-trait queries.

## Faithful fix (the real work)

Mirror TS, where a type's `.trait` field lists ALL implemented traits (markers
AND explicit impls), matched by **stable trait `id`**:

1. **Distinct marker ids that survive comparison.** Either give marker traits
   their binding names (`Send`/`Rc`/… instead of `""`) so the name compare
   distinguishes them, OR switch `is_type_registered_as_trait` to id-compare
   (markers already get distinct `trait_<id>` ids).
2. **Record concrete method-trait satisfaction by identity.** When
   `impl(T, SomeTrait(...))` registers, add `SomeTrait` (by its BASE id) to
   `T`'s trait list (or set `source_trait_id` to the base trait id and add a
   step that checks the method registry). Then a method-trait query resolves
   by id, not by the nameless accident.
3. **Trait-id stability.** The concrete trait constructor `SomeTrait(...)`
   currently mints a fresh `concrete_module_<…>` id (concrete_trait.yo) distinct
   from the base `SomeTrait`. For id-based matching to work between impl-time and
   query-time, the registered trait and the queried trait must share an id —
   register/query the BASE trait id consistently.

Doing 1+2 together (not either alone) is required, else positive method-trait
queries regress. This is a coordinated trait-identity overhaul, not a one-liner.

## §3 — negative_impl needs a separate port

`impl(forall(T), Container(T), !(Send))` is a NEGATIVE GENERIC impl. yo-self only
checks CONCRETE negative impls (`has_negative_impl`, keyed by exact type id);
TS's `findMatchingNegativeGenericImpl` (impl.ts:296) + the
`negativeGenericImplRegistry` are unported (noted at trait_checking.yo:435). Port
the registry population at the `impl(forall, Pattern, !(Trait))` site + a
`try_match_generic_impl`-based lookup as step 0 of `type_implements_trait`.

## Status

These 3 tests are the only remaining failures of the def-eval / `is_executing`
WIP after the derive-comptime chain + the worker-stack fix (std 151/151,
tests 168/182 = 11 known + these 3, yo-self 228/228). They were already failing
in the prior WIP — not a regression from the derive/stack work.

## Update — overhaul implemented; reveals a THIRD cause for atomic_object/thread_safety

The trait-identity overhaul (steps 1+2) is implemented:

- `is_type_registered_as_trait` now compares by `_trait_type_id` (markers are
  distinct by id; the nameless-trait name collision is gone).
- concrete `impl(T, Trait(...))` now records the impl'd base trait into the
  type's trait list via `register_type_trait_value` (routed through a function
  pointer `g_register_trait_value_fn` to break the impl.yo ↔ trait_checking.yo
  import cycle, installed in `_trait_checking_init`). `current_trait_ty` is the
  base trait (via `_try_lookup_trait_type` on the constructor head), so its id
  matches the query id.

Result: the SIMPLE marker case is fixed (`RegularPoint` alone is correctly NOT
`Send`) and positive method-trait queries resolve by id (`Type.impls(Dog,
Greet)` true). std 151/151, tests 168/182 — regression-free.

BUT atomic_object/thread_safety STILL fail, now for a different (previously
masked) reason: in the `open(import("std/fmt"))` + `atomic(object(...))`
context, `Type.impls(RegularPoint, Send)` evaluates to **unknown** (both
`comptime_assert(impls)` and `comptime_assert(!(impls))` fail), so
`impls == false` is not provably true. Neither alone (`fmt`-only or
`atomic`-only) reproduces it. The name-collision used to return a (wrong)
concrete `true` regardless, so this unknown was invisible. This is a THIRD,
distinct bug — `Type.impls`/`Send` resolution yielding `unknown` for a plain
object only in the combined context — to be root-caused next (instrument
`evaluate_yo_type_impls`' unknown-return path + the trait-check result for the
RegularPoint Send query). negative_impl remains blocked on the unported
negative-generic-impl matcher (§3).
