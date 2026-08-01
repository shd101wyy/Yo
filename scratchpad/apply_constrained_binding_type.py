#!/usr/bin/env python3
"""Port TS's `useConstrainedSomeType` / `bindingType` producer
(src/evaluator/calls/helper.ts:544-566) into yo-self's parameter binding.

    python3 scratchpad/apply_constrained_binding_type.py
    ./yo-cli fmt yo-self/evaluator/calls/helper.yo
    ./yo-cli check ./yo-self | tail -1        # expect 295/305

TS, when a RUNTIME parameter's type is a where-clause-CONSTRAINED generic SomeT,
binds the parameter to a CLONE of that SomeT carrying
`resolvedConcreteType = argType`:

    const useConstrainedSomeType =
      !isParamCompileTimeOnly &&
      isSomeType(parameterType) &&
      (getWhereClauseConstraintsForSomeType(calleeEnv, parameterType)
        ?.requiredTraits?.length ?? 0) > 0;
    const bindingType = useConstrainedSomeType
      ? { ...(parameterType as SomeType), resolvedConcreteType: argType }
      : argType;

Keeping the SomeT preserves trait-only method dispatch in the body; the attached
concrete lets codegen and compatibility see through it. yo-self already has the
CONSUMER (types/compatibility.yo's given-SomeT unwrap, and
codegen/exprs/closures.yo's `resolve_some_type_to_concrete`, which reads the
per-object cell first) — the producer was never ported, so a constrained binder
reaches the body bare.

Measured symptom: tests/iterator_combinators hollows at std/prelude.yo:8015,
`IterMap(Self, B, F)(_inner : self, _f : f)`, with
`Type mismatch for type member "_f": Expected fn(item : i32) -> i32,
 Got F : (Fn(A) -> B + Fn(i32) -> B)` — note the field is already CONCRETE and it
is the ARGUMENT that is still the bare forall. Every resolution stamp yo-self has
today (calls/type.yo's arg-capture stamp, helper.yo's `_capbind_` per-spec
rebuild, anonymous_function.yo's take-on) is gated on a capture struct, and this
test's closures (`x => (x * i32(2))`) capture nothing, so all of them are inert.

The rebuild mints a FRESH `t_resolved_cell(arg_type)` rather than pushing onto
the existing cell — the value-semantics equivalent of TS's object spread, and the
reason TS clones: "the parameterType is shared across all callers of this
function type". The id is preserved, so nothing new enters the id-keyed
`g_some_resolved_concrete` registry.
"""
import sys

P = "yo-self/evaluator/calls/helper.yo"

IMPORT_OLD = """  clone_env,
  snapshot_env,
  make_err_variable
} :: import("../../env.yo");"""
IMPORT_NEW = """  clone_env,
  snapshot_env,
  make_err_variable,
  get_where_clause_constraints_for_some_type
} :: import("../../env.yo");"""

ANCHOR = """  match(
    adopt_receiver_struct_instance(final_pt, arg_type),
    .Some(bind_adopted) => {
      bind_pt = bind_adopted;
    },
    .None => ()
  );
  param_tok := synthetic_token(param_label, callee_env_r.module_path);"""

BLOCK = """  match(
    adopt_receiver_struct_instance(final_pt, arg_type),
    .Some(bind_adopted) => {
      bind_pt = bind_adopted;
    },
    .None => ()
  );
  // Port of TS helper.ts:544-566 (`useConstrainedSomeType` / `bindingType`).
  // When a RUNTIME parameter's type is a where-clause-CONSTRAINED generic SomeT
  // that synthesis could not resolve, TS keeps the SomeT as the binding type —
  // so method dispatch in the body still only sees the constrained trait — but
  // binds a CLONE carrying `resolvedConcreteType = argType`, "because the
  // parameterType is shared across all callers of this function type". yo-self
  // already has the CONSUMERS (compatibility.yo's given-SomeT unwrap and
  // codegen's `resolve_some_type_to_concrete`, both of which read the
  // per-object cell first) but never had this producer, so the binder reached
  // the body bare: `IterMap(Self, B, F)(_inner : self, _f : f)`
  // (std/prelude.yo) threw `Type mismatch for type member "_f"` with a concrete
  // FIELD and a still-symbolic ARGUMENT. Every stamp yo-self does have is gated
  // on a capture struct, so all of them are inert for a NON-capturing closure —
  // which is exactly what that corpus passes. Rebuild with a FRESH
  // `t_resolved_cell`, never a push onto the shared lineage cell; the id is
  // preserved, matching TS's spread, so the id-keyed registry is untouched.
  bind_pt_src := bind_pt.clone();
  if((!(is_ct_only)) && is_some_type(bind_pt_src), {
    bpc_has_required := match(
      get_where_clause_constraints_for_some_type(callee_env_r, bind_pt_src),
      .Some(bpc_wcc) => (bpc_wcc.required_traits.len() > usize(0)),
      .None => false
    );
    if(bpc_has_required, {
      match(
        bind_pt_src,
        .SomeT(
          bpc_id,
          bpc_nm,
          bpc_lvl,
          bpc_parent,
          bpc_rtt,
          bpc_rtl,
          bpc_ntt,
          bpc_ntl,
          bpc_ier,
          bpc_kft,
          _
        ) => {
          bind_pt = TypeValue.SomeT(
            bpc_id,
            bpc_nm,
            bpc_lvl,
            bpc_parent,
            bpc_rtt,
            bpc_rtl,
            bpc_ntt,
            bpc_ntl,
            bpc_ier,
            bpc_kft,
            t_resolved_cell(arg_type.clone())
          );
        },
        _ => ()
      );
    });
  });
  param_tok := synthetic_token(param_label, callee_env_r.module_path);"""

s = open(P).read()
if IMPORT_OLD not in s:
    sys.exit("env.yo import anchor missing")
if s.count(ANCHOR) != 1:
    sys.exit(f"Step 9 anchor count = {s.count(ANCHOR)}, expected 1")
s = s.replace(IMPORT_OLD, IMPORT_NEW, 1)
s = s.replace(ANCHOR, BLOCK, 1)
open(P, "w").write(s)
print(f"patched {P}")
print("Now run: ./yo-cli fmt", P, "&& ./yo-cli check ./yo-self | tail -1")
