import { Environment } from "../../env";
import { FuncCallExpr } from "../../expr";
import { EvaluatorContext } from "../context";
import { evaluateFunctionType } from "./function";

export function evaluateClosureType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // For fn(x : i32) => i32 syntax, delegate directly to evaluateFunctionType
  // which should handle the => operator and set isClosure = true
  return evaluateFunctionType({
    expr,
    env,
    context,
  });
}
