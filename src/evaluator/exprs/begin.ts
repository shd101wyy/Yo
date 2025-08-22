import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  getVariablesNeedingDrop,
  popEnvFrame,
  pushEnvFrame,
  Variable,
} from "../../env";
import { formatErrorMessage, formatErrorMessages } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  cloneExpr,
  ControlFlowKind,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
  replaceFuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { createRegionValue } from "../../region-value";
import {
  areTypesCompatible,
  isLinearOrType0Type,
  typeContains2ndClassReference,
  typeOfType,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { generateNewTempVariableName } from "../../utils";
import { EvaluatorContext } from "../context";
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
    replaceFuncCallExpr(expr as FuncCallExpr, beginExpr);
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
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  // Push a new environment frame
  env = pushEnvFrame(env);

  // Create region value and add it to the environment
  const regionValue = createRegionValue(env);
  // Add the region value to the environment
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: generateNewTempVariableName(env.modulePath),
      type: regionValue.type,
      value: regionValue,
      isMutable: false,
      token: expr.token,
      consumedAtToken: undefined,
      initializedAtToken: expr.token,
      isCompileTimeOnly: true,
      isImplicit: true,
      isCreatedFromDestructuringAtomVariable: false,
    },
  });
  env = nextEnv;

  // Add variablesToAdd to the environment
  for (let i = 0; i < variablesToAdd.length; i++) {
    const variable = variablesToAdd[i]!;
    const { env: nextEnv } = addVariableToEnv({ env, variable });
    env = nextEnv;
  }

  // Store the initial environment to compare with final environment later
  const initialEnv = env;

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

      if (!context.isEvaluatingFunctionBody) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "return" keyword can only be used inside a function body.`,
        });
      }

      if (exprIsAtom(exprToEvaluate)) {
        // return;
        // return unit
        exprToEvaluate.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          isMutable: false,
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

        const evaluatedReturnExpr = context.evaluateExpression({
          expr: returnArg,
          env,
          context: {
            ...context,
            expectedType: {
              type: context.isEvaluatingFunctionBody!.type.return.type,
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
        isMutable: false,
        pathCollection: [],
        controlFlow: "continue",
      };
      lastExpr = exprToEvaluate;
      break;
    }
    // Normal expression evaluation
    else {
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

  // Prevent return reference to the local variable.
  const returnType = lastExpr.$.type;
  if (typeContains2ndClassReference(returnType)) {
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
          variable.frameLevel === env.frames.length - 1 &&
          !variable.isCreatedFromDestructuringAtomVariable
        ) {
          // If the variable is a local variable, we cannot return a reference to it
          throw formatErrorMessage({
            token: lastExpr.token,
            errorMessage: `Cannot return value containing reference to the local variable "${variableName}".`,
          });
        }
        // QUESTION: Why do we add this before?
        /*
        else if (
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
        */
      }
    }
  }

  // Check if return type is compatible
  if (lastExpr.$.controlFlow === "return") {
    // First try to synthesize the types to handle cases like [i32; n] vs [i32; 5]
    try {
      synthesizeTypes(
        {
          type: context.isEvaluatingFunctionBody!.type.return.type,
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

  // Validate linear value consumption in while loops
  validateLinearConsumptionInLoop(
    initialEnv,
    env,
    context,
    lastExpr.$.controlFlow
  );

  // Handle automatic drop insertion for RAII BEFORE popping the frame
  // Get variables that need drop calls using the helper function
  const variablesNeedingDrop = getVariablesNeedingDrop(env);
  const dropCallsToInsert: Expr[] = [];

  for (const variable of variablesNeedingDrop) {
    const dropCallCode = `drop(${variable.name})`;
    const dropCall = generateExprFromCode(dropCallCode);
    dropCallsToInsert.push(dropCall);
  }

  // If we have drop calls to insert and this is a begin expression,
  // we need to evaluate them and insert them before control flow statements
  if (dropCallsToInsert.length > 0 && exprIsFunctionCall(expr)) {
    const originalArgs = expr.args.slice();

    // Find the position to insert drops - before return/break/continue or before the last expression
    let insertPosition = originalArgs.length - 1;
    const lastArg = originalArgs[insertPosition];

    // Check if the last expression is a control flow statement
    if (lastArg && lastArg.$ && lastArg.$.controlFlow) {
      // Insert before the control flow statement
      insertPosition = originalArgs.length - 1;
    } else {
      // Check the second-to-last expression for control flow
      const secondLastArg = originalArgs[originalArgs.length - 2];
      if (secondLastArg && secondLastArg.$ && secondLastArg.$.controlFlow) {
        // Insert before the control flow statement
        insertPosition = originalArgs.length - 2;
      }
    }

    // Evaluate each drop call and mark variables as consumed
    const evaluatedDropCalls: Expr[] = [];
    for (let i = 0; i < dropCallsToInsert.length; i++) {
      const dropCall = dropCallsToInsert[i]!;

      const evaluatedDropCall = context.evaluateExpression({
        expr: dropCall,
        env,
        context: { ...context },
      });
      if (evaluatedDropCall.$) {
        env = evaluatedDropCall.$.env;
        evaluatedDropCalls.push(evaluatedDropCall);
      } else {
        throw formatErrorMessage({
          token: dropCall.token,
          errorMessage: `Failed to evaluate auto-generated drop call: ${exprToString(dropCall)}`,
        });
      }
    }

    // Insert evaluated drop calls at the correct position
    expr.args = [
      ...originalArgs.slice(0, insertPosition),
      ...evaluatedDropCalls,
      ...originalArgs.slice(insertPosition),
    ];
  }

  // Now pop the environment frame
  env = popEnvFrame(env);

  // console.log("begin expression after applying drops:");
  // console.log(exprToString(expr));

  expr.$ = {
    env,
    type: lastExpr.$.type,
    value: lastExpr.$.value,
    isMutable: false,
    pathCollection: [],
    controlFlow: lastExpr.$.controlFlow,
  };
  attachTempVariableToExpr(expr);
  return expr;
}

/**
 * Validates that linear values defined outside a while loop are only consumed
 * if the block has terminating control flow (return/break/continue).
 */
function validateLinearConsumptionInLoop(
  initialEnv: Environment,
  finalEnv: Environment,
  context: EvaluatorContext,
  controlFlow: ControlFlowKind | undefined
): void {
  if (!context.isEvaluatingLoopBody) {
    return; // Not in a while loop, no validation needed
  }

  const loopFrameCount = context.isEvaluatingLoopBody.env.frames.length;

  // Check each frame that existed before the while/for loop
  for (let frameIndex = 0; frameIndex < loopFrameCount; frameIndex++) {
    const initialFrame = initialEnv.frames[frameIndex];
    const finalFrame = finalEnv.frames[frameIndex];

    if (!initialFrame || !finalFrame) {
      continue;
    }

    // Check each variable in the frame
    for (
      let varIndex = 0;
      varIndex < initialFrame.variables.length;
      varIndex++
    ) {
      const initialVariable = initialFrame.variables[varIndex];
      const finalVariable = finalFrame.variables[varIndex];

      if (!initialVariable || !finalVariable) {
        continue;
      }

      // Skip if variable was already consumed before the block
      if (initialVariable.consumedAtToken) {
        continue;
      }

      // Check if this is a linear variable that got consumed in the block
      if (
        isLinearOrType0Type(typeOfType(initialVariable.type)) &&
        finalVariable.consumedAtToken &&
        !initialVariable.consumedAtToken
      ) {
        // If the block doesn't have terminating control flow, it's an error
        // Only "return" and "break" are terminating; "continue" and no control flow are not
        if (!controlFlow || controlFlow === "continue") {
          /*
          if (
            varIndex === initialFrame.variables.length - 1 &&
            context.isEvaluatingLoopBody.kind === "for"
          ) {
            continue; // This is the last frame of the "for" loop. It contains `item` and `index` which we allow to consume multiple times because
            // each iteration we assign new values to them.
          }
          */

          throw formatErrorMessages([
            {
              token: finalVariable.consumedAtToken,
              errorMessage: `Cannot consume linear value "${initialVariable.name}" inside a while loop that may iterate multiple times. Linear values can only be consumed once, but this loop could potentially consume it in each iteration.`,
            },
            {
              token: initialVariable.token,
              errorMessage: `Variable "${initialVariable.name}" defined here:`,
            },
          ]);
        }
      }
    }
  }
}
