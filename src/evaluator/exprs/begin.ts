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
import { formatErrorMessage, formatErrorMessages } from "../../error";
import {
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
  FnCallExpr,
  replaceFuncCallExprWithFuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { areTypesCompatible } from "../../types/compatibility";
import { isObjectType, isSomeType } from "../../types/guards";
import { typeContainsRcType, typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { synthesizeTypes } from "../types/synthesizer";

/**
 * For debugging the dup/drop optimization.
 * Set it to `false` to disable the optimization.
 */
const OPTIMIZE_DUP_AND_DROP_PAIRS = true;

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

  /// console.log("\\n=== DEBUG: generateDeferredDropExpressions ===");
  /// console.log(
  ///   "Variables to drop:",
  ///   variablesToDrop.map((v) => `${v.name} (id: ${v.id})`).join(", ")
  /// );

  for (const variable of variablesToDrop) {
    /// console.log(`\\nGenerating drop for variable: ${variable.name}`);
    /// console.log(`  Variable ID: ${variable.id}`);
    /// console.log(`  Variable type: ${typeToString(variable.type)}`);
    /// console.log(
    ///   `  Variable initializedAtToken:`,
    ///   variable.initializedAtToken?.value
    /// );

    // Create a drop expression: ___drop(varName)
    const dropExpr: Expr = generateExprFromCode(
      `${BuiltinFunctions.___drop[0]!}(${variable.name})`
    );

    // Evaluate the dropExpr to ensure it's properly typed and processed
    const evaluatedDropExpr = evaluateExpression({
      expr: dropExpr,
      env: finalEnv,
      context: {
        ...context,
        expectedType: {
          env: finalEnv,
          type: VUnit.type,
        },
      },
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

/**
 * Result of collecting dup calls with conservative analysis.
 * - dupCalls: Map of variable ID to dup call expressions that can be safely optimized
 * - varsWithPartialBranchDups: Set of variable IDs that have dups in SOME but not ALL branches.
 *   These variables should NOT have their drops optimized away because on some execution paths
 *   the dup happens but the drop at the end of scope would be skipped.
 */
interface DupCallsResult {
  dupCalls: Map<string, FnCallExpr[]>;
  varsWithPartialBranchDups: Set<string>;
}

function searchRecursively(
  expr: Expr,
  dupCalls: Map<string, FnCallExpr[]>,
  varsWithPartialBranchDups: Set<string>
): void {
  // Check the captured dup expressions first
  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      searchRecursively(dupExpr, dupCalls, varsWithPartialBranchDups);
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
      // Always add the dup call under the variable's ID
      // During optimization, we use getBaseVariableId to find matches
      if (!dupCalls.has(variable.id)) {
        dupCalls.set(variable.id, []);
      }
      dupCalls.get(variable.id)!.push(expr);
    }
    return;
  }

  // Skip while loops - they execute multiple times so optimization would be incorrect
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.while)
  ) {
    // Don't apply optimization to while loops - the body can execute multiple times
    // which would create multiple references without corresponding dup calls
    return;
  }

  // Skip closures - they may be called multiple times
  // if (exprIsFunctionCall(expr) && isFnTraitType(expr.$?.type)) {
  //   return;
  // }

  // Helper function to check if a branch has a control flow statement (return, break, continue)
  function branchHasControlFlow(branchBody: Expr): boolean {
    if (branchBody.$?.controlFlow) {
      return true;
    }
    // Check if it's a begin block that ends with control flow
    if (
      exprIsFunctionCall(branchBody) &&
      exprIsFunctionCallOf(branchBody, BuiltinKeywords.begin)
    ) {
      const lastArg = branchBody.args[branchBody.args.length - 1];
      if (lastArg?.$?.controlFlow) {
        return true;
      }
      // Also check if the last expression is a return statement
      if (
        exprIsFunctionCall(lastArg) &&
        exprIsFunctionCallOf(lastArg, BuiltinKeywords.return)
      ) {
        return true;
      }
    }
    // Check if it's directly a return statement
    if (
      exprIsFunctionCall(branchBody) &&
      exprIsFunctionCallOf(branchBody, BuiltinKeywords.return)
    ) {
      return true;
    }
    return false;
  }

  // Helper function to check if a branch is empty/unit (just falls through)
  function branchIsEmptyOrUnit(branchBody: Expr): boolean {
    // Check for unit literal () - parsed as tuple() with 0 args
    if (
      exprIsFunctionCall(branchBody) &&
      exprIsFunctionCallOf(branchBody, BuiltinKeywords.tuple, 0)
    ) {
      return true;
    }
    // Check for empty begin block or begin block with just unit
    if (
      exprIsFunctionCall(branchBody) &&
      exprIsFunctionCallOf(branchBody, BuiltinKeywords.begin)
    ) {
      if (branchBody.args.length === 0) {
        return true;
      }
      if (branchBody.args.length === 1) {
        const onlyArg = branchBody.args[0]!;
        if (
          exprIsFunctionCall(onlyArg) &&
          exprIsFunctionCallOf(onlyArg, BuiltinKeywords.tuple, 0)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // Helper function to handle branching expressions (cond, match)
  function handleBranchingExpression(
    expr: FnCallExpr,
    startIndex: number
  ): void {
    const branchDupCalls: DupCallsResult[] = [];
    const branchHasReturn: boolean[] = []; // Track if each branch has a return
    const branchIsEmpty: boolean[] = []; // Track if each branch is empty/falls through

    // Process each statement/pattern which should be a "=>" expression with [condition/pattern, body]
    for (let i = startIndex; i < expr.args.length; i++) {
      const statement = expr.args[i]!;
      if (
        exprIsFunctionCall(statement) &&
        exprIsFunctionCallOf(statement, "=>", 2)
      ) {
        const branchBody = statement.args[1]!; // The body is the second argument
        const branchResult = collectDupCallsConservatively(branchBody);
        branchDupCalls.push(branchResult);
        branchHasReturn.push(branchHasControlFlow(branchBody));
        branchIsEmpty.push(branchIsEmptyOrUnit(branchBody));
      }
    }

    // Collect all variable IDs that have dups in ANY branch
    const allVarsWithDups = new Set<string>();
    for (const branchResult of branchDupCalls) {
      for (const varId of branchResult.dupCalls.keys()) {
        allVarsWithDups.add(varId);
      }
      // Also include vars with partial branch dups from nested branches
      for (const varId of branchResult.varsWithPartialBranchDups) {
        varsWithPartialBranchDups.add(varId);
      }
    }

    // Process each variable that has dups in at least one branch
    if (branchDupCalls.length > 0) {
      for (const varId of allVarsWithDups) {
        // Separate branches into categories:
        // 1. Branches with dup + early return: independent dup+drop pair
        // 2. Branches with dup + fallthrough: share drop with code after cond
        // 3. Branches without dup (empty or not): don't affect optimization for this variable

        const earlyReturnBranchDups: FnCallExpr[] = [];
        const fallthroughBranchDups: FnCallExpr[] = [];

        for (let i = 0; i < branchDupCalls.length; i++) {
          const branchResult = branchDupCalls[i]!;
          const hasDup = branchResult.dupCalls.has(varId);
          const hasReturn = branchHasReturn[i]!;

          if (hasDup) {
            const dups = branchResult.dupCalls.get(varId)!;
            if (hasReturn) {
              // This branch has dup + early return: independent dup+drop
              earlyReturnBranchDups.push(...dups);
            } else {
              // This branch has dup + fallthrough: shares drop with code after cond
              fallthroughBranchDups.push(...dups);
            }
          }
          // Branches without dup don't affect optimization for THIS variable
          // (the variable isn't used in those branches)
        }

        // Add early return branch dups - these are independent and can always be optimized
        // Each early return has its own drop at the return point
        // Mark them with __isEarlyReturnDup so we know they don't pair with end-of-scope drop
        for (const dupExpr of earlyReturnBranchDups) {
          if (!dupCalls.has(varId)) {
            dupCalls.set(varId, []);
          }
          // Mark as early return dup
          (
            dupExpr as FnCallExpr & { __isEarlyReturnDup?: boolean }
          ).__isEarlyReturnDup = true;
          dupCalls.get(varId)!.push(dupExpr);
        }

        // Fallthrough branch dups share one drop at end of scope
        // Only mark as partial branch dup if:
        // - There are fallthrough dups AND
        // - Not ALL fallthrough branches have the dup
        if (fallthroughBranchDups.length > 0) {
          // Count how many fallthrough branches exist (non-early-return branches)
          let fallthroughBranchCount = 0;
          let fallthroughBranchesWithDup = 0;
          for (let i = 0; i < branchDupCalls.length; i++) {
            if (!branchHasReturn[i]) {
              fallthroughBranchCount++;
              if (branchDupCalls[i]!.dupCalls.has(varId)) {
                fallthroughBranchesWithDup++;
              }
            }
          }

          if (fallthroughBranchesWithDup === fallthroughBranchCount) {
            // All fallthrough branches have the dup - can optimize
            if (!dupCalls.has(varId)) {
              dupCalls.set(varId, []);
            }
            for (const dupExpr of fallthroughBranchDups) {
              dupCalls.get(varId)!.push(dupExpr);
            }
          } else {
            // Some fallthrough branches have dup, some don't - can't optimize
            varsWithPartialBranchDups.add(varId);
          }
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

  // Handle match expressions - search scrutinee, then only include dup calls from branches that are present in ALL branches
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.match)
  ) {
    // First, search through the scrutinee (first argument)
    if (expr.args[0]) {
      searchRecursively(expr.args[0], dupCalls, varsWithPartialBranchDups);
    }
    // Then handle branches conservatively (only dup calls present in ALL branches)
    handleBranchingExpression(expr, 1); // Skip the first argument (scrutinee) since we already handled it
    return;
  }

  // Recursively search in function calls
  if (exprIsFunctionCall(expr)) {
    searchRecursively(expr.func, dupCalls, varsWithPartialBranchDups);
    for (const arg of expr.args) {
      searchRecursively(arg, dupCalls, varsWithPartialBranchDups);
    }
  }
}

// Function to recursively collect dup calls with conservative cross-branch analysis
function collectDupCallsConservatively(currentExpr: Expr): DupCallsResult {
  const dupCalls = new Map<string, FnCallExpr[]>();
  const varsWithPartialBranchDups = new Set<string>();

  searchRecursively(currentExpr, dupCalls, varsWithPartialBranchDups);
  return { dupCalls, varsWithPartialBranchDups };
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

/**
 * Remove optimized dup calls from deferredDupExpressions recursively.
 * This is used after identifying which dup/drop pairs can be cancelled.
 */
function removeDupCallsFromExpr(
  expr: Expr,
  dupCallsToRemove: Set<FnCallExpr>
): void {
  if (expr.$?.deferredDupExpressions) {
    expr.$.deferredDupExpressions = expr.$.deferredDupExpressions.filter(
      (dupExpr) => !dupCallsToRemove.has(dupExpr as FnCallExpr)
    );
    if (expr.$.deferredDupExpressions.length === 0) {
      expr.$.deferredDupExpressions = undefined;
    }
  }

  if (exprIsFunctionCall(expr)) {
    removeDupCallsFromExpr(expr.func, dupCallsToRemove);
    for (const arg of expr.args) {
      removeDupCallsFromExpr(arg, dupCallsToRemove);
    }
  }
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
    // ) as FnCallExpr;
    const beginExpr: FnCallExpr = {
      tag: ExprTag.FnCall,
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
    replaceFuncCallExprWithFuncCallExpr(expr as FnCallExpr, beginExpr);
    expr = expr as FnCallExpr;
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

  // Push a new environment frame marked as begin block frame
  // This is important for temp variable placement - temp variables should be added
  // to the nearest begin block frame, not nested function call frames
  env = pushEnvFrame(env, undefined, true /* isBeginBlockFrame */);

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

        // Validate Impl return types across multiple return statements
        if (
          context.isEvaluatingFunctionBodyOrAsyncBlock?.kind ===
            "function-body" &&
          isSomeType(
            context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
          ) &&
          context.functionReturnImplConcreteType
        ) {
          const returnedConcreteType = evaluatedReturnArgExpr.$.type;

          if (context.functionReturnImplConcreteType.length > 0) {
            // We've seen a return before - check that the concrete types match
            const firstReturn = context.functionReturnImplConcreteType[0]!;
            const compatible = areTypesCompatible(
              { type: firstReturn.concreteType, env: firstReturn.env },
              { type: returnedConcreteType, env }
            );

            if (!compatible) {
              throw formatErrorMessages([
                {
                  token: exprToEvaluate.token,
                  errorMessage: `All return statements must return the same concrete type for Impl(...).
Impl(...) uses static dispatch and requires the same concrete type across all returns.
Consider using Dyn(...) for dynamic dispatch if different concrete types are needed.`,
                },
                {
                  token: firstReturn.token,
                  errorMessage: `First return has concrete type: ${typeToString(firstReturn.concreteType)}`,
                },
                {
                  token: exprToEvaluate.token,
                  errorMessage: `Conflicting return has concrete type: ${typeToString(returnedConcreteType)}`,
                },
              ]);
            }
          } else {
            // This is the first return - record its concrete type by mutating the array
            context.functionReturnImplConcreteType.push({
              concreteType: returnedConcreteType,
              env,
              token: exprToEvaluate.token,
            });
          }
        }

        // Attach temp variable to return value expression if it's non-unit
        // This is needed for C codegen to store the value before running deferred drops
        attachTempVariableToExpr(evaluatedReturnArgExpr, true);

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

  // Simplified ownership model for begin blocks:
  // Call dup when returning a value from an outer scope.
  // This ensures clean ownership semantics.
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

  // When returning a variable from the current frame, mark it as consumed (ownership transfer)
  // When returning from an outer frame, call dup (borrowing)
  if (
    returnVariable?.isOwningTheRcValue &&
    returnVariable.frameLevel === env.frames.length - 1 &&
    !returnVariable.consumedAtToken
  ) {
    // Variable from current frame - transfer ownership by marking as consumed
    env = updateExistingVariable(env, returnVariable, {
      ...returnVariable,
      consumedAtToken: lastExpr.token,
    });
  } else if (returnVariable && returnValueExpr) {
    // Variable from outer frame or non-owning - call dup
    setExprAsNeedsToCallDup(returnValueExpr, context);
    env = returnValueExpr.$!.env!;
  }

  // Handle automatic drop insertion for RAII before popping the frame
  // Get variables that need drop calls using the helper function
  // When evaluating function body begin block, also check the parameters frame (previous frame)
  let variablesNeedingDrop = getVariablesNeedingDrop(env);
  const variablesActuallyNeedingDrop: Variable[] = [];

  if (OPTIMIZE_DUP_AND_DROP_PAIRS) {
    if (isEvaluatingFunctionBodyBeginBlock && env.frames.length >= 2) {
      // Also get variables from the parameters frame (one level down)
      const parametersFrameEnv = {
        ...env,
        frames: env.frames.slice(0, -1), // Remove the current frame, keep parameters frame as top
      };
      const parametersNeedingDrop = getVariablesNeedingDrop(parametersFrameEnv);
      // Combine both lists, parameters first (they should be dropped last, in reverse order)
      variablesNeedingDrop = [
        ...variablesNeedingDrop,
        ...parametersNeedingDrop,
      ];
    }

    // Optimization: Collect all dup calls using the existing infrastructure
    const dupCallsByBaseVariable = new Map<string, FnCallExpr[]>();
    // Track variables that have dups in some but not all branches - these should NOT be optimized
    const allVarsWithPartialBranchDups = new Set<string>();

    // Scan through all expressions in the begin block to collect dup calls
    if (exprIsFunctionCall(expr)) {
      for (const arg of expr.args) {
        const dupCallsResult = collectDupCallsConservatively(arg);
        for (const [variableId, dupCallExprs] of dupCallsResult.dupCalls) {
          if (!dupCallsByBaseVariable.has(variableId)) {
            dupCallsByBaseVariable.set(variableId, []);
          }
          const existingDups = dupCallsByBaseVariable.get(variableId)!;
          for (const dupExpr of dupCallExprs) {
            // Avoid adding the same dup expression twice (can happen when same function body is reused)
            if (!existingDups.includes(dupExpr)) {
              existingDups.push(dupExpr);
            }
          }
        }
        // Merge varsWithPartialBranchDups
        for (const varId of dupCallsResult.varsWithPartialBranchDups) {
          allVarsWithPartialBranchDups.add(varId);
        }
      }
    }

    // Optimize: For each variable needing drop, check if there's a matching dup call
    const dupCallsToRemove = new Set<FnCallExpr>(); // Track which dup calls to remove

    for (const variable of variablesNeedingDrop) {
      // Follow the entire isOwningTheSameRcValueAs chain to get the root base variable
      let baseVariable = variable;
      while (baseVariable.isOwningTheSameRcValueAs) {
        baseVariable = baseVariable.isOwningTheSameRcValueAs;
      }
      const baseId = baseVariable.id;
      const dupCalls = dupCallsByBaseVariable.get(baseId);

      // Special case: Don't optimize value type assignments with RC fields.
      // When we do `y = temp_value` in C where both are value types (structs, enums, arrays),
      // it's a memcpy (shallow copy). Both y and temp_value exist as separate values,
      // and each needs its own drop call to properly decrement the RC of their inner fields.
      // Optimizing away the dup/drop pair would cause use-after-free.
      // Check the base variable (the temp being assigned from), not the derived variable.
      // Only pointer types (object(...)) can be safely optimized here.
      const isValueTypeWithRCFields =
        !isObjectType(baseVariable.type) &&
        typeContainsRcType(baseVariable.type);

      // Check if this variable has dups in some but not all branches.
      // This happens when there's an early return in one branch that dups the variable,
      // but another branch doesn't dup it.
      // CONSERVATIVE: If partial branch dups exist, don't optimize this variable at all.
      // The early return branch needs the dup+drop, and optimizing the normal path
      // would leave the early return without proper cleanup.
      const hasPartialBranchDups = allVarsWithPartialBranchDups.has(baseId);

      if (
        dupCalls &&
        dupCalls.length > 0 &&
        !isValueTypeWithRCFields &&
        !hasPartialBranchDups
      ) {
        // Count how many runtime dups we have.
        // Branch groups (marked with __branchGroup) count as 1 runtime dup.
        // Regular dups count as 1 dup each.
        let runtimeDupCount = 0;
        const allDupExprsToRemove: FnCallExpr[] = [];
        const branchGroups: FnCallExpr[][] = [];

        for (const dupCallExpr of dupCalls) {
          const marker = dupCallExpr as FnCallExpr & {
            __branchGroup?: FnCallExpr[];
            __isEarlyReturnDup?: boolean;
          };
          if (marker.__isEarlyReturnDup) {
            // Early return dups are INDEPENDENT - they have their own drop at the return point
            // They don't count toward runtimeDupCount for the end-of-scope drop
            allDupExprsToRemove.push(dupCallExpr);
          } else if (marker.__branchGroup) {
            // This is a branch group - counts as 1 runtime dup
            runtimeDupCount++;
            branchGroups.push(marker.__branchGroup);
          } else {
            // Regular dup call - counts as 1 runtime dup
            runtimeDupCount++;
            allDupExprsToRemove.push(dupCallExpr);
          }
        }

        // We can optimize: cancel ONE dup with ONE drop.
        // The optimization cancels dup+drop pairs where the dup creates a reference
        // that is immediately consumed by returning the value (ownership transfer).
        // We only remove ONE runtime dup to cancel with the ONE drop at end of scope.
        // Note: Early return dups are always removed (they pair with their own drops).
        if (runtimeDupCount <= 1) {
          // Zero or one runtime dup that pairs with end-of-scope drop - can optimize
          // Zero means only early return dups exist (all independent)
          // One means one dup pairs with one drop
          // Add all branch group expressions (they all represent the same runtime dup)
          for (const group of branchGroups) {
            for (const dupExpr of group) {
              dupCallsToRemove.add(dupExpr);
            }
          }
          // Add regular dup expressions (including early return dups)
          for (const dupExpr of allDupExprsToRemove) {
            dupCallsToRemove.add(dupExpr);
          }

          // Clear the list
          dupCalls.length = 0;

          // Mark the variable as consumed so it won't generate a drop call at end of function
          // This handles the end-of-scope drop. Early return drops are handled separately.
          env = updateExistingVariable(env, variable, {
            ...variable,
            consumedAtToken: lastExpr.token,
          });
        } else {
          // Multiple runtime dups - can't simply cancel them all with one drop
          // The variable needs all the dups and the drop
          variablesActuallyNeedingDrop.push(variable);
        }
      } else {
        // No matching dup call, this variable actually needs drop
        variablesActuallyNeedingDrop.push(variable);
      }
    }

    // Remove the optimized dup calls from deferredDupExpressions
    if (exprIsFunctionCall(expr)) {
      for (const arg of expr.args) {
        removeDupCallsFromExpr(arg, dupCallsToRemove);
      }
    }
  }

  // Generate deferred drop expressions instead of inserting them directly
  let deferredDropExpressions: Expr[] | undefined = undefined;

  if (
    (OPTIMIZE_DUP_AND_DROP_PAIRS
      ? variablesActuallyNeedingDrop
      : variablesNeedingDrop
    ).length > 0
  ) {
    const dropResult = generateDeferredDropExpressions({
      variablesToDrop: OPTIMIZE_DUP_AND_DROP_PAIRS
        ? variablesActuallyNeedingDrop
        : variablesNeedingDrop,
      env,
      context: {
        ...context,
        expectedType: undefined, // Drop expressions should not inherit expectedType
      },
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

  // Save the current frame before popping
  const currentFrame = env.frames[env.frames.length - 1];

  // Now pop the environment frame
  env = popEnvFrame(env);

  expr.$ = {
    env,
    type: lastExpr.$.type,
    value: lastExpr.$.value,
    pathCollection: [],
    controlFlow: lastExpr.$.controlFlow,
    deferredDropExpressions,
    poppedEnvFrame: currentFrame,
  };

  // Attach temp variable for the begin block result
  // If we're dupping a variable (borrowing from outer scope), track the ownership relationship
  // so the optimization can cancel the dup/drop pair
  if (
    returnVariable &&
    returnValueExpr?.$?.deferredDupExpressions &&
    returnValueExpr.$.deferredDupExpressions.length > 0
  ) {
    attachTempVariableToExpr(expr, true, returnVariable);
  } else if (returnVariable?.consumedAtToken) {
    attachTempVariableToExpr(expr, true, returnVariable);
  } else {
    attachTempVariableToExpr(expr, true);
  }

  return expr;
}
