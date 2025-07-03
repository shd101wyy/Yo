import { addVariableToEnv, Environment } from "../../env";
import {
  formatErrorMessage,
  formatErrorMessages,
  MoParserError,
} from "../../error";
import {
  BuiltinKeywords,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { isStructType } from "../../types";
import { VUnit } from "../../unit-value";
import { isModuleValue, isStructValue, Value } from "../../value";
import { EvaluatorContext } from "../context";

/**
 *
 * Import everything from a module
 *
 */
export function evaluateOpen({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const argExpr = expr.args[0];
  if (!argExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "using" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }

  // Evaluate the module
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: evaluatedArgExpr.token,
      errorMessage: `Failed to evaluate the module argument:\n${exprToString(evaluatedArgExpr)}`,
    });
  }

  // Consume the arg expr
  setExprAsConsumed(evaluatedArgExpr, env);

  const argType = evaluatedArgExpr.$.type;
  const argValue = evaluatedArgExpr.$.value;

  if (isModuleValue(argValue)) {
    const moduleValue = argValue;
    const moduleType = moduleValue.type;

    // Import everything from the module
    for (let i = 0; i < moduleType.elements.length; i++) {
      const value = moduleValue.elements[i]!;
      const element = moduleType.elements[i]!;
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: element.label,
          type: element.type,
          isMutable: false,
          isCompileTimeOnly: element.isCompileTimeOnly,
          isImplicit: element.isImplicit,
          value: value,
          token: element.exprs.labelExpr?.token ?? element.exprs.expr.token,
          initializedAtToken:
            element.exprs.labelExpr?.token ?? element.exprs.expr.token,
          consumedAtToken: undefined,
        },
      });
      env = nextEnv;
    }
  } else if (isStructType(argType)) {
    const structValue = argValue;
    const structType = argType;

    // Import everything from the struct
    for (let i = 0; i < structType.elements.length; i++) {
      let value: Value | undefined = undefined;
      if (isStructValue(structValue)) {
        value = structValue.elements[i];
      }
      const element = structType.elements[i]!;
      try {
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: element.label,
            type: element.type,
            isMutable: false,
            isCompileTimeOnly: element.isCompileTimeOnly,
            isImplicit: element.isImplicit,
            value: value,
            token: element.exprs.labelExpr?.token ?? element.exprs.expr.token,
            initializedAtToken:
              element.exprs.labelExpr?.token ?? element.exprs.expr.token,
            consumedAtToken: undefined,
          },
        });
        env = nextEnv;
      } catch (error) {
        throw formatErrorMessages([
          {
            token: argExpr.token,
            errorMessage: `Failed to import struct element "${element.label}"`,
          },
          ...(error instanceof MoParserError
            ? error.tokenAndErrorList
            : [
                {
                  token: argExpr.token,
                  errorMessage: error.toString(),
                },
              ]),
        ]);
      }
    }
  } else {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected module/struct for "${BuiltinKeywords.open}", got:\n${exprToString(argExpr)}`,
    });
  }

  expr.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
