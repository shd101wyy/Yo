#!/usr/bin/env python3
"""Defect B (tests/fn.test.yo blk12): a LAMBDA argument to a generic callee's
plain `fn(...)` parameter is checked against the DECLARED, still-generic
parameter type, so the lambda keeps a hard-generic function type of its own and
`should_skip_function_codegen` drops its DEFINITION while the call site still
emits its registry name -> "use of undeclared identifier 'fn_yo_id_NNNN'".

TS re-derives each parameter type in the callee env immediately BEFORE
evaluating that argument (src/evaluator/calls/helper.ts:304-317 ->
evaluateFunctionParameterTypeAgain, src/evaluator/types/function.ts:2687-2706)
and carries calleeEnv forward across the argument loop (helper.ts:1423-1446), so
`T := i32` synthesized from argument 0 is visible when argument 1 (the lambda)
is reached. yo-self binds foralls only AFTER the whole loop
(`_funcval_bind_foralls`), so nothing was bound yet.

Decisive evidence that this is the mechanism and not a yo-self quirk: TS fails
with the SAME error when the callback is declared BEFORE x
(scratchpad/w2/c4.yo) -- TS's only protection is ordering.

This routes through yo-self's OWN exported port of that TS function,
`evaluate_function_parameter_type_again` (evaluator/types/function.yo:4522),
rather than hand-rolling a second expression re-evaluation.

    python3 scratchpad/apply_patchB_blk12.py
    ./yo-cli fmt yo-self/evaluator/calls/function.yo
    ./yo-cli check ./yo-self | tail -1      # expect 295/305
"""
import sys

P = "yo-self/evaluator/calls/function.yo"
s = open(P).read()

IMP_ANCHOR = ('{ get_func_param_defaults, get_func_param_default_exprs, get_func_param_comptime, '
              'register_func_param_comptime, is_param_quoted, is_macro_fn, macro_return_is_unquote, '
              'evaluate_function_return_type_again, get_func_return_type_expr, get_func_variadic_param, '
              'get_func_param_type_exprs } :: import("../types/function.yo");')
if s.count(IMP_ANCHOR) != 1:
    sys.exit(f"import anchor count={s.count(IMP_ANCHOR)}")
s = s.replace(IMP_ANCHOR, IMP_ANCHOR.replace(
    "get_func_param_type_exprs }", "get_func_param_type_exprs, evaluate_function_parameter_type_again }"), 1)

EXPR_ANCHOR = "  BF_DOT\n} :: import(\"../../expr.yo\");"
if s.count(EXPR_ANCHOR) != 1:
    sys.exit(f"expr import anchor count={s.count(EXPR_ANCHOR)}")
s = s.replace(EXPR_ANCHOR, "  BF_DOT,\n  is_function_boundary_arrow\n} :: import(\"../../expr.yo\");", 1)

ANCHOR = "            // Evaluate the arg with expectedType = the DECLARED PARAM TYPE\n"
if s.count(ANCHOR) != 1:
    sys.exit(f"insert anchor count={s.count(ANCHOR)}")

BLOCK = """            // TS re-derives THIS parameter's type in the callee env immediately
            // BEFORE evaluating the argument (helper.ts:304-317 ->
            // evaluateFunctionParameterTypeAgain, types/function.ts:2687-2706),
            // and its argument loop carries `calleeEnv` forward
            // (helper.ts:1423-1446) — so the bindings synthesized from the
            // EARLIER arguments are already visible. For
            // `generic_fn(1, (x) -> (x + 1))` against
            // `fn(generic(T), x : T, callback : (fn(v : T) -> T)) -> T`,
            // argument 0 binds `T := i32`, so `callback`'s expected type is the
            // CONCRETE `fn(v : i32) -> i32`, and newFunctionType spreads it onto
            // the lambda (anonymous-function.ts:597-638).
            //
            // yo-self binds foralls only AFTER the whole argument loop
            // (`_funcval_bind_foralls`), so the lambda was checked against the
            // DECLARED `fn(v : T) -> T`, kept a hard-generic type of its own,
            // and `should_skip_function_codegen`
            // (codegen/functions/declarations.yo:462) dropped its DEFINITION
            // while the call site still emitted its registry name — "use of
            // undeclared identifier 'fn_yo_id_NNNN'". That this is the mechanism
            // and not a yo-self quirk: TS fails with the SAME error when
            // `callback` is declared BEFORE `x` (scratchpad/w2/c4.yo), because
            // then `T` is unbound there for TS too. Its only protection is
            // argument order.
            //
            // Deliberately narrow (a staging gate, NOT a TS-faithful condition —
            // TS re-derives every parameter type unconditionally): only a
            // function-boundary-arrow argument whose declared parameter type is
            // a plain `.Func` carrying an unresolved binder, and only when the
            // re-derivation lands a FULLY CONCRETE function type. A SomeT /
            // `Impl(Fn)` parameter coerces through closure_type.yo instead, and
            // widening this regressed codegen-bootstrap/closure_where_clause_param
            // twice before.
            if(vs_override.is_none() && (ai < n_p), {
              lp_decl := match(fv_param_types.get(ai),.Some(t) => t,.None => t_unit());
              lp_go := (
                (is_function_boundary_arrow(arg_expr_eff) && is_function_type(lp_decl))
                && (get_all_some_types(lp_decl).len() > usize(0))
              );
              if(lp_go, {
                _lpf := env.push_frame(false);
                lp_se := Environment.new(env.module_path);
                (lp_j : usize) = usize(0);
                while(lp_j < ai, {
                  lp_dpt := match(fv_param_types.get(lp_j),.Some(t) => t,.None => t_unit());
                  match(
                    evaled_arg_infos.get(lp_j),
                    .Some(lp_info) => _funcval_try_synthesize_param(lp_dpt, lp_se, lp_info.ty, env),
                    .None => ()
                  );
                  lp_j = (lp_j + usize(1));
                });
                (lp_k : usize) = usize(0);
                while(lp_k < forall_names.len(), {
                  lp_fn := match(forall_names.get(lp_k),.Some(nm) => nm,.None => String.new());
                  lp_vars := get_variables_from_env(lp_se, lp_fn.clone());
                  if(lp_vars.len() > usize(0), {
                    match(
                      lp_vars.get(lp_vars.len() - usize(1)),
                      .Some(lp_v) => match(
                        lp_v.value.get(usize(0)),
                        .Some(lp_val) => match(
                          lp_val,
                          .TypeVal(lp_tb) => if(!(is_some_type(lp_tb)), {
                            add_variable_to_env(
                              env,
                              lp_fn.clone(),
                              TypeValue.TypeUni(usize(0)),
                              Option(EvalValue).Some(EvalValue.TypeVal(lp_tb.clone())),
                              true,
                              false,
                              false,
                              false,
                              synthetic_token(lp_fn.clone(), env.module_path)
                            );
                            ()
                          }),
                          _ => ()
                        ),
                        .None => ()
                      ),
                      .None => ()
                    );
                  });
                  lp_k = (lp_k + usize(1));
                });
                lp_res := evaluate_function_parameter_type_again(lp_decl, env, ctx);
                env.pop_frame();
                if(is_function_type(lp_res) && (get_all_some_types(lp_res).len() == usize(0)), {
                  vs_override = Option(TypeValue).Some(lp_res);
                });
              });
            });
"""
s = s.replace(ANCHOR, BLOCK + ANCHOR, 1)
open(P, "w").write(s)
print("patched", P)
