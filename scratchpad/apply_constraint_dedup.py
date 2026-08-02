#!/usr/bin/env python3
"""Dedup trait bounds when appending to a SomeT's own required/negative lists.

    python3 scratchpad/apply_constraint_dedup.py
    ./yo-cli fmt yo-self/evaluator/types/function.yo
    ./yo-cli check ./yo-self | tail -1      # expect 295/305

`_add_where_clause_constraint` (yo-self/evaluator/types/function.yo:840) pushes
UNCONDITIONALLY into the SomeT's shared `required_trait_types` /
`negative_trait_types` arrays. Because those arrays are shared by reference,
every re-validation of the same where clause appends another copy. Measured at
the `entries.yo` codegen panic, the stable identity of one SomeT rendered as:

    V : (Send + Send + Send + ... x32)
    K : ((== : fn(lhs : Self, rhs : K) -> bool, ...) + Hash + Send) x ~30

TS dedups by trait id at BOTH of its write sites:
  * src/env.ts:420-423 (env-frame constraints)
        const targetList = isNegated ? entry.negativeTraits : entry.requiredTraits;
        if (!targetList.some((t) => t.id === traitType.id)) { targetList.push(traitType); }
  * src/evaluator/types/function.ts:656-682 (merging into a SomeType's own lists)
        const mergedRequiredTraits = [...existingSomeType.requiredTraits];
        for (const trait of newSomeType.requiredTraits) {
          if (!mergedRequiredTraits.some((t) => t.traitType.id === trait.traitType.id)) {
            mergedRequiredTraits.push(trait);
          }
        }

yo-self already ports the FIRST one faithfully -- `add_where_clause_constraint_to_env`
(env.yo:1883) has the id scan -- and `_merge_trait_list` (env.yo:1846) is the
same dedup for the read side. Only this SomeT-list push site was missed.

`_trait_type_id` is defined in env.yo:1837 but NOT exported, so this restates the
two-line id extraction locally rather than widening env.yo's export surface.
"""
import sys

P = "yo-self/evaluator/types/function.yo"

OLD = """_add_where_clause_constraint :: (
  fn(
    some_ty : TypeValue,
    trait_ty : TypeValue,
    is_negated : bool
  ) -> unit
)(
  match(
    some_ty,
    .SomeT(_, _, _, _, required_trait_types, required_trait_levels, negative_trait_types, negative_trait_levels, _, _, _) => {
      if(is_negated, {
        negative_trait_types.push(trait_ty);
        negative_trait_levels.push(usize(0));
      }, {
        required_trait_types.push(trait_ty);
        required_trait_levels.push(usize(0));
      });
    },
    _ => ()
  )
);"""

NEW = """/// The identity TS compares trait bounds by (`traitType.id`). Restated here
/// because env.yo's `_trait_type_id` (env.yo:1837) is private.
_wcc_trait_id :: (fn(t : TypeValue) -> String)(
  match(
    t,
    .TraitT(_, _, _, _, wcc_tid, _, _, _, _, _) => wcc_tid,
    _ => String.from("")
  )
);
/// True iff `list` already holds a trait with the same id as `trait_ty`.
_wcc_has_trait :: (fn(list : ArrayList(TypeValue), trait_ty : TypeValue) -> bool)({
  wcc_want := _wcc_trait_id(trait_ty);
  wcc_n := list.len();
  (wcc_found : bool) = false;
  (wcc_i : usize) = usize(0);
  while((wcc_i < wcc_n) && !(wcc_found), {
    match(
      list.get(wcc_i),
      .Some(wcc_e) => if(_wcc_trait_id(wcc_e) == wcc_want, {
        wcc_found = true;
      }),
      .None => ()
    );
    wcc_i = (wcc_i + usize(1));
  });
  wcc_found
});
_add_where_clause_constraint :: (
  fn(
    some_ty : TypeValue,
    trait_ty : TypeValue,
    is_negated : bool
  ) -> unit
)(
  match(
    some_ty,
    .SomeT(_, _, _, _, required_trait_types, required_trait_levels, negative_trait_types, negative_trait_levels, _, _, _) => {
      // Dedup by trait id before appending. A SomeT's trait lists are shared by
      // REFERENCE, so re-validating the same where clause used to append another
      // copy every time — measured at the entries.yo codegen panic, one SomeT's
      // identity rendered as `V : (Send + Send + ... x32)` and a `==`/`Hash`
      // bound repeated ~30 times. TS dedups by `traitType.id` at both of its
      // write sites: src/env.ts:420-423 for env-frame constraints, and
      // src/evaluator/types/function.ts:656-682 when merging into a SomeType's
      // own `requiredTraits`/`negativeTraits`. yo-self already ports the first
      // (env.yo:1883 `add_where_clause_constraint_to_env`, same id scan) and has
      // the read-side twin (`_merge_trait_list`, env.yo:1846); this SomeT-list
      // push was the one site that kept appending.
      if(is_negated, {
        if(!(_wcc_has_trait(negative_trait_types, trait_ty)), {
          negative_trait_types.push(trait_ty);
          negative_trait_levels.push(usize(0));
        });
      }, {
        if(!(_wcc_has_trait(required_trait_types, trait_ty)), {
          required_trait_types.push(trait_ty);
          required_trait_levels.push(usize(0));
        });
      });
    },
    _ => ()
  )
);"""

s = open(P).read()
if s.count(OLD) != 1:
    sys.exit(f"anchor count = {s.count(OLD)}, expected 1")
open(P, "w").write(s.replace(OLD, NEW, 1))
print(f"patched {P}")
