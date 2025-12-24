import { Environment, getVariableInfo, getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { createBooleanType } from "../../types";
import { VUnit } from "../../unit-value";
import { createBooleanValue } from "../../value";
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

export function evaluateYoVarIsOwningTheGcValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_var_is_owning_the_gc_value,
    1
  );

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
  let isOwningTheGcValue = false;
  if (variableName) {
    const variables = getVariablesFromEnv(env, variableName);
    if (variables.length > 0) {
      const variable = variables.at(-1)!;
      isOwningTheGcValue = variable.isOwningTheGcValue;
    }
  }

  expr.$ = {
    env,
    type: createBooleanType(),
    value: createBooleanValue(isOwningTheGcValue),
    pathCollection: [],
  };
  return expr;
}

export function evaluateYoVarHasOtherAliases({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_var_has_other_aliases,
    1
  );

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
  let hasOtherAliases = false;
  if (variableName) {
    const variables = getVariablesFromEnv(env, variableName);
    if (variables.length > 0) {
      const variable = variables.at(-1)!;
      const isOwningTheSameGcValueAs = variable.isOwningTheSameGcValueAs;
      if (isOwningTheSameGcValueAs) {
        hasOtherAliases = true;
      } else {
        const targetVariableId = variable.id;
        // Check if there exists any variable that has isOwningTheSameGcValueAs equal to targetVariableId
        hasOtherAliases = variables.some(
          (v) =>
            v.isOwningTheSameGcValueAs &&
            v.isOwningTheSameGcValueAs.id === targetVariableId
        );
      }
    }
  }

  expr.$ = {
    env,
    type: createBooleanType(),
    value: createBooleanValue(hasOtherAliases),
    pathCollection: [],
  };
  return expr;
}
