import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { EvaluatorContext } from "../context";
import { evaluateStructType } from "./struct";

/**
 * Evaluate object types:
 *
 * - object(...) - Reference semantics struct (equivalent to object)
 */
export function evaluateObjectType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.object)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "object", got:\n${exprToString(expr)}`,
    });
  }

  // Object is essentially a struct with reference semantics enabled
  // The struct evaluator now handles both 'struct' and 'object' keywords
  return evaluateStructType({
    expr,
    env,
    context,
    // isReferenceSemantics is automatically set to true for 'object' in evaluateStructType
  });
}
