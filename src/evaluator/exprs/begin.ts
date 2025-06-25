import {
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  setExprAsConsumed,
} from "../../expr";
import {
  isMutRefType,
  isRefType,
  typeContainsReference,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

export function evaluateBeginExpression({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  let beginExpressions: Expr[] = [];
  if (
    !exprIsFunctionCall(expr) ||
    !exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    beginExpressions = [expr];
  } else {
    beginExpressions = expr.args;
  }
  const expectedType = context.expectedType;

  // Empty begin
  // return unit
  if (beginExpressions.length === 0) {
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  // Push a new environment frame
  env = pushEnvFrame(env);

  // Evaluate expressions
  for (let i = 0; i < beginExpressions.length; i++) {
    const evaluatedExpr = context.evaluateExpression({
      expr: beginExpressions[i]!,
      env,
      context: {
        ...context,
        expectedType:
          i === beginExpressions.length - 1 ? expectedType : undefined,
      },
    });
    if (evaluatedExpr.$?.env) {
      env = evaluatedExpr.$?.env;
    }
  }
  const lastExpr = beginExpressions[beginExpressions.length - 1]!;
  if (!lastExpr.$) {
    throw formatErrorMessage({
      token: lastExpr.token,
      errorMessage: `Last expression in "begin" is not evaluated correctly:\n${exprToString(lastExpr)}`,
    });
  }

  // Prevent return reference to the local variable.
  const returnType = lastExpr.$.type;
  if (typeContainsReference(returnType)) {
    // Check the path
    const pathCollection = lastExpr.$.pathCollection;
    for (let i = 0; i < pathCollection.length; i++) {
      const path = pathCollection[i]!;
      const variableName = path[0]!;
      if (variableName) {
        const variables = getVariablesFromEnv(env, variableName);
        if (!variables.length) {
          throw formatErrorMessage({
            token: lastExpr.token,
            errorMessage: `Invalid path detected. It could be a bug of the compiler.`,
          });
        }
        const variable = variables[variables.length - 1]!;
        if (
          // Check if the variable name is a local variable
          variable.frameLevel ===
          env.frames.length - 1
        ) {
          // If the variable is a local variable, we cannot return a reference to it
          throw formatErrorMessage({
            token: lastExpr.token,
            errorMessage: `Cannot return value containing reference to the local variable "${variableName}".`,
          });
        } else if (
          // Otherwise, expect it to be reference type.
          !(isMutRefType(variable.type) || isRefType(variable.type))
        ) {
          // If the variable is not a reference type, we cannot return a reference to it
          throw formatErrorMessage({
            token: lastExpr.token,
            errorMessage: `Cannot return value containing reference to the variable "${variableName}" of type "${typeToString(
              variable.type
            )}". Expected reference type.`,
          });
        }
      }
    }
  }

  // Set the last expression as the return value
  // and mark it as consumed.
  env = setExprAsConsumed(lastExpr, env);

  // Pop the environment frame
  env = popEnvFrame(env);

  expr.$ = {
    env,
    type: lastExpr.$.type,
    value: lastExpr.$.value,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
