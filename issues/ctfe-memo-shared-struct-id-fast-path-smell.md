# The CTFE memo's raw-id fast paths rest on a false invariant (NOT reproduced)

**Status:** OPEN as a hardening opportunity — **no reproducer found**. Filed so
the next person does not re-derive the theory, and does not chase it as a live
bug either.
**Found:** 2026-08-25, while fixing
issues/fixed/nested-same-adaptor-instantiation-identity-split.md.

## The false invariant

Two places in `src/evaluator/calls/comptime_fn.yo` decide two types are the same
when their struct ids match, without comparing type arguments:

- `_ctfe_types_era_equal` — `if((a_sid.len() > 0) && (a_sid == b_sid), return(true))`
- `_ctfe_args_equal` — `((a_struct_id.len() > 0) && (a_struct_id == b_struct_id)) => true`

The justifying idea is that a struct id is unique per definition. That is **false**
for generic instantiations: `substitute()` (`src/types/substitution.yo`) keeps the
def-era `id` and `constructor_func_id` while rewriting type arguments, so every
instantiation of one constructor shares a single id and the distinction lives only
in the rendered type key.

On paper, then, two DIFFERENT instantiations used as memo ARGUMENTS should compare
equal, and a second lookup should adopt the first's instance.

## Why it is NOT filed as a bug: the predicted trigger works

The predicted trigger — two self-nested chains at different element types in one
module, so both outer lookups key on an argument carrying the shared id — was
built and run. It produces correct results:

```rust
a := (i32(0) .. i32(4)).rev().rev().collect(ArrayList(i32));   // [0, 1, 2, 3]
b := (i64(0) .. i64(4)).rev().rev().collect(ArrayList(i64));   // [0, 1, 2, 3]
c := (u8(0)  .. u8(3)).rev().rev().collect(ArrayList(u8));     // [0, 1, 2]
d := (i32(1) ..= i32(3)).rev().rev().map((x) => (x * i32(10))) // [10, 20, 30]
       .collect(ArrayList(i32));
```

`count()` variants of the same shapes are also correct. So either the lookups do
not collide in practice (something upstream keys the entries more finely than the
fast paths suggest), or the collision needs a shape not yet found. Three element
types and a mapped chain were tried.

## If a reproducer ever appears

The smallest sound hardening is to treat equal ids as decisive only when the two
sides' `type_arguments` are pairwise era-equal (two empty lists being trivially
equal). That preserves both documented reasons those paths exist:

- a recursive struct's self-shell shares **both** the id and the type arguments,
  so it still unifies;
- the enum `__self_shell` strip is untouched — and it is load-bearing: it is what
  keeps two calls landing in ONE memo entry rather than minting two
  `ArrayList(MyExpr)` instantiations whose traverse/drop machinery cross-corrupted
  the heap (`issues/repros/recursive-enum-box-plus-arraylist-self.yo`).

It must be landed alone with its own full battery — it perturbs CTFE memo identity
globally, and the `Option(Node-era-A)`/`Option(Node-era-B)` convergence and the
`Bucket`/`ArrayList(u8)` cross-module unification both depend on these paths.

## The real fix for the whole family, for the record

Every repair in this family — #247's operator-arm canonicalization, the
method-arm twin, and this hardening — patches a stamping or comparison site
rather than the invariant. A full fix gives `substitute()` instantiation-unique
ids (or interposes an identity layer that does), so one eval struct id never
serves many instantiations. That is a campaign, not a patch.
