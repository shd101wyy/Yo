import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
  Variable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  cloneExpr,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
  replaceFuncCallExprWithFuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { areTypesCompatible, typeToString } from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { synthesizeTypes } from "../types/synthesizer";

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
  variablesToAdd = [],
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
  variablesToAdd: Omit<Variable, "frameLevel" | "id">[];
}): Expr {
  if (
    !exprIsFunctionCall(expr) ||
    !exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    // NOTE: We cannot use generateExprFromCode here
    // Re-construct it as begin expression
    // const beginExpr = generateExprFromCode(
    //   `begin(${exprToString(expr)})`
    // ) as FuncCallExpr;
    const beginExpr: FuncCallExpr = {
      tag: ExprTag.FuncCall,
      func: {
        tag: ExprTag.Atom,
        token: {
          ...expr.token,
          value: BuiltinKeywords.begin[0]!,
        },
      },
      args: [cloneExpr(expr)],
      token: {
        ...expr.token,
        value: BuiltinKeywords.begin[0]!,
      },
    };

    // Replace everything from beginExpr to expr
    // expr = beginExpr;
    replaceFuncCallExprWithFuncCallExpr(expr as FuncCallExpr, beginExpr);
    expr = expr as FuncCallExpr;
  }
  const beginExpressions: Expr[] = expr.args;
  const expectedType = context.expectedType;

  // Empty begin
  // return unit
  if (beginExpressions.length === 0) {
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  }

  // Push a new environment frame
  env = pushEnvFrame(env);

  // Add variablesToAdd to the environment
  for (let i = 0; i < variablesToAdd.length; i++) {
    const variable = variablesToAdd[i]!;
    const { env: nextEnv } = addVariableToEnv({ env, variable });
    env = nextEnv;
  }

  let lastExpr = beginExpressions[beginExpressions.length - 1]!;

  // Evaluate expressions
  for (let i = 0; i < beginExpressions.length; i++) {
    const exprToEvaluate = beginExpressions[i]!;

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

      if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "return" keyword can only be used inside a function body or async block.`,
        });
      }

      if (exprIsAtom(exprToEvaluate)) {
        // return;
        // return unit
        exprToEvaluate.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          pathCollection: [],
          controlFlow: "return",
        };
        lastExpr = exprToEvaluate;
        break;
      } else {
        // return val;

        // Return the first argument
        // Evaluate the return expression
        expectExprToBeFunctionCallOf(exprToEvaluate, BuiltinKeywords.return, 1);
        const returnArg = exprToEvaluate.args[0]!;

        const evaluatedReturnArgExpr = evaluateExpression({
          expr: returnArg,
          env,
          context: {
            ...context,
            expectedType:
              context.isEvaluatingFunctionBodyOrAsyncBlock.kind ===
              "function-body"
                ? {
                    type: context.isEvaluatingFunctionBodyOrAsyncBlock.type
                      .return.type,
                    env: env,
                  }
                : context.expectedType,
          },
        });
        if (!evaluatedReturnArgExpr.$) {
          throw formatErrorMessage({
            token: returnArg.token,
            errorMessage: `Return expression is not evaluated correctly:\n${exprToString(returnArg)}`,
          });
        }

        // Attach temp variable to return value expression if it's non-unit
        // This is needed for C codegen to store the value before running deferred drops
        attachTempVariableToExpr(evaluatedReturnArgExpr);

        // NOTE: Update `env` after calling attachTempVariableToExpr
        env = evaluatedReturnArgExpr.$.env;

        exprToEvaluate.$ = {
          env,
          type: evaluatedReturnArgExpr.$.type,
          value: evaluatedReturnArgExpr.$.value,
          pathCollection: evaluatedReturnArgExpr.$.pathCollection,
          variableName: evaluatedReturnArgExpr.$.variableName,
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

      if (!context.isEvaluatingLoopBody) {
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

      if (!context.isEvaluatingLoopBody) {
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
        pathCollection: [],
        controlFlow: "continue",
      };
      lastExpr = exprToEvaluate;
      break;
    }
    // Normal expression evaluation
    else {
      const evaluatedExpr = evaluateExpression({
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

      if (evaluatedExpr.$?.controlFlow) {
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

  const returnType = lastExpr.$.type;

  // Check if return type is compatible
  if (lastExpr.$.controlFlow === "return") {
    if (
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
    ) {
      // First try to synthesize the types to handle cases like [i32; n] vs [i32; 5]
      try {
        synthesizeTypes(
          {
            type: context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type,
            env: env,
          },
          {
            type: returnType,
            env: env,
          }
        );
      } catch (synthesisError) {
        // If synthesis fails, check basic compatibility as fallback
        if (
          !areTypesCompatible(
            {
              type: context.isEvaluatingFunctionBodyOrAsyncBlock.type.return
                .type,
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
              context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
            )}", but got "${typeToString(returnType)}".`,
          });
        }
      }
    } else if (
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "async-block" &&
      context.expectedType
    ) {
      // First try to synthesize the types to handle cases like [i32; n] vs [i32; 5]
      try {
        synthesizeTypes(
          {
            type: context.expectedType.type,
            env: context.expectedType.env,
          },
          {
            type: returnType,
            env: env,
          }
        );
      } catch (synthesisError) {
        // If synthesis fails, check basic compatibility as fallback
        if (
          !areTypesCompatible(
            {
              type: context.expectedType.type,
              env: context.expectedType.env,
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
              context.expectedType.type
            )}", but got "${typeToString(returnType)}".`,
          });
        }
      }
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
  env = setExprAsConsumed(lastExpr, env);

  // Now pop the environment frame
  env = popEnvFrame(env);

  expr.$ = {
    env,
    type: lastExpr.$.type,
    value: lastExpr.$.value,
    pathCollection: [],
    controlFlow: lastExpr.$.controlFlow,
  };

  attachTempVariableToExpr(expr);

  return expr;
}
