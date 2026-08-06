# yo-self: specialization signature not instantiation-precise (shared Bucket GcTracer visit fn)

**Status:** fix in validation (2026-07-15).

## Error (verbatim, stage-2 self-emit)

```
/tmp/stage2.c:316334:24: error: member reference base type 'size_t' (aka 'unsigned long') is not a structure or union
/tmp/stage2.c:316336:20: error: member reference base type 'size_t' (aka 'unsigned long') is not a structure or union
/tmp/stage2.c:316336:76: error: member reference base type 'size_t' (aka 'unsigned long') is not a structure or union
```

The function `yo_id_12__struct_struct_yo_id_12567__rtparam0_struct_yo_id_10___u8__rtparam1____struct_struct_yo_id_12567___ret_unit`
(the `GcTracer.visit` specialization for a HashMap `Bucket`) has signature slot
type `__yo_t657*` (a `{ size_t key; V* value; }` bucket) but a body that visits
`.key.tag` / `.key.data.Some.value` (an `Option`-key bucket layout). 36 call
sites pass 36 _different_ `__yo_tN*` bucket layouts to this ONE function.

## Minimal repro

`/tmp/tk2.yo` — three structurally different HashMap instantiations:

```rust
{ println } :: import("std/fmt");
open(import("std/string"));
{ HashMap } :: import("std/collections/hash_map");
Node :: ref(struct(x : i32, next : Option(Self)));
Pair :: ref(struct(a : i32));
main :: (fn() -> unit)({
  m1 := HashMap(i32, Node).new();
  m1.set(i32(1), Node(x : i32(1), next :.None));
  m2 := HashMap(String, Node).new();
  m2.set(String.from("k"), Node(x : i32(2), next :.None));
  m3 := HashMap(i32, Pair).new();
  m3.set(i32(3), Pair(a : i32(3)));
  println(`sizes ${m1.len()} ${m2.len()} ${m3.len()}`);
});
export(main);
```

yo-self emitted **1** `yo_id_12_…struct_yo_id_5058…` visit fn for all three;
TS emits **3** distinct `…_visit_Bucket_u40_i32_u44_…_idstruct_yo…_id_NNNN`
specializations (one per instantiation).

## Root cause (two halves of the same TS-parity gap)

TS keys every type by a unique numeric per-instantiation `type.id`, and
`valueToSignatureString` (src/evaluator/calls/helper.ts:2103) renders a type
value as `${valueToString(value)}_id${type.id}` — instantiation-precise.

yo-self has no numeric type id; its identity is `type_key` (types/type_key.yo,
structural for shared-id generics). But the specialization-signature path never
reached that machinery:

1. `value_to_signature_string` (evaluator/calls/helper.yo:705) rendered
   `.TypeVal(t)` with bare `type_to_string(t)`. An anonymous generic
   instantiation renders `<struct:yo_id_N>` where N is the shared
   **declaration** id — identical for every `Bucket(K,V)` instantiation, so
   `visit(T = Bucket(...))` computed the SAME `compute_compile_time_signature`
   for all of them → one cached specialization served every layout.
2. `_type_key_at` had **no `Pointer` branch** — `*(Bucket)` fell to the
   `_ => type_to_string(t)` fallback, rendering `*(<struct:yo_id_N>)`, so the
   `rtparam` signature segments (which DO use `type_key`, helper.yo:824) were
   equally blind for pointer-to-anonymous-instantiation params.

The struct branch of `type_key` already had the poison-slot/structural-key
machinery built for exactly this Bucket case — the signature path just bypassed
it via `type_to_string`.

Latent severity beyond the clang error: with one visit fn for all bucket
layouts, the cycle-GC traced the WRONG fields for 35 of 36 HashMap
instantiations (skipped edges → premature frees possible; visited garbage →
UB). Which single layout won was emission-order-dependent — the codegen-side
drop-emission fixes (scope-stack liveness) shifted lazy type-registration
order, flipping the winner and surfacing the mismatch as a syntactic error.

## Fix

- `value_to_signature_string`: `.TypeVal(t)` → `` `${type_to_string(t)}_id_${type_key(t)}` ``
  (mirrors TS `_id${type.id}` with yo-self's identity function).
- `_type_key_at`: add `.Pointer(pointee)` branch that recurses into the pointee
  (`*(<recur(pointee)>)`), so pointer keys inherit the struct machinery's
  precision.

`Array`/`Tuple` still fall to `type_to_string` (same theoretical imprecision
for anonymous-instantiation elements); no observed failure — flagged here for
a future pass.

## Validation gates

- `/tmp/tk2.yo` self-compiled: 3 distinct visit fns (== TS).
- `/tmp/hmap.yo`: `tracked=2` (leak fix intact).
- stage-2 self-emit: clang errors 0.
- corpus diff-test 119 PASS / DIFF 0; `check ./yo-self` 303/303; `check ./std` 153/153.
