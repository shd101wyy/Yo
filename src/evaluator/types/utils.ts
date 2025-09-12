import { Environment } from "../../env";
import { Expr, exprIsFunctionCall, exprToString } from "../../expr";
import { generateExprFromCode } from "../../parser";
import { EnumType, ModuleElement, StructType } from "../../types";
import { isFunctionValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Helper function to parse and evaluate a Yo code string in the context of a SelfType
 */
function parseAndEvaluateExprCode(
  code: string,
  SelfType: StructType | EnumType,
  env: Environment,
  context: EvaluatorContext
): { expr: Expr; env: Environment } {
  const expr = generateExprFromCode(code);

  // Evaluate the expression with the struct as the SelfType
  const evaluatedExpr = context.evaluateExpression({
    expr,
    env,
    context: {
      ...context,
      SelfType: SelfType,
    },
  });

  if (!evaluatedExpr.$) {
    throw new Error(
      `Failed to evaluate auto-generated expression: ${exprToString(expr)}`
    );
  }

  return { expr: evaluatedExpr, env: evaluatedExpr.$.env };
}

export function addFunctionToSelfTypeModule({
  label,
  functionCode,
  SelfType,
  env,
  context,
}: {
  /**
   * eg, ___dup, ___drop, ___dispose
   */
  label: string;
  /**
   * Function code string, like ((fn()-> unit) { return (); })
   */
  functionCode: string;
  SelfType: StructType | EnumType;
  env: Environment;
  context: EvaluatorContext;
}): Environment {
  const { expr: dropFunctionExpr, env: nextEnv } = parseAndEvaluateExprCode(
    functionCode,
    SelfType,
    env,
    context
  );
  if (exprIsFunctionCall(dropFunctionExpr)) {
    const functionExpr = dropFunctionExpr;
    if (
      functionExpr.$ &&
      functionExpr.$.value &&
      isFunctionValue(functionExpr.$.value)
    ) {
      // The code below is necessary for the C code generator to make the ___drop like function to have a more descriptive name.
      functionExpr.$.value.funcId += label;

      // Add the drop function to the struct's module elements
      const dropModuleElement: ModuleElement = {
        label: label,
        type: functionExpr.$.type,
        assignedValue: functionExpr.$.value,
        isCompileTimeOnly: true,
        isImplicit: false,
        exprs: {
          expr: dropFunctionExpr,
          labelExpr: dropFunctionExpr.args[0],
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: functionExpr,
        },
      };
      SelfType.module.elements.push(dropModuleElement);
    }
  }

  return nextEnv;
}
