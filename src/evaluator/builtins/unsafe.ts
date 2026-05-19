import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate the `unsafe(expr)` builtin.
 *
 * `unsafe(expr)` is a compile-time marker that permits pointer deref
 * (`p.*`), pointer arithmetic (`&+`, `&-`, `&/`), and `consume(p.* = v)`
 * inside `expr`. Outside `unsafe(...)`, those operations are compile
 * errors.
 *
 * Semantically transparent: the value, type, and environment of
 * `unsafe(expr)` are identical to `expr` itself. Codegen lowers
 * `unsafe(expr)` to its inner expression — no runtime cost.
 *
 * See plans/MEMORY_SAFETY.md for the full design.
 */
export function evaluateUnsafe({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.unsafe, 1);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      unsafeContext: true,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument of 'unsafe(...)'.`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // unsafe(...) is transparent — propagate the inner value/type unchanged.
  expr.$ = {
    env,
    type: evaluatedArgExpr.$.type,
    value: evaluatedArgExpr.$.value,
    pathCollection: evaluatedArgExpr.$.pathCollection ?? [],
    sourceVariable: evaluatedArgExpr.$.sourceVariable,
    originType: evaluatedArgExpr.$.originType,
    isAccessingProperty: evaluatedArgExpr.$.isAccessingProperty,
  };
  return expr;
}
