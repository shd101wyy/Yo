import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage, formatErrorMessages, YoError } from "../../error";
import {
  BuiltinKeywords,
  exprToString,
  FuncCallExpr,
  RuntimeDestructuring,
} from "../../expr";
import { isStructType } from "../../types";
import { VUnit } from "../../unit-value";
import { isModuleValue, isStructValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

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
  const evaluatedArgExpr = evaluateExpression({
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

  const argType = evaluatedArgExpr.$.type;
  const argValue = evaluatedArgExpr.$.value;

  let runtimeDestructurings: RuntimeDestructuring[] | undefined = undefined;

  if (isModuleValue(argValue)) {
    const moduleValue = argValue;
    const moduleType = moduleValue.type;

    // Import everything from the module
    for (let i = 0; i < moduleType.fields.length; i++) {
      const value = moduleValue.fields[i]!;
      const field = moduleType.fields[i]!;
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: field.label,
          type: field.type,
          isCompileTimeOnly: field.isCompileTimeOnly,
          value: value,
          token: field.exprs.labelExpr?.token ?? field.exprs.expr.token,
          initializedAtToken:
            field.exprs.labelExpr?.token ?? field.exprs.expr.token,
          consumedAtToken: undefined,
          isReassignable: false, // Destructured variables are not reassignable
        },
      });
      env = nextEnv;
    }
  } else if (isStructType(argType)) {
    const structValue = argValue;
    const structType = argType;
    runtimeDestructurings = [];

    // Import everything from the struct
    for (let i = 0; i < structType.fields.length; i++) {
      let value: Value | undefined = undefined;
      if (isStructValue(structValue)) {
        value = structValue.fields[i];
      }
      const field = structType.fields[i]!;
      try {
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: field.label,
            type: field.type,
            isCompileTimeOnly: field.isCompileTimeOnly,
            value: value,
            token: field.exprs.labelExpr?.token ?? field.exprs.expr.token,
            initializedAtToken:
              field.exprs.labelExpr?.token ?? field.exprs.expr.token,
            consumedAtToken: undefined,
            isReassignable: false, // Destructured variables are not reassignable
          },
        });
        env = nextEnv;

        runtimeDestructurings.push({
          label: field.label,
          variableName: field.label,
          type: field.type,
        });
      } catch (error) {
        throw formatErrorMessages([
          {
            token: argExpr.token,
            errorMessage: `Failed to import struct field "${field.label}"`,
          },
          ...(error instanceof YoError
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
    pathCollection: [],
    runtimeDestructurings,
  };

  return expr;
}
