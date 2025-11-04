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
import { Token } from "../../token";
import { areTypesCompatible, isClosureType, typeToString } from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { synthesizeTypes } from "../types/synthesizer";

/**
 * Generate ___drop expressions for variables that need cleanup.
 *
 * This function creates and evaluates ___drop expressions for variables that require
 * cleanup at the end of a scope. These expressions are deferred to the codegen phase
 * to prevent use-after-free errors that would occur if drop calls were inserted
 * directly into the AST during evaluation.
 *
 * @param variablesToDrop - Array of variables that need drop calls
 * @param env - The environment to use for evaluation
 * @param context - The evaluator context
 * @param dropToken - Token to use for the drop expressions (typically the end of scope token)
 * @returns Object containing the generated drop expressions and updated environment
 */
function generateDeferredDropExpressions({
  variablesToDrop,
  env,
  context,
}: {
  variablesToDrop: Variable[];
  env: Environment;
  context: EvaluatorContext;
}): {
  deferredDropExpressions: Expr[] | undefined;
  env: Environment;
} {
  const deferredDropExpressions: Expr[] = [];
  let finalEnv = env;

  for (const variable of variablesToDrop) {
    // Create a drop expression: ___drop(varName)
    const dropExpr: Expr = generateExprFromCode(
      `${BuiltinFunctions.___drop[0]!}(${variable.name})`
    );

    // Evaluate the dropExpr to ensure it's properly typed and processed
    const evaluatedDropExpr = evaluateExpression({
      expr: dropExpr,
      env: finalEnv,
      context: { ...context },
    });

    deferredDropExpressions.push(evaluatedDropExpr);

    // Update the environment with the evaluated expression's environment
    if (evaluatedDropExpr.$ && evaluatedDropExpr.$.env) {
      finalEnv = evaluatedDropExpr.$.env;
    }
  }

  return {
    deferredDropExpressions:
      deferredDropExpressions.length > 0 ? deferredDropExpressions : undefined,
    env: finalEnv,
  };
}

function searchRecursively(
  expr: Expr,
  dupCalls: Map<string, FuncCallExpr[]>
): void {
  // Check the captured dup expressions first
  if (expr.$?.capturedVariableDupExpressions) {
    for (const dupExpr of expr.$.capturedVariableDupExpressions) {
      searchRecursively(dupExpr, dupCalls);
    }
  }

  // Look for function calls like (x.___dup)()
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCall(expr.func) &&
    exprIsFunctionCallOf(expr.func, ".", 2) &&
    exprIsAtom(expr.func.args[0]) &&
    exprIsAtom(expr.func.args[1]) &&
    expr.func.args[1].token.value === BuiltinFunctions.___dup[0] &&
    expr.args.length === 0 &&
    expr.$?.env
  ) {
    const variableName = expr.func.args[0].token.value;

    // Look up the variable in the expression's environment
    const variables = getVariablesFromEnv(expr.$.env, variableName);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;

      // Track dup calls for optimization:
      // 1. If the variable is borrowing from another owning variable (deprecated pattern)
      // 2. If the variable itself is owning (new pattern with assignments always own)
      if (variable.isBorrowingTheARCValueOfVariable) {
        // Store the dup call mapped to the borrowed-from variable name
        const borrowedFromVariableName =
          variable.isBorrowingTheARCValueOfVariable.name;
        if (!dupCalls.has(borrowedFromVariableName)) {
          dupCalls.set(borrowedFromVariableName, []);
        }
        dupCalls.get(borrowedFromVariableName)!.push(expr);
      } else if (variable.isOwningTheARCValue) {
        // For owning variables, track the dup call directly under the variable's name
        if (!dupCalls.has(variableName)) {
          dupCalls.set(variableName, []);
        }
        dupCalls.get(variableName)!.push(expr);
      }
    }
    return;
  }

  // Skip while/for loops - they execute multiple times so optimization would be incorrect
  if (
    exprIsFunctionCall(expr) &&
    (exprIsFunctionCallOf(expr, BuiltinKeywords.while) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.for))
  ) {
    // Don't apply optimization to while loops - the body can execute multiple times
    // which would create multiple references without corresponding dup calls
    return;
  }
  // Skip closures - they may be called multiple times
  if (exprIsFunctionCall(expr) && isClosureType(expr.$?.type)) {
    return;
  }

  // Helper function to handle branching expressions (cond, match)
  function handleBranchingExpression(
    expr: FuncCallExpr,
    startIndex: number
  ): void {
    const branchDupCalls: Map<string, FuncCallExpr[]>[] = [];

    // Process each statement/pattern which should be a "=>" expression with [condition/pattern, body]
    for (let i = startIndex; i < expr.args.length; i++) {
      const statement = expr.args[i]!;
      if (
        exprIsFunctionCall(statement) &&
        exprIsFunctionCallOf(statement, "=>", 2)
      ) {
        const branchBody = statement.args[1]!; // The body is the second argument
        const branchDups = collectDupCallsConservatively(branchBody);
        branchDupCalls.push(branchDups);
      }
    }

    // Only include dup calls that are present in ALL branches
    if (branchDupCalls.length > 0) {
      const firstBranchDups = branchDupCalls[0]!;
      for (const [varName, _dupCallArray] of firstBranchDups) {
        const isPresentInAllBranches = branchDupCalls.every((branchDups) =>
          branchDups.has(varName)
        );

        if (isPresentInAllBranches) {
          // Collect all dup call expressions from all branches
          const allDupCallsForVar: FuncCallExpr[] = [];
          for (const branchDups of branchDupCalls) {
            allDupCallsForVar.push(...branchDups.get(varName)!);
          }
          dupCalls.set(varName, allDupCallsForVar);
        }
      }
    }
  }

  // Handle cond expressions - only include dup calls that are present in ALL branches
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.cond)
  ) {
    handleBranchingExpression(expr, 0);
    return;
  }

  // Handle match expressions - only include dup calls that are present in ALL branches
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.match)
  ) {
    handleBranchingExpression(expr, 1); // Skip the first argument (scrutinee)
    return;
  }

  // Recursively search in function calls
  if (exprIsFunctionCall(expr)) {
    searchRecursively(expr.func, dupCalls);
    for (const arg of expr.args) {
      searchRecursively(arg, dupCalls);
    }
  }
}

// Function to recursively collect dup calls with conservative cross-branch analysis
function collectDupCallsConservatively(
  currentExpr: Expr
): Map<string, FuncCallExpr[]> {
  const dupCalls = new Map<string, FuncCallExpr[]>();

  searchRecursively(currentExpr, dupCalls);
  return dupCalls;
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
  variablesToAdd = [],
  isEvaluatingFunctionBodyBeginBlock = false,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
  variablesToAdd: Omit<Variable, "frameLevel" | "id">[];
  /**
   * Whether we are evaluating a function body's begin block.
   * When true, don't push a new frame because the parameters frame
   * should be reused as the function body frame.
   */
  isEvaluatingFunctionBodyBeginBlock?: boolean;
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
  let returnExpr: Expr | undefined = undefined;

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
      returnExpr = exprToEvaluate;

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
        env = evaluatedReturnArgExpr.$.env;

        // Attach temp variable to return value expression if it's non-unit
        // This is needed for C codegen to store the value before running deferred drops
        attachTempVariableToExpr(evaluatedReturnArgExpr, true);

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

  let returnVariable: Variable | undefined = undefined;
  let returnValueExpr: Expr | undefined = lastExpr;
  if (
    exprIsFunctionCall(lastExpr) &&
    exprIsFunctionCallOf(lastExpr, BuiltinKeywords.return, 1)
  ) {
    returnValueExpr = lastExpr.args[0];
  }
  const returnValueExprVariableName = returnValueExpr
    ? returnValueExpr.$?.variableName
    : undefined;
  if (returnValueExprVariableName) {
    const variables = getVariablesFromEnv(env, returnValueExprVariableName);
    if (variables.length) {
      const variable = variables[variables.length - 1]!;
      returnVariable = variable;
    }
  }

  // Optimization (Design: cancellation of ___dup + ___drop when returning a borrower):
  // If we are returning a variable that borrows an owning ARC variable in this frame,
  // treat it as transferring ownership out of the frame.
  // Mark the owning variable as consumed so it will not receive an auto ___drop,
  // and skip adding a ___dup for the returned expression later.
  // Likewise, if directly returning an owning variable from this frame, mark it consumed.
  if (returnVariable?.isBorrowingTheARCValueOfVariable && returnValueExpr) {
    const ownerVariable = returnVariable.isBorrowingTheARCValueOfVariable;
    if (
      ownerVariable.isOwningTheARCValue &&
      ownerVariable.frameLevel === env.frames.length - 1 &&
      !ownerVariable.consumedAtToken
    ) {
      env = updateExistingVariable(env, ownerVariable, {
        ...ownerVariable,
        consumedAtToken: lastExpr.token,
      });
    } else {
      // Needs to call dup on the return value expression
      setExprAsNeedsToCallDup(returnValueExpr, context);
    }
  } else if (
    returnVariable?.isOwningTheARCValue &&
    returnVariable.frameLevel === env.frames.length - 1 &&
    !returnVariable.consumedAtToken
  ) {
    env = updateExistingVariable(env, returnVariable, {
      ...returnVariable,
      consumedAtToken: lastExpr.token,
    });
  } else if (!returnVariable?.isOwningTheARCValue && returnValueExpr) {
    setExprAsNeedsToCallDup(returnValueExpr, context);
  } else {
    // Set the last expression as the return value
    // and mark it as consumed.
    env = setExprAsConsumed(lastExpr, env, context);
  }

  // Handle automatic drop insertion for RAII before popping the frame
  // Get variables that need drop calls using the helper function
  // When evaluating function body begin block, also check the parameters frame (previous frame)
  let variablesNeedingDrop = getVariablesNeedingDrop(env);

  if (isEvaluatingFunctionBodyBeginBlock && env.frames.length >= 2) {
    // Also get variables from the parameters frame (one level down)
    const parametersFrameEnv = {
      ...env,
      frames: env.frames.slice(0, -1), // Remove the current frame, keep parameters frame as top
    };
    const parametersNeedingDrop = getVariablesNeedingDrop(parametersFrameEnv);
    // Combine both lists, parameters first (they should be dropped last, in reverse order)
    variablesNeedingDrop = [...variablesNeedingDrop, ...parametersNeedingDrop];
  }

  // Optimization: Track ___dup calls that can be canceled with ___drop calls
  const dupCallsToOptimize = new Map<string, FuncCallExpr[]>(); // borrowed-from variable name -> array of dup call exprs

  // Scan through expressions to find dup calls that can be safely optimized
  if (exprIsFunctionCall(expr)) {
    for (const arg of expr.args) {
      const dupCallsInArg = collectDupCallsConservatively(arg);
      for (const [variableName, dupCallExprs] of dupCallsInArg) {
        if (!dupCallsToOptimize.has(variableName)) {
          dupCallsToOptimize.set(variableName, []);
        }
        dupCallsToOptimize.get(variableName)!.push(...dupCallExprs);
      }
    }
  }

  const variablesActuallyNeedingDrop: Variable[] = [];

  // key is tempVariableName, token is which token to consume at
  const tempVariablesToConsume: Record<string, Token> = {};
  for (const variable of variablesNeedingDrop) {
    // Check if this variable has a ___dup call that can be optimized
    let shouldSkipDrop = false;

    // Check if there's a dup call for this variable that we can optimize
    if (dupCallsToOptimize.has(variable.name)) {
      // We can optimize: remove all ___dup calls and skip the ___drop call
      shouldSkipDrop = true;

      // Replace ~~all~~ one dup calls with the original variable
      const dupCallExprs = dupCallsToOptimize.get(variable.name)!;
      for (const dupCallExpr of dupCallExprs) {
        if (!exprIsFunctionCall(dupCallExpr)) {
          continue;
        }
        const funcCallExpr = dupCallExpr;
        const funcExpr = funcCallExpr.func as FuncCallExpr;

        const tempVariableName = funcCallExpr.$?.variableName;
        if (tempVariableName) {
          tempVariablesToConsume[tempVariableName] = funcCallExpr.token;
        }

        const atomExpr = funcExpr.args[0] as AtomExpr;
        const originalVarExpr: AtomExpr = {
          tag: ExprTag.Atom,
          token: atomExpr.token,
          $: {
            ...dupCallExpr.$!,
            variableName: atomExpr.$?.variableName ?? atomExpr.token.value, // NOTE: This line is necessary
          }, // Keep the same evaluation data
        };

        replaceFuncCallExprWithAtomExpr(funcCallExpr, originalVarExpr);

        break;
      }

      // Mark the owning variable as consumed to prevent "not consumed" errors
      // Use the token from the first dup call
      const firstDupCall = dupCallExprs[0]!;
      const updatedVariable = {
        ...variable,
        consumedAtToken: firstDupCall.token,
      };
      env = updateExistingVariable(env, variable, updatedVariable);

      // Remove the dup calls from future optimization attempts
      dupCallsToOptimize.delete(variable.name);
    }

    if (!shouldSkipDrop) {
      variablesActuallyNeedingDrop.push(variable);
    }
  }

  // Clean up variablesActuallyNeedingDrop by removing variables in tempVariablesToConsume
  const variablesActuallyNeedingDropFiltered: Variable[] = [];
  for (let i = 0; i < variablesActuallyNeedingDrop.length; i++) {
    const variable = variablesActuallyNeedingDrop[i]!;
    if (tempVariablesToConsume[variable.name]) {
      // Set the variable as consumed at the recorded token
      env = updateExistingVariable(env, variable, {
        ...variable,
        consumedAtToken: tempVariablesToConsume[variable.name],
      });
      // Do not add to the filtered list
    } else {
      variablesActuallyNeedingDropFiltered.push(variable);
    }
  }

  // Generate deferred drop expressions instead of inserting them directly
  let deferredDropExpressions: Expr[] | undefined = undefined;
  if (variablesActuallyNeedingDropFiltered.length > 0) {
    const dropResult = generateDeferredDropExpressions({
      variablesToDrop: variablesActuallyNeedingDropFiltered,
      env,
      context,
    });
    deferredDropExpressions = dropResult.deferredDropExpressions;
    env = dropResult.env;
  }

  // Attach deferredDropExpressions to returnExpr if exists
  if (returnExpr && returnExpr.$) {
    returnExpr.$.deferredDropExpressions = deferredDropExpressions;
    // NOTE: Don't attach temp variable to the return expression itself
    // The temp variable should be attached to the value being returned, if needed
    // attachTempVariableToExpr(returnExpr, true);
    // ^ This line will cause C codegen problem.
  }

  // Now pop the environment frame
  env = popEnvFrame(env);

  expr.$ = {
    env,
    type: lastExpr.$.type,
    value: lastExpr.$.value,
    pathCollection: [],
    controlFlow: lastExpr.$.controlFlow,
    deferredDropExpressions,
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}
