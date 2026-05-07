import {
  addVariableToEnv,
  getVariablesFromEnv,
  type Environment,
} from "../../env";
import { formatErrorMessage, formatErrorMessages, YoError } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCallOf,
  exprToString,
  type Expr,
  type FnCallExpr,
  type RuntimeDestructuring,
} from "../../expr";
import { isModuleType, isStructType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { isStructValue, type Value } from "../../value";
import type { EvaluatorContext } from "../context";
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const argExpr = expr.args[0];
  if (!argExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "using" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }

  // Disallow open on implicit variables or property access of implicit variables.
  {
    let rootExpr: Expr = argExpr;
    while (
      exprIsFunctionCallOf(rootExpr, ".") &&
      (rootExpr as FnCallExpr).args.length >= 1
    ) {
      rootExpr = (rootExpr as FnCallExpr).args[0]!;
    }
    if (exprIsAtom(rootExpr)) {
      const rootVars = getVariablesFromEnv(env, rootExpr.token.value);
      const rootVar = rootVars[rootVars.length - 1];
      if (rootVar?.isImplicit) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Cannot use "open" on implicit variable "${rootVar.name}". Implicit variables must be passed via using() parameters.`,
        });
      }
    }
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

  if (isStructType(argType) || isModuleType(argType)) {
    const structValue = isStructValue(argValue) ? argValue : undefined;
    const structType = argType;
    runtimeDestructurings = [];

    // Import everything from the struct
    for (let i = 0; i < structType.fields.length; i++) {
      let value: Value | undefined = undefined;
      if (structValue) {
        value = structValue.fields[i];
      }
      const field = structType.fields[i]!;
      try {
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: field.label,
            type: field.type,
            isCompileTimeOnly: Boolean(value),
            value: value ? [value] : undefined,
            token: field.exprs.labelExpr?.token ?? field.exprs.expr.token,
            initializedAtToken:
              field.exprs.labelExpr?.token ?? field.exprs.expr.token,
            consumedAtToken: undefined,
            isReassignable: false, // Destructured variables are not reassignable
            isOwningTheRcValue: false,
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
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                },
              ]),
        ]);
      }
    }
  } else {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected struct for "${BuiltinKeywords.open}", got:\n${exprToString(argExpr)}`,
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
