import {
  getVariableInfo,
  getVariablesFromEnv,
  type Environment,
} from "../../env";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { createBooleanType } from "../../types/creators";
import { VUnit } from "../../unit-value";
import { createBooleanValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoVarPrintInfo({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
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

export function evaluateYoVarIsOwningTheRcValue({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_var_is_owning_the_rc_value,
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
  let isOwningTheRcValue = false;
  if (variableName) {
    const variables = getVariablesFromEnv(env, variableName);
    if (variables.length > 0) {
      const variable = variables.at(-1)!;
      isOwningTheRcValue = variable.isOwningTheRcValue;
    }
  }

  expr.$ = {
    env,
    type: createBooleanType(),
    value: createBooleanValue(isOwningTheRcValue),
    pathCollection: [],
  };
  return expr;
}

export function evaluateYoVarHasOtherAliases({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
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
      const isOwningTheSameRcValueAs = variable.isOwningTheSameRcValueAs;
      if (isOwningTheSameRcValueAs) {
        hasOtherAliases = true;
      } else {
        const targetVariableId = variable.id;
        // Check if there exists any variable that has isOwningTheSameRcValueAs equal to targetVariableId
        for (let i = env.frames.length - 1; i >= 0; i--) {
          const frame = env.frames[i]!;
          for (let j = 0; j < frame.variables.length; j++) {
            const frameVariable = frame.variables[j]!;
            if (
              frameVariable.isOwningTheSameRcValueAs &&
              frameVariable.isOwningTheSameRcValueAs.id === targetVariableId
            ) {
              hasOtherAliases = true;
              break;
            }
          }
        }
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
