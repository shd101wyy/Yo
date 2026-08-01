#!/usr/bin/env python3
"""PROBE ONLY — never commit. Three prints that decide why `where(Self <:
Iterator(Item := A), F <: (Fn(a : A) -> B))` leaves A and B as raw SomeTs in the
specialized return type (tests/where_clause_fn_inference, and the same family in
iter_filter_closure / iterator_combinators).

    python3 scratchpad/probe_where_ab.py            # apply
    ./yo-cli fmt yo-self/evaluator/types/function.yo yo-self/evaluator/trait_checking.yo \
             yo-self/evaluator/calls/helper.yo
    ./yo-cli check ./yo-self | tail -1              # expect 295/305
    # build, then:
    <bin> compile src/tests/fixme.yo --emit-c --skip-c-compiler --release -o /tmp/p 2>&1 | grep __DBG

Revert with: git checkout <the three files>

Reads, in order:
  __DBG_VC   — is the concrete-LHS where-clause validation reached at all, and
               with which trait? (yo-self/evaluator/types/function.yo,
               validate_concrete_type_constraints, port of TS
               validateConcreteTypeConstraints / function.ts:1526)
  __DBG_ATC  — does _check_associated_type_constraints resolve `Item` and does
               _assoc_synth_env bind the constraint SomeT?
               (yo-self/evaluator/trait_checking.yo)
  __DBG_RTE  — does the mint's return-type-EXPRESSION re-evaluation run, and
               what does it produce? (yo-self/evaluator/calls/helper.yo)

If __DBG_VC never prints for `Iterator`, the validation is not reached and the
fix is upstream. If it prints but __DBG_ATC shows no resolve, the associated-type
lookup is the gap. If both are fine but __DBG_RTE still shows SomeTs, the
bindings are not visible BY NAME in the env the return expression is evaluated in.
"""
import sys

FN = "yo-self/evaluator/types/function.yo"
TC = "yo-self/evaluator/trait_checking.yo"
HP = "yo-self/evaluator/calls/helper.yo"


def patch(path, pairs, need_fmt_import=False):
    s = open(path).read()
    for old, new in pairs:
        if s.count(old) != 1:
            sys.exit(f"anchor count {s.count(old)} in {path}: {old[:100]}")
        s = s.replace(old, new, 1)
    if need_fmt_import and 'import("std/fmt")' not in s:
        anchor = '{ type_to_string } :: import("../types/string.yo");'
        if anchor not in s:
            sys.exit(f"no fmt-import anchor in {path}")
        s = s.replace(anchor, anchor + '\n{ eprintln } :: import("std/fmt");', 1)
    open(path, "w").write(s)
    print("patched", path)


patch(FN, [(
    """      tc_res := type_implements_trait(concrete_type, tv, env_mut);
      implemented := tc_res.implemented;""",
    """      tc_res := type_implements_trait(concrete_type, tv, env_mut);
      implemented := tc_res.implemented;
      {
        __vc_i := if(implemented, String.from("y"), String.from("n"));
        eprintln(`__DBG_VC concrete=${type_to_string(concrete_type)} trait=${type_to_string(tv)} impl=${__vc_i}`);
      };""",
)], need_fmt_import=True)

patch(TC, [(
    """        if(!(are_types_compatible(resolved, constraint_ty)), {
          ok = false;
        }, {""",
    """        {
          eprintln(`__DBG_ATC label=${label.clone()} constraint=${type_to_string(constraint_ty)} resolved=${type_to_string(resolved)}`);
        };
        if(!(are_types_compatible(resolved, constraint_ty)), {
          ok = false;
        }, {""",
)], need_fmt_import=True)

patch(HP, [(
    """  wce_exprs := get_func_where_clause_exprs(func_id);
  if(wce_exprs.len() > usize(0), {""",
    """  wce_exprs := get_func_where_clause_exprs(func_id);
  eprintln(`__DBG_RW fid=${func_id.clone()} n_wce=${wce_exprs.len().to_string()}`);
  if(wce_exprs.len() > usize(0), {""",
), (
    """                match(
                  rte_out.get(usize(0)),
                  .Some(rte_ty) => {
                    if(((get_all_some_types(rte_ty).len() == usize(0)) && !(_type_has_array_len_var(rte_ty))) && !(is_unit_type(rte_ty)), {
                      spec_ret_ty = rte_ty;
                      rte_adopted = true;
                    });
                  },
                  .None => ()
                );""",
    """                {
                  __rte_s := match(rte_out.get(usize(0)),.Some(t) => type_to_string(t),.None => String.from("<none>"));
                  eprintln(`__DBG_RTE spec_ret=${type_to_string(spec_ret_ty)} reeval=${__rte_s}`);
                };
                match(
                  rte_out.get(usize(0)),
                  .Some(rte_ty) => {
                    if(((get_all_some_types(rte_ty).len() == usize(0)) && !(_type_has_array_len_var(rte_ty))) && !(is_unit_type(rte_ty)), {
                      spec_ret_ty = rte_ty;
                      rte_adopted = true;
                    });
                  },
                  .None => ()
                );""",
)], need_fmt_import=True)

print("\nfmt + check, then build. Revert with git checkout.")
