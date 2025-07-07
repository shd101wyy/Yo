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
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  setExprAsConsumed,
} from "../../expr";
import {
  areTypesCompatible,
  isMutRefType,
  isRefType,
  typeContainsReference,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * Check if an expression list contains a terminating expression (return).
 * Returns the index of the first terminating expression, or -1 if none found.
 */
function findTerminatingExpressionIndex(expressions: Expr[]): number {
  for (let i = 0; i < expressions.length; i++) {
    const expr = expressions[i]!;
    if (
      (exprIsAtom(expr) && exprIsAtomOf(expr, BuiltinKeywords.return)) ||
      (exprIsFunctionCall(expr) &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.return))
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Checks if an expression represents a unit value (empty tuple)
 */
function isUnitValueExpression(expr: Expr): boolean {
  return (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.tuple, 0)
  );
}

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
  let isReturningFromFunction = false;

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

  let lastExpr = beginExpressions[beginExpressions.length - 1]!;

  // Check if this block contains a terminating expression (return)
  const terminatingIndex = findTerminatingExpressionIndex(beginExpressions);
  const blockWillTerminate = terminatingIndex !== -1;

  // Evaluate expressions
  for (let i = 0; i < beginExpressions.length; i++) {
    const exprToEvaluate = beginExpressions[i]!;

    // If this block will terminate, mark expressions before the terminating expression
    // as being in a terminating branch. This allows consumption of linear values
    // that would otherwise be prohibited in while loops.
    const isInTerminatingBranch =
      context.isInTerminatingBranch ||
      (blockWillTerminate && i < terminatingIndex);

    // Check if it's the "return" keyword
    if (
      (exprIsAtom(exprToEvaluate) &&
        exprIsAtomOf(exprToEvaluate, BuiltinKeywords.return)) ||
      (exprIsFunctionCall(exprToEvaluate) &&
        exprIsFunctionCallOf(exprToEvaluate, BuiltinKeywords.return))
    ) {
      // Expect the exprToEvaluate to be the last expression
      if (
        // not the last expression.
        i !== beginExpressions.length - 1 &&
        // not the second last expression, and the last one is not unit value.
        !(
          i === beginExpressions.length - 2 &&
          // the last expression is a unit value
          isUnitValueExpression(beginExpressions[beginExpressions.length - 1]!)
        )
      ) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "return" keyword can only be used as the last expression.`,
        });
      }
      if (exprIsFunctionCall(exprToEvaluate)) {
        expectExprToBeFunctionCallOf(exprToEvaluate, BuiltinKeywords.return, 1);
      }

      if (!context.isEvaluatingFunctionBody) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "return" keyword can only be used inside a function body.`,
        });
      }

      if (exprIsAtom(exprToEvaluate)) {
        // return unit
        exprToEvaluate.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          isMutable: false,
          pathCollection: [],
        };
      } else if (exprToEvaluate.args.length === 1) {
        // Return the first argument
        // Evaluate the return expression
        const returnArg = exprToEvaluate.args[0]!;
        const evaluatedReturnExpr = context.evaluateExpression({
          expr: returnArg,
          env,
          context: {
            ...context,
            isInTerminatingBranch: true, // Mark that we're in a terminating branch
            expectedType: {
              type: context.isEvaluatingFunctionBody.type,
              env: env,
            },
          },
        });
        if (!evaluatedReturnExpr.$) {
          throw formatErrorMessage({
            token: returnArg.token,
            errorMessage: `Return expression is not evaluated correctly:\n${exprToString(returnArg)}`,
          });
        }
        env = evaluatedReturnExpr.$.env;
        isReturningFromFunction = true;

        exprToEvaluate.$ = {
          env,
          type: evaluatedReturnExpr.$.type,
          value: evaluatedReturnExpr.$.value,
          isMutable: false,
          pathCollection: evaluatedReturnExpr.$.pathCollection,
          variableName: evaluatedReturnExpr.$.variableName,
          controlFlow: "return",
        };
        lastExpr = exprToEvaluate;
        break;
      }
    }
    // Check if it's the "break" keyword
    else if (
      exprIsAtom(exprToEvaluate) &&
      exprIsAtomOf(exprToEvaluate, BuiltinKeywords.break)
    ) {
      // Expect the exprToEvaluate to be the last expression or followed only by unit values
      if (
        // not the last expression.
        i !== beginExpressions.length - 1 &&
        // not the second last expression, and the last one is not unit value.
        !(
          i === beginExpressions.length - 2 &&
          // the last expression is a unit value
          isUnitValueExpression(beginExpressions[beginExpressions.length - 1]!)
        )
      ) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "break" keyword can only be used as the last expression.`,
        });
      }

      if (!context.isInBreakableLoop) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "break" keyword can only be used inside a loop.`,
        });
      }

      // break returns unit
      exprToEvaluate.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
        controlFlow: "break",
      };
      lastExpr = exprToEvaluate;
      break;
    }
    // Check if it's the "continue" keyword
    else if (
      exprIsAtom(exprToEvaluate) &&
      exprIsAtomOf(exprToEvaluate, BuiltinKeywords.continue)
    ) {
      // Expect the exprToEvaluate to be the last expression or followed only by unit values
      if (
        // not the last expression.
        i !== beginExpressions.length - 1 &&
        // not the second last expression, and the last one is not unit value.
        !(
          i === beginExpressions.length - 2 &&
          // the last expression is a unit value
          isUnitValueExpression(beginExpressions[beginExpressions.length - 1]!)
        )
      ) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "continue" keyword can only be used as the last expression.`,
        });
      }

      if (!context.isInBreakableLoop) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "continue" keyword can only be used inside a loop.`,
        });
      }

      // continue returns unit
      exprToEvaluate.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
        controlFlow: "continue",
      };
      lastExpr = exprToEvaluate;
      break;
    } else {
      const evaluatedExpr = context.evaluateExpression({
        expr: exprToEvaluate,
        env,
        context: {
          ...context,
          isInTerminatingBranch, // Use the computed isInTerminatingBranch value
          expectedType:
            i === beginExpressions.length - 1 ? expectedType : undefined,
        },
      });
      if (evaluatedExpr.$?.env) {
        env = evaluatedExpr.$?.env;
      }

      if (evaluatedExpr.$?.controlFlow) {
        isReturningFromFunction = true;
        lastExpr = evaluatedExpr;
        break;
      }
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

  // Check if return type is compatible
  if (isReturningFromFunction) {
    if (
      !areTypesCompatible(
        {
          type: context.isEvaluatingFunctionBody!.type.return.type,
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
        errorMessage: `Return type mismatch. Expected type "${typeToString(
          context.isEvaluatingFunctionBody!.type.return.type
        )}", but got "${typeToString(returnType)}".`,
      });
    }
  }
  /*
  // NOTE: Checking this below sometimes gives error. So I disable it for now.
  // not returning from function
  else if (context.expectedType) {
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
    expr.$.controlFlow = isReturningFromFunction ? "return" : undefined;
  } else {
    expr.$ = {
      env,
      type: lastExpr.$.type,
      value: lastExpr.$.value,
      isMutable: false,
      pathCollection: [],
      controlFlow: isReturningFromFunction ? "return" : undefined,
    };
    attachTempVariableToExpr(expr);
  }
  return expr;
}
