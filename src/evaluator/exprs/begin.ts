import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  getVariablesNeedingDrop,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
  Variable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  AtomExpr,
  attachTempVariableToExpr,
  BuiltinFunctions,
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
  replaceFuncCallExprWithAtomExpr,
  replaceFuncCallExprWithFuncCallExpr,
  setExprAsConsumed,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  areTypesCompatible,
  typeContains2ndClassReference,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
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

/**
 * Recursively searches for ___dup calls within an expression
 * Returns a map of borrowed-from variable names to their dup call expressions
 */
function findDupCallsInExpression(expr: Expr): Map<string, FuncCallExpr> {
  const dupCalls = new Map<string, FuncCallExpr>();

  function searchRecursively(currentExpr: Expr): void {
    // Look for function calls like (x.___dup)()
    if (
      exprIsFunctionCall(currentExpr) &&
      exprIsFunctionCall(currentExpr.func) &&
      exprIsFunctionCallOf(currentExpr.func, ".", 2) &&
      exprIsAtom(currentExpr.func.args[0]) &&
      exprIsAtom(currentExpr.func.args[1]) &&
      currentExpr.func.args[1].token.value === BuiltinFunctions.___dup[0] &&
      currentExpr.args.length === 0 &&
      currentExpr.$?.env
    ) {
      const variableName = currentExpr.func.args[0].token.value;

      // Look up the variable in the expression's environment to find what it's borrowing from
      const variables = getVariablesFromEnv(currentExpr.$.env, variableName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.isBorrowingTheARCValueOfVariable) {
          // Store the dup call mapped to the borrowed-from variable name
          const borrowedFromVariableName =
            variable.isBorrowingTheARCValueOfVariable.name;
          dupCalls.set(borrowedFromVariableName, currentExpr);
        }
      }
      return;
    }

    // Recursively search in function calls
    if (exprIsFunctionCall(currentExpr)) {
      searchRecursively(currentExpr.func);
      for (const arg of currentExpr.args) {
        searchRecursively(arg);
      }
    }
  }

  searchRecursively(expr);
  return dupCalls;
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

  // Handle automatic drop insertion for RAII before popping the frame
  // Get variables that need drop calls using the helper function
  const variablesNeedingDrop = getVariablesNeedingDrop(env);

  // Optimization: Track ___dup calls that can be canceled with ___drop calls
  const dupCallsToOptimize = new Map<string, FuncCallExpr>(); // borrowed-from variable name -> dup call expr

  // Scan through expressions to find ___dup calls using the helper function
  if (exprIsFunctionCall(expr)) {
    for (const arg of expr.args) {
      const dupCallsInArg = findDupCallsInExpression(arg);
      for (const [variableName, dupCallExpr] of dupCallsInArg) {
        dupCallsToOptimize.set(variableName, dupCallExpr);
      }
    }
  }

  const dropCallsToInsert: Expr[] = [];

  for (const variable of variablesNeedingDrop) {
    // Check if this variable has a ___dup call that can be optimized
    let shouldSkipDrop = false;

    // Check if there's a dup call for this variable that we can optimize
    if (dupCallsToOptimize.has(variable.name)) {
      // We can optimize: remove the ___dup call and skip the ___drop call
      shouldSkipDrop = true;

      // Replace the dup call with the original variable right here
      const dupCallExpr = dupCallsToOptimize.get(variable.name)!;
      const funcCallExpr = dupCallExpr as FuncCallExpr;
      const funcExpr = funcCallExpr.func as FuncCallExpr;
      const originalVarExpr: AtomExpr = {
        tag: ExprTag.Atom,
        token: (funcExpr.args[0] as AtomExpr).token,
        $: dupCallExpr.$, // Keep the same evaluation data
      };

      replaceFuncCallExprWithAtomExpr(funcCallExpr, originalVarExpr);

      // Mark the owning variable as consumed to prevent "not consumed" errors
      const updatedVariable = {
        ...variable,
        consumedAtToken: dupCallExpr.token,
      };
      env = updateExistingVariable(env, variable, updatedVariable);

      // Remove the dup call from future optimization attempts
      dupCallsToOptimize.delete(variable.name);
    }

    if (!shouldSkipDrop) {
      const dropCallCode = `${BuiltinFunctions.___drop[0]!}(${variable.name})`;
      const dropCall = generateExprFromCode(dropCallCode);
      dropCallsToInsert.push(dropCall);
    }
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

  if (variablesNeedingDrop.length) {
    console.log("\nbegin expression after applying drops:");
    console.log(exprToString(expr));
  }

  expr.$ = {
    env,
    type: lastExpr.$.type,
    value: lastExpr.$.value,
    pathCollection: [],
    controlFlow: lastExpr.$.controlFlow,
  };

  let lastExprIsOwningTheARCValue = false;
  const lastExprVariableName = lastExpr.$.variableName;
  if (lastExprVariableName) {
    const variables = getVariablesFromEnv(env, lastExprVariableName);
    if (variables.length) {
      const variable = variables[variables.length - 1]!;
      lastExprIsOwningTheARCValue = Boolean(variable.isOwningTheARCValue);
    }
  }

  attachTempVariableToExpr(expr, true);

  if (!lastExprIsOwningTheARCValue) {
    setExprAsNeedsToCallDup(expr, context);
  }

  return expr;
}
