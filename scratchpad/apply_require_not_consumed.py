#!/usr/bin/env python3
"""Port TS `requireExprNotConsumed(evaluatedArgExpr, callerEnv)` (src/evaluator/
calls/helper.ts:402) into yo-self's argument-binding loops.

    python3 scratchpad/apply_require_not_consumed.py
    ./yo-cli fmt yo-self/evaluator/calls/helper.yo yo-self/evaluator/calls/function.yo
    ./yo-cli check ./yo-self | tail -1      # expect 295/305

yo-self ALREADY has a faithful `require_expr_not_consumed` (evaluator/utils.yo:389,
exported at :1618) but calls it only from the three assignment sites
(assignment.yo:391/913, initialization_assignment.yo:304 — ports of
assignment.ts:317/884 and initialization-assignment.ts:170). TS's FOURTH caller,
the one on the CALL path, was never ported: yo-self records moves via
`set_expr_as_consumed` and never reads them back, so `own(self)` receivers can be
used after being moved. That is why `comptime_expect_error(arr2 :=
(uninit_arr.assume_init)())` in tests/prelude.test.yo evaluates cleanly.

The write-side flag is NOT the issue: TS passes allowConsumeAgain=true at both of
its consume sites (helper.ts:432/445) exactly as yo-self does, so re-consuming
never throws. The rejection is this READ-side guard, which takes no flag.

Two insertion sites, because yo-self splits TS's single loop in two: the shared
`check_if_function_parameter_matches_argument` (helper.yo) and the inline FuncVal
arg loop in `evaluate_function_call` (function.yo), which bypasses the shared
helper. TS's helper.ts:402 covers both.
"""
import sys

H = "yo-self/evaluator/calls/helper.yo"
F = "yo-self/evaluator/calls/function.yo"


def patch(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        if old not in s:
            sys.exit(f"ANCHOR MISSING in {path}:\n{old[:160]}")
        if s.count(old) != 1:
            sys.exit(f"ANCHOR NOT UNIQUE ({s.count(old)}x) in {path}:\n{old[:160]}")
        s = s.replace(old, new, 1)
    open(path, "w").write(s)
    print(f"patched {path}")


HELPER = [
    (
        '{ set_expr_as_consumed, set_expr_as_needs_to_call_dup } :: import("../utils.yo");',
        '{ set_expr_as_consumed, set_expr_as_needs_to_call_dup, require_expr_not_consumed } :: import("../utils.yo");',
    ),
    (
        """  // Step 4: Append to runtime arg list if not comptime-only.
  if(!(is_ct_only), {
    runtime_arg_exprs_in_order.push(evaled_arg);
  });
  // Step 4b: Move-ownership for an OWNED parameter""",
        """  // Step 4: Append to runtime arg list if not comptime-only.
  if(!(is_ct_only), {
    runtime_arg_exprs_in_order.push(evaled_arg);
  });
  // Step 4a: READ-side move check — port of TS helper.ts:402
  // `requireExprNotConsumed(evaluatedArgExpr, callerEnv)`, which sits exactly
  // here, between the runtime-arg push and the own-consume below. It is a
  // DIFFERENT guard from Step 4b's write: Step 4b passes
  // `allow_consume_again = true` (as TS does at helper.ts:432/445), so
  // re-consuming never throws — using a moved value is rejected HERE. Like TS
  // it is gated on neither `is_ct_only` nor `param_is_owning`: a borrowing or
  // comptime parameter reading a moved variable is an error too.
  require_expr_not_consumed(evaled_arg, caller_env_r, ctx, exn);
  // Step 4b: Move-ownership for an OWNED parameter""",
    ),
]

FUNCTION = [
    (
        '{ attach_temp_variable_to_expr, set_expr_as_consumed, set_expr_as_needs_to_call_dup, parse_raw_int } :: import("../utils.yo");',
        '{ attach_temp_variable_to_expr, set_expr_as_consumed, set_expr_as_needs_to_call_dup, require_expr_not_consumed, parse_raw_int } :: import("../utils.yo");',
    ),
    (
        """            rt_arg_is_ct := match(rt_ct_flags_args.get(ai),.Some(f) => f,.None => false);
            if(!(rt_arg_is_ct), {
              _push_rt := runtime_arg_exprs.push(evaled_arg);
            });""",
        """            rt_arg_is_ct := match(rt_ct_flags_args.get(ai),.Some(f) => f,.None => false);
            if(!(rt_arg_is_ct), {
              _push_rt := runtime_arg_exprs.push(evaled_arg);
            });
            // Read-side move check — same port of TS helper.ts:402 as
            // helper.yo's Step 4a. This inline FuncVal arg loop duplicates
            // helper.ts:396-451 (it bypasses the shared helper), so TS's one
            // call maps onto both yo-self sites.
            require_expr_not_consumed(evaled_arg, env, ctx, exn);""",
    ),
]

patch(H, HELPER)
patch(F, FUNCTION)
print("\nNow run: ./yo-cli fmt", H, F, "&& ./yo-cli check ./yo-self | tail -1")
