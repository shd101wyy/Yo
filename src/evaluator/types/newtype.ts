import type { Environment } from "../../env";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { EvaluatorContext } from "../context";
import { evaluateStructType } from "./struct";

/**
 * Evaluate newtype types:
 *
 * - newtype(...) - Newtype struct (a struct with a single element)
 */
export function evaluateNewtypeType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.newtype);

  // Object is essentially a struct with reference semantics enabled
  // The struct evaluator now handles both 'struct' and 'object' keywords
  return evaluateStructType({
    expr,
    env,
    context,
    // isNewtype is automatically set to true for 'newtype' in evaluateStructType
  });
}
