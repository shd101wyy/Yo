import type { Environment } from "../../env";
import type { FnCallExpr } from "../../expr";
import type { EvaluatorContext } from "../context";
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
