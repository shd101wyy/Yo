import { Environment } from "../../env";
import { FnCallExpr } from "../../expr";
import { EvaluatorContext } from "../context";
import { evaluateFunctionType } from "./function";

export function evaluateClosureType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // For fn(x : i32) => i32 syntax, delegate directly to evaluateFunctionType
  // which should handle the => operator and set isClosure = true
  return evaluateFunctionType({
    expr,
    env,
    context,
  });
}
