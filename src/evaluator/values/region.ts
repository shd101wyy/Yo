import { Environment } from "../../env";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { createRegionValue } from "../../region-value";
import { EvaluatorContext } from "../context";

export function evaluateRegionValue({
  expr,
  env,
  // context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.region);

  const regionValue = createRegionValue(env);

  expr.$ = {
    env,
    value: regionValue,
    type: regionValue.type,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
