import {
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
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
  let hasBeginKeyword = false;
  if (
    !exprIsFunctionCall(expr) ||
    !exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    beginExpressions = [expr];
  } else {
    hasBeginKeyword = true;
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

  // Save the last expr
  const lastExpr = beginExpressions[beginExpressions.length - 1]!;

  // Evaluate expressions
  for (let i = 0; i < beginExpressions.length; i++) {
    const exprToEvaluate = beginExpressions[i]!;
    const evaluatedExpr = context.evaluateExpression({
      expr: exprToEvaluate,
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

  /*
  // NOTE: Checking this below sometimes gives error. So I disable it for now.
  // not returning from function
  if (context.expectedType) {
    // Check if the last expression type is compatible with the expected type
    if (
      !areTypesCompatible(
        {
          type: context.expectedType.type,
          env: env,
        },
        {
          type: returnType,
          env: env,
        }
      )
    ) {
      throw formatErrorMessage({
        token: lastExpr.token,
        errorMessage: `Last expression type mismatch. Expected type "${typeToString(
          context.expectedType.type
        )}", but got "${typeToString(returnType)}".`,
      });
    }
  }
  */

  // Set the last expression as the return value
  // and mark it as consumed.
  env = setExprAsConsumed(lastExpr, env, context);

  // Pop the environment frame
  env = popEnvFrame(env);

  if (!hasBeginKeyword) {
    // If the begin keyword is not used, we need to return the last expression
    expr = lastExpr;
    if (!expr.$) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Last expression in "begin" is not evaluated correctly:\n${exprToString(expr)}`,
      });
    }
    expr.$.env = env;
  } else {
    expr.$ = {
      env,
      type: lastExpr.$.type,
      value: lastExpr.$.value,
      isMutable: false,
      pathCollection: [],
    };
    attachTempVariableToExpr(expr);
  }
  return expr;
}
