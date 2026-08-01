#!/usr/bin/env python3
"""Port TS's return-type EXPRESSION re-evaluation into yo-self's inline FuncVal
call arm, so an HKT application `-> F(A)` reduces instead of staying a TypeApp.

    python3 scratchpad/apply_hkt_ret_reeval.py
    ./yo-cli fmt yo-self/evaluator/calls/function.yo
    ./yo-cli check ./yo-self | tail -1        # expect 295/305

TS resolves a call's return type by RE-EVALUATING the declared return-type
expression in the bound callee env (src/evaluator/calls/helper.ts:1533-1546 →
src/evaluator/types/function.ts:2822-2836). `-> F(A)` with the type constructor
`Option` bound to `F` therefore routes through evaluateFunctionCall's ordinary
comptime-call path and yields the concrete `Option(i32)`; TS only builds a
TypeApplication while the callee is still an abstract SomeType with
kindFunctionType (src/evaluator/calls/function.ts:1345-1394). There is no
TypeApp *reduction* function anywhere in src/ — reduction is a side effect of
that re-evaluation.

yo-self's inline FuncVal arm (`_evaluate_funcval_runtime_call`,
evaluator/calls/function.yo:1555) resolves by value-space substitution instead,
which can never APPLY a constructor — and for an HKT binder it substitutes the
FuncVal's *type* into the constructor slot, producing exactly the
`TypeApp(fn(T : Type) -> Type, [i32])` that reaches match.yo and hollows
tests/higher_kinded_types.

The re-evaluation itself is already ported and already runs on the OTHER call
path (the mint, evaluator/calls/helper.yo:2093-2135, via
`_trial_eval_ret_type_expr` + `get_func_return_type_expr`). This adds it here,
gated on the DECLARED return mentioning a kind-annotated binder — the one shape
substitution provably cannot resolve. `kind_function_type` is set in exactly one
place (evaluator/types/function.yo:1649-1657) and only for a generic whose kind
is a comptime-Type-returning function type, so the gate is closed for every
non-HKT call. Read the flag off `ret_type`, not `resolved_ret`: `substitute`
drops `kind_function_type` when it rebuilds an unsubstituted SomeT
(types/substitution.yo:276 — a latent defect in its own right).
"""
import sys

P = "yo-self/evaluator/calls/function.yo"

IMPORT_OLD = ('{ get_func_param_defaults, get_func_param_default_exprs, get_func_param_comptime, '
              'register_func_param_comptime, is_param_quoted, is_macro_fn, macro_return_is_unquote, '
              'evaluate_function_return_type_again, get_func_variadic_param, get_func_param_type_exprs } '
              ':: import("../types/function.yo");')
IMPORT_NEW = ('{ get_func_param_defaults, get_func_param_default_exprs, get_func_param_comptime, '
              'register_func_param_comptime, is_param_quoted, is_macro_fn, macro_return_is_unquote, '
              'evaluate_function_return_type_again, get_func_return_type_expr, get_func_variadic_param, '
              'get_func_param_type_exprs } :: import("../types/function.yo");')

ANCHOR = "  resolved_ret = evaluate_function_return_type_again(resolved_ret, fresh_env, ctx);\n"

BLOCK = """  // HKT: TS resolves a call's return type by RE-EVALUATING the declared
  // return-type EXPRESSION in the callee env (helper.ts:1533-1546 ->
  // types/function.ts:2822-2836), so `-> F(A)` with the type constructor
  // `Option` bound to `F` routes through evaluate_function_call's ordinary
  // comptime-call path and REDUCES to `Option(i32)`. TS builds a
  // TypeApplication only while the callee is still an abstract SomeT with a
  // kind function type (calls/function.ts:1345-1394); there is no TypeApp
  // reduction function in TS at all. yo-self resolves by value-space
  // substitution, which can never APPLY a constructor — and for an HKT binder
  // it substitutes the FuncVal's TYPE into the constructor slot, which is the
  // `TypeApp(fn(T : Type) -> Type, [i32])` that reaches match.yo. Run the same
  // re-evaluation the mint already runs (helper.yo's rte block), gated on the
  // DECLARED return mentioning a kind-annotated binder — the one shape
  // substitution cannot resolve. Read the flag off `ret_type`, not
  // `resolved_ret`: substitute() drops `kind_function_type` when it rebuilds an
  // unsubstituted SomeT (types/substitution.yo).
  (hkt_ret_binder : bool) = false;
  {
    hkt_somes := get_all_some_types(ret_type);
    (hkt_i : usize) = usize(0);
    while((hkt_i < hkt_somes.len()) && !(hkt_ret_binder), {
      match(
        hkt_somes.get(hkt_i),
        .Some(hkt_st) => match(
          hkt_st,
          .SomeT({ kind_function_type : hkt_kft }) => match(
            hkt_kft,
            .Some(_) => {
              hkt_ret_binder = true;
            },
            .None => ()
          ),
          _ => ()
        ),
        .None => ()
      );
      hkt_i = (hkt_i + usize(1));
    });
  };
  if(hkt_ret_binder, {
    match(
      get_func_return_type_expr(func_id_fv.clone()),
      .Some(hkt_expr) => {
        hkt_prev_fnty := ctx.is_evaluating_function_type;
        ctx.is_evaluating_function_type = true;
        hkt_out := ArrayList(TypeValue).new();
        _trial_eval_ret_type_expr(clone_expr_fresh_ids(hkt_expr), fresh_env, ctx, hkt_out);
        ctx.is_evaluating_function_type = hkt_prev_fnty;
        match(
          hkt_out.get(usize(0)),
          .Some(hkt_ty) => if(
            (get_all_some_types(hkt_ty).len() == usize(0)) && !(is_unit_type(hkt_ty)),
            {
              resolved_ret = hkt_ty;
            }
          ),
          .None => ()
        );
      },
      .None => ()
    );
  });
"""

s = open(P).read()
if IMPORT_OLD not in s:
    sys.exit("import anchor missing")
if s.count(ANCHOR) != 1:
    sys.exit(f"return-type anchor count = {s.count(ANCHOR)}, expected 1")
s = s.replace(IMPORT_OLD, IMPORT_NEW, 1)
s = s.replace(ANCHOR, ANCHOR + BLOCK, 1)
open(P, "w").write(s)
print(f"patched {P}")
print("Now run: ./yo-cli fmt", P, "&& ./yo-cli check ./yo-self | tail -1")
