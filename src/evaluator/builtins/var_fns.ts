import { Environment, getVariableInfo, getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoVarPrintInfo({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_var_print_info, 1);

  const varExpr = expr.args[0]!;
  const varValue = evaluateExpression({
    expr: varExpr,
    env,
    context,
  });
  if (varValue.$) {
    env = varValue.$.env;
  }

  const variableName = varValue.$?.variableName;
  if (variableName) {
    const variables = getVariablesFromEnv(env, variableName);
    if (variables.length > 0) {
      const variable = variables.at(-1)!;
      console.log(getVariableInfo(variable));
    }
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
