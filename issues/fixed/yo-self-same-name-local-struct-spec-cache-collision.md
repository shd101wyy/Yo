# yo-self: same-named LOCAL structs collide the specialization cache (one spec, param t10 / return t11)

Status: FIXED (2026-07-17, same day). The exact-struct arm of
`_compat_impl` (types/compatibility.yo) gained a SAME-NAMED-distinct-
declarations rule: same non-empty name + different ids + no SomeT + no
type_arguments → DISTINCT under require_exact (reaching that point in the
cond chain already implies aid != eid). Generic instantiations carry
type_arguments and cfid-empty copies share ids, so both stay structural.
Verified: repro prints 10/20 (== TS), tk2 3-HashMap repro intact, corpus
130/2-known, std 153/153, fixpoint byte-identical.

## 17-line repro (src/tests/fixme.yo shape; TS prints 10/20, s1 clang-fails)

```rust
open(import("std/string"));
open(import("std/fmt"));
ident :: (fn(forall(T : Type), v : T) -> T)(v);
f1 :: (fn() -> i32)({
  Counter :: struct(count : i32);
  c := ident(Counter(i32(10)));
  c.count
});
f2 :: (fn() -> i32)({
  Counter :: struct(count : i32);
  c := ident(Counter(i32(20)));
  c.count
});
main :: (fn() -> unit)({
  println(f1().to_string());
  println(f2().to_string());
});
export(main);
```

s1 emits TWO C struct types (t10/t11 — interning distinguishes them) but
ONE `ident` specialization whose PARAM is t10 and RETURN is t11 →
`initializing __yo_t10 with __yo_t11` / `returning __yo_t10 from __yo_t11
function`. TS emits two C types AND two specializations (keyed
`idstruct_<file>_id_25` / `id_60` — unique numeric `type.id`).

## Probe evidence (2026-07-17; [SID] in evaluator/types/struct.yo:74,

[SIG] on value_to_signature_string's TypeVal arm)

- `[SID] created struct_yo_id_5009` (f1's Counter), later
  `[SID] created struct_yo_id_5014` (f2's) — the sids ARE distinct.
- `[SIG] Counter_id_struct_yo_id_5009_i32` printed ONCE — call 2 never
  computes a specialization signature at all: the cache lookup
  (`_find_specialization_cache`, evaluator/calls/helper.yo:874) HITS
  before `compute_compile_time_signature` runs (helper.yo:1228 is on the
  cache-MISS path only).
- Renaming the structs CounterA/CounterB → everything works (two sigs,
  keys `..._id_5009_i32` / `..._id_5014_i32`) — the collision is NAME-gated.

## Root cause

`_find_specialization_cache` compares runtime param types with
`are_types_compatible_exact`. Its exact-struct arm
(types/compatibility.yo:463-599) walks: type_arguments differ? →
`aid == eid`? → shells → ref/atomic/newtype kind → NOMINAL distinctness
(**different non-empty names → false**) → STRUCTURAL field comparison.
Two same-named distinct local declarations (ids 5009/5014, same shape,
no type_arguments, no SomeT) fall through name-equality to the structural
tail → **true** → call 2 reuses call 1's cached specialization; the
call-site return-type re-resolution then stamps Counter#2 into the shared
spec (param C type from #1, return from #2).

TS compares with `areTypesCompatible(..., requireExactMatch=true)` — a
**strict type-ID comparison** (helper.ts:2288-2292): Counter#1.id ≠
Counter#2.id → cache miss → second specialization.

Same-shape comptime-arg comparison (`eval_value_eq` on TypeVal) likely has
the same weakness for the T binding — verify while fixing.

## Fix considerations (NOT yet implemented)

The blocker is that yo-self struct `id`s CHURN: `struct.yo:74` assigns
`struct_${random_id(...)}` per EVALUATION, so the same declaration
re-evaluated gets a new id, while generic instantiations of one
declaration SHARE one id ("shared-id generics"). Plain id-inequality ⇒
distinct would split every re-evaluation into its own specialization.
Candidate direction:

1. Make sids DECLARATION-STABLE (derive from the struct expr's
   `ast_expr_id` instead of `random_id`) — same declaration re-evaluated
   keys the same; distinct declarations differ; generic instantiations
   keep sharing (they already share one eval id today). THEN add, in the
   exact-struct arm before the structural tail: both names non-empty and
   EQUAL, ids non-empty and DIFFERENT, no SomeT on either side, empty
   type_arguments → **false** (distinct declarations).
2. Audit the fallout: ""-named `type_of_eval_value` reconstructions must
   keep matching their originals (they are excluded by the non-empty-name
   gate only if reconstructions stay ""-named — verify); the g*struct*
   cfid_keys/type_key machinery assumes eval-shared ids for generics —
   declaration-stable ids should be a superset of that behavior but the
   poison-slot transitions need a re-check; the comptime-fn CTFE cache
   uses the same comparator (collisions there have their own history —
   see the comments in compatibility.yo).

Gates for any attempt: this repro (10/20), tk2 (3 HashMaps), corpus,
std, fixpoint, then re-sweep `/tmp/s2_r2_list.txt`.
