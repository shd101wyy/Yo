# Two structurally identical error enums in two generic impls are conflated

**Status:** **FIXED 2026-08-29.** Found 2026-08-25 while executing
`plans/STD_API_AUDIT.md` §6 round 2 (deleting measured-dead std
declarations). It **blocked** the `HashMapError` / `HashSetError` half of that
item; the other two items (`PathError`, `CustomAllocator`) landed.

**Root cause.** `are_types_compatible_exact`'s `EnumT` arm
(`src/types/compatibility.yo`) compared enums PURELY STRUCTURALLY — variant
names, field labels, field types — with no nominal check at all (the id
fast-accept had been removed because generic instantiations share their
declaration's id). The CTFE memo uses exact compatibility to decide whether a
comptime call (`Result(unit, HashSetError)`) matches a cached instance
(`Result(unit, HashMapError)`), so two same-shaped declared enums were ONE
type to it. The narrowed reproducer needs no std patch at all:
`AErr :: enum(Boom(code : i32))`, `BErr :: enum(Boom(code : i32))`, a generic
`Carrier(E) :: struct(inner : Result(unit, E))` with an impl, and BOTH
`Carrier(AErr)` and `Carrier(BErr)` constructed in one module — the second
construction fails ("Failed to evaluate argument expression": its field type
is the first instantiation's).

**Fix.** Under `require_exact`, two enums whose NAMES are both non-empty and
differ are different types. The name is stamped by the `Name :: enum(...)`
binding, so re-registered eras of one declaration still share it and
converge structurally, and generic instantiations (`Option(i32)` vs
`Option(String)`) share "Option" and are still told apart by the field
compare. Residual (documented, not fixed): two enums with the SAME name in
two modules and identical shape are still conflated.

**Regression test.** `tests/nominal_enum_identity.test.yo` — the user-level
pair through a generic carrier (RED on the previous compiler), value
non-assignability across the pair, and `HashMap` + `HashSet` in one closure.
The std trim this unblocks (`KeyNotFound` / `ElementNotFound` deletion) is
SEED-GATED: the compiler imports both collections, so the trim must wait for
a seed that carries this fix (plans/backlog/SEED_VERSION_AUTOMATION.md).
Original record follows.

## Symptom

When `HashMapError` and `HashSetError` are both reduced to the *same* single
variant, any module that imports **both** `hash_map.yo` and `hash_set.yo` fails
to evaluate:

```
check: error in: Error: Type mismatch for type member "error":
Expected: HashMapError
Got:   HashSetError

std/collections/hash_set.yo:219:25:
      .Err(err) => .Err(err),
                         ^
```

`std/collections/hash_set.yo:219` is the error-propagation arm of
`HashSet._resize`:

```rust
_resize : (fn(self : Self, new_capacity : usize) -> Result(unit, HashSetError))({
  result := Self._alloc_with_capacity(new_capacity);
  match(
    result,
    .Err(err) => .Err(err),        // <-- here
    ...
```

`HashMap._resize` (`std/collections/hash_map.yo:222`) is the *same shape*, and
the reported "Expected" type is the **HashMap** one — i.e. the HashSet
specialization is being type-checked against the HashMap enum.

## Reproducer

`issues/repros/hashmap-hashset-error-enums-collide.yo`.

It needs a std patch to trigger, because today's declarations are not yet
identical. Apply both trims — delete the never-constructed variants so each
enum becomes exactly `enum(AllocError(error : AllocError))`:

```rust
// std/collections/hash_map.yo
HashMapError :: enum(
  /// Memory allocation failed.
  AllocError(error : AllocError)
);

// std/collections/hash_set.yo
HashSetError :: enum(
  /// Memory allocation failed.
  AllocError(error : AllocError)
);
```

then

```bash
YO_STD=$PWD/std yo check issues/repros/hashmap-hashset-error-enums-collide.yo
```

## A/B (measured)

The same source file, the same command, only the std declarations differing:

| std state                                   | result                                     |
| ------------------------------------------- | ------------------------------------------ |
| unpatched (HEAD)                            | compiles; binary prints `BOTH_MAPS_OK` rc=0 |
| **both** enums trimmed                      | **FAILS** with the mismatch above          |
| only `HashMapError` trimmed                 | OK                                         |
| only `HashSetError` trimmed                 | OK                                         |

So the trigger is the *pair* becoming structurally identical, not either trim
on its own.

## Why the existing tests do not catch it

`tests/collections/hash_map.test.yo` imports only `hash_map.yo`. With both
enums trimmed it still reports **61 passed / 61 total**, because `hash_set.yo`
is never loaded in that compilation and the two enums never meet. The bug needs
**both** modules in one import closure. Any regression test for this must
import both.

## What is NOT yet narrowed down

Simplified reproductions did **not** trigger it, so the mechanism is narrower
than "structural interning of enums":

- Two identical enums (`AErr`/`BErr` with the same single variant name, the
  same payload field name and the same payload type) declared in **one file**
  — evaluator OK.
- The same pair declared in **two separate modules**, both importing the
  payload type from a third module, each used in a
  `match(..., .Err(err) => .Err(err))` propagation inside a non-generic
  `impl` — evaluator OK.

The real case differs in that both enums are used inside **generic** impls
(`HashMap(K, V)` / `HashSet(T)`) whose `_resize` methods are near-identical in
shape. That points at the generic-impl **specialization / instantiation memo**
keying on something that no longer distinguishes the two error types once their
declarations coincide, rather than at plain nominal-type interning. Compare the
prior wrong-merge in this family: `yo-self intern-key SomeT wrong merge` and the
codegen enum-identity dedup.

## Impact

Latent, not currently reachable from `std/` as shipped: it needs two
structurally identical error enums used from two generic impls in one import
closure. But it is a **soundness hole in nominal typing** — two distinct
declared types are being unified — and it silently blocks otherwise correct
dead-code removal in std. It would also bite any user crate that happens to
declare the same shape twice.

## Next step

Instrument the generic specialization key (`src/evaluator/calls/`) for
`_resize` under the patched std, and confirm whether the HashSet specialization
is reusing the HashMap entry. If so, the key must include the nominal identity
of the declared error enum, not just its structure.
