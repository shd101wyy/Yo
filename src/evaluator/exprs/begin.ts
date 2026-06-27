import {
  addVariableToEnv,
  type Environment,
  getVariablesFromEnv,
  getVariablesNeedingDrop,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
  type Variable,
} from "../../env";
import { formatErrorMessage, formatErrorMessages } from "../../error";
import {
  attachTempVariableToExpr,
  type AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  cloneExpr,
  controlFlowOf,
  expectExprToBeFunctionCallOf,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
  hasControlFlow,
  replaceFuncCallExprWithFuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { exprTreeContainsReturn } from "../../expr-traversal";
import { generateExprFromCode } from "../../parser";
import type { Token } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import { isFunctionType, isReferenceStructType, isSomeType } from "../../types/guards";
import {
  typeContainsRcType,
  typeIsControlBound,
  typeRepresentationContainsRawPtr,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import { isFunctionValue, isTypeValue, isUnknownValue } from "../../value";
import { isIoAsyncCall } from "../async/await-analysis";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";
import { typeImplementsFn } from "../trait-checking";
import { isFlowableExpr } from "../types/flowability";
import { synthesizeTypes } from "../types/synthesizer";

/**
 * For debugging the dup/drop optimization.
 * Set it to `false` to disable the optimization.
 */
const OPTIMIZE_DUP_AND_DROP_PAIRS = true;

function tokensAreComparable(left: Token, right: Token): boolean {
  return (
    left.modulePath === right.modulePath &&
    left.inputString === right.inputString
  );
}

function tokenIsAtOrBefore(left: Token, right: Token): boolean {
  if (!tokensAreComparable(left, right)) return false;
  return left.position.character <= right.position.character;
}

function tokenIsBefore(left: Token, right: Token): boolean {
  if (!tokensAreComparable(left, right)) return false;
  return left.position.character < right.position.character;
}

function variableIsCapturedByCurrentFunction(
  variable: Variable,
  context: EvaluatorContext
): boolean {
  return context.capturedVariables?.has(variable.name) === true;
}

function getLastComparableTokenInExpr(expr: Expr, reference: Token): Token {
  let last = expr.token;
  if (!tokensAreComparable(last, reference)) {
    last = reference;
  }

  const visit = (node: Expr): void => {
    if (
      tokensAreComparable(node.token, reference) &&
      node.token.position.character > last.position.character
    ) {
      last = node.token;
    }

    if (exprIsFunctionCall(node)) {
      visit(node.func);
      for (const arg of node.args) {
        visit(arg);
      }
    }
  };

  visit(expr);
  return last;
}

function isFunctionBoundaryForEarlyDrop(expr: Expr): boolean {
  if (!exprIsFunctionCallOf(expr, ["->", "=>"])) return false;
  if (expr.$?.isAnonymousFunctionDefinition === true) return true;
  if (expr.$?.value !== undefined && isFunctionValue(expr.$.value)) {
    return true;
  }
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCall(expr.func) &&
    (exprIsFunctionCallOf(expr.func, BuiltinKeywords.fn) ||
      exprIsFunctionCallOf(expr.func, BuiltinKeywords.ctl) ||
      exprIsFunctionCallOf(expr.func, BuiltinKeywords.unsafe_fn) ||
      exprIsFunctionCallOf(expr.func, BuiltinKeywords.Fn))
  ) {
    return true;
  }
  if (!expr.$) return true;
  return false;
}

function attachEarlyReturnOnlyDropExpressionToReturns(
  expr: Expr,
  variable: Variable,
  dropExpr: Expr
): void {
  const initializedAtToken = variable.initializedAtToken;
  const consumedAtToken = variable.consumedAtToken;
  if (!initializedAtToken || !consumedAtToken) return;

  const attachIfCleanupPointNeedsDrop = (cleanupPoint: Token): void => {
    const variablesAtReturn = expr.$?.env
      ? getVariablesFromEnv(expr.$.env, variable.name)
      : [];
    const latestVarAtReturn = variablesAtReturn[variablesAtReturn.length - 1];
    if (!latestVarAtReturn?.initializedAtToken) return;

    if (
      tokenIsAtOrBefore(initializedAtToken, cleanupPoint) &&
      tokenIsBefore(cleanupPoint, consumedAtToken) &&
      expr.$
    ) {
      const existingDrops = expr.$.earlyReturnOnlyDeferredDropExpressions ?? [];
      if (!existingDrops.includes(dropExpr)) {
        expr.$.earlyReturnOnlyDeferredDropExpressions = [
          ...existingDrops,
          dropExpr,
        ];
      }
    }
  };

  if (exprIsAtom(expr)) {
    if (
      exprIsAtomOf(expr, BuiltinKeywords.return) ||
      exprIsAtomOf(expr, BuiltinKeywords.unwind)
    ) {
      attachIfCleanupPointNeedsDrop(expr.token);
    }
    return;
  }

  if (exprIsFunctionCall(expr)) {
    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.return) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)
    ) {
      attachIfCleanupPointNeedsDrop(
        getLastComparableTokenInExpr(expr, consumedAtToken)
      );
      return;
    }

    if (expr.$?.macroExpansion) {
      attachEarlyReturnOnlyDropExpressionToReturns(
        expr.$.macroExpansion,
        variable,
        dropExpr
      );
    }

    if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match)
    ) {
      attachEarlyReturnOnlyDropExpressionToReturns(
        expr.func,
        variable,
        dropExpr
      );
      for (const arg of expr.args) {
        if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>")) {
          for (const branchPart of arg.args) {
            attachEarlyReturnOnlyDropExpressionToReturns(
              branchPart,
              variable,
              dropExpr
            );
          }
        } else {
          attachEarlyReturnOnlyDropExpressionToReturns(arg, variable, dropExpr);
        }
      }
      return;
    }

    if (isFunctionBoundaryForEarlyDrop(expr)) {
      return;
    }
    if (
      exprIsFunctionCall(expr.func) &&
      expr.func.$?.value !== undefined &&
      isTypeValue(expr.func.$.value) &&
      isFunctionType(expr.func.$.value.value)
    ) {
      return;
    }
    if (
      exprIsFunctionCall(expr.func) &&
      expr.func.$?.value !== undefined &&
      isTypeValue(expr.func.$.value) &&
      typeImplementsFn(expr.func.$.value.value)
    ) {
      return;
    }

    attachEarlyReturnOnlyDropExpressionToReturns(expr.func, variable, dropExpr);
    for (const arg of expr.args) {
      attachEarlyReturnOnlyDropExpressionToReturns(arg, variable, dropExpr);
    }
  }
}

function variableCanNeedDropIgnoringConsumed(variable: Variable): boolean {
  if (!variable.isOwningTheRcValue) return false;
  if (!typeContainsRcType(variable.type)) return false;
  if (variable.isModuleLevel) return false;

  const varType = variable.type;
  if (
    isSomeType(varType) &&
    !varType.resolvedConcreteType &&
    varType.requiredTraits.length === 0
  ) {
    return false;
  }

  return true;
}

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
  // BUT skip async block captures — they need BOTH the dup (to share RC ownership
  // with the state machine) AND the scope-exit drop (to release the outer scope's
  // reference after io.await frees the SM). The optimization would incorrectly
  // cancel both, causing a memory leak.
  const isAsyncBlockCapture = exprIsFunctionCall(expr) && isIoAsyncCall(expr);

  if (isAsyncBlockCapture) {
    // Don't recurse into async block captures at all.
    // For the state machine path: dups are propagated to the io.async expression
    //   and handled by the codegen. The closure's dups are already cleared.
    // For the sync path: the closure's capture struct is stack-allocated, so
    //   captures are borrowed — no dups are needed. Recursing would let the
    //   optimizer find closure-level dups and cancel them along with the
    //   captured variable's scope-exit drop, causing leaks.
    return;
  }

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
    if (hasAnyControlFlow(branchBody.$?.controlFlow)) {
      return true;
    }
    // Check if it's a begin block that ends with control flow
    if (
      exprIsFunctionCall(branchBody) &&
      exprIsFunctionCallOf(branchBody, BuiltinKeywords.begin)
    ) {
      const lastArg = branchBody.args[branchBody.args.length - 1];
      if (hasAnyControlFlow(lastArg?.$?.controlFlow)) {
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
    branchingExpr: FnCallExpr,
    startIndex: number
  ): void {
    const branchDupCalls: DupCallsResult[] = [];
    const branchHasReturn: boolean[] = []; // Track if each branch has a return
    const branchIsEmpty: boolean[] = []; // Track if each branch is empty/falls through

    // Process each statement/pattern which should be a "=>" expression with [condition/pattern, body]
    for (let i = startIndex; i < branchingExpr.args.length; i++) {
      const statement = branchingExpr.args[i]!;
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

/**
 * Optimize "loop traversal" borrow chains.
 *
 * Pattern detected (linked-list traversal):
 * ```
 * (x : T) = param;          // initial assignment with dup (borrowing from parameter)
 * while runtime(true), {
 *   match(x,
 *     .Some(binding) => {
 *       x = binding.field;  // reassignment with dup + old-value drop
 *     },
 *     .None => { return ...; }
 *   );
 * };
 * ```
 *
 * In this pattern, x's value is always kept alive by the parameter's ownership of
 * the data structure (e.g., linked list). Each node is owned by its parent, and the
 * entire structure is kept alive through the parameter. Therefore x can safely borrow
 * without incrementing/decrementing reference counts.
 *
 * The optimization removes:
 * 1. Initial dup (from x's initial assignment RHS)
 * 2. Per-iteration dup (from x's reassignment RHS inside while body)
 * 3. Per-iteration old-value save and drop (the temp variable for old x)
 * 4. Scope-exit drop of x (mark as consumed)
 * 5. Before-return drops of x in match branches (handled by marking as consumed)
 *
 * Returns the set of variable names that were optimized, so the caller can
 * exclude them from variablesNeedingDrop.
 */
function optimizeLoopTraversalBorrowChain(
  beginBlockExpr: FnCallExpr,
  env: Environment
): { optimizedVarNames: Set<string>; env: Environment } {
  const optimizedVarNames = new Set<string>();
  const args = beginBlockExpr.args;

  for (let whileIdx = 0; whileIdx < args.length; whileIdx++) {
    const whileExpr = args[whileIdx]!;

    // Find while loops
    if (
      !exprIsFunctionCall(whileExpr) ||
      !exprIsFunctionCallOf(whileExpr, BuiltinKeywords.while)
    ) {
      continue;
    }

    // Get while body (last argument)
    const whileBody = whileExpr.args[whileExpr.args.length - 1];
    if (
      !whileBody ||
      !exprIsFunctionCall(whileBody) ||
      !exprIsFunctionCallOf(whileBody, BuiltinKeywords.begin)
    ) {
      continue;
    }

    // Find match expressions in while body
    for (const bodyChild of whileBody.args) {
      if (
        !exprIsFunctionCall(bodyChild) ||
        !exprIsFunctionCallOf(bodyChild, BuiltinKeywords.match)
      ) {
        continue;
      }

      // The scrutinee is the first argument of match
      const scrutinee = bodyChild.args[0];
      if (!scrutinee || !exprIsAtom(scrutinee)) {
        continue;
      }
      const varName = scrutinee.token.value;

      // Look through match branches for a reassignment of varName
      let reassignmentRhsExpr: Expr | undefined;
      let reassignmentAssignExpr: FnCallExpr | undefined;
      let branchBeginBlock: FnCallExpr | undefined;

      for (let branchIdx = 1; branchIdx < bodyChild.args.length; branchIdx++) {
        const branch = bodyChild.args[branchIdx]!;
        // branch is =>(pattern, body)
        if (
          !exprIsFunctionCall(branch) ||
          !exprIsFunctionCallOf(branch, "=>", 2)
        ) {
          continue;
        }

        const branchBody = branch.args[1]!;
        // Check if the body is a begin block
        if (
          !exprIsFunctionCall(branchBody) ||
          !exprIsFunctionCallOf(branchBody, BuiltinKeywords.begin)
        ) {
          continue;
        }

        // Look for assignment expressions that reassign varName
        for (const stmt of branchBody.args) {
          if (exprIsFunctionCall(stmt) && exprIsFunctionCallOf(stmt, "=", 2)) {
            const lhs = stmt.args[0]!;
            if (exprIsAtom(lhs) && lhs.token.value === varName) {
              // Found: varName = something
              reassignmentRhsExpr = stmt.args[1]!;
              reassignmentAssignExpr = stmt;
              branchBeginBlock = branchBody;
              break;
            }
          }
        }
        if (reassignmentRhsExpr) break;
      }

      // Must have found a reassignment inside the while-loop match
      if (
        !reassignmentRhsExpr ||
        !reassignmentAssignExpr ||
        !branchBeginBlock
      ) {
        continue;
      }

      // Check that the reassignment RHS has a deferred dup (meaning it's an RC type)
      if (
        !reassignmentRhsExpr.$?.deferredDupExpressions ||
        reassignmentRhsExpr.$.deferredDupExpressions.length === 0
      ) {
        continue;
      }

      // Find varName's initial assignment BEFORE the while loop
      let initialAssignRhsExpr: Expr | undefined;
      for (let i = 0; i < whileIdx; i++) {
        const stmt = args[i]!;
        if (exprIsFunctionCall(stmt) && exprIsFunctionCallOf(stmt, "=", 2)) {
          const lhs = stmt.args[0]!;
          // Check for simple atom assignment or destructuring like (x : T) = rhs
          if (exprIsAtom(lhs) && lhs.token.value === varName) {
            initialAssignRhsExpr = stmt.args[1]!;
            break;
          }
          // Check for typed assignment: (x : T) which is a function call
          if (
            exprIsFunctionCall(lhs) &&
            lhs.args.length > 0 &&
            exprIsAtom(lhs.args[0]!) &&
            lhs.args[0]!.token.value === varName
          ) {
            initialAssignRhsExpr = stmt.args[1]!;
            break;
          }
        }
      }

      if (!initialAssignRhsExpr) {
        continue;
      }

      // Check that the initial value comes from a borrowed source (parameter)
      // A parameter has isOwningTheRcValue: false
      const rhsVarName = initialAssignRhsExpr.$?.variableName;
      if (!rhsVarName || !initialAssignRhsExpr.$?.env) {
        continue;
      }
      const rhsVars = getVariablesFromEnv(
        initialAssignRhsExpr.$.env,
        rhsVarName
      );
      if (rhsVars.length === 0) {
        continue;
      }
      const rhsVar = rhsVars[rhsVars.length - 1]!;
      // The source must be borrowed (e.g., a parameter). If it's owning, the
      // lifetime isn't guaranteed by an external owner and we can't safely borrow.
      if (rhsVar.isOwningTheRcValue) {
        continue;
      }

      // Check that the initial assignment has a deferred dup
      if (
        !initialAssignRhsExpr.$?.deferredDupExpressions ||
        initialAssignRhsExpr.$.deferredDupExpressions.length === 0
      ) {
        continue;
      }

      // Safety check: verify varName is not returned or stored elsewhere
      // (it can be used in match as scrutinee and reassigned, but not escaped)
      // We check all children of the begin block EXCEPT:
      // - The initial assignment (whileIdx and before)
      // - The while loop (contains the expected uses)
      // - The final expression (return value of begin block — if it references varName, unsafe)
      let varEscapes = false;
      for (let i = whileIdx + 1; i < args.length; i++) {
        if (exprReferencesVariable(args[i]!, varName)) {
          varEscapes = true;
          break;
        }
      }
      if (varEscapes) {
        continue;
      }

      // All checks passed — perform the optimization

      // 1. Remove initial dup
      initialAssignRhsExpr.$.deferredDupExpressions = undefined;

      // 2. Remove reassignment dup
      reassignmentRhsExpr.$.deferredDupExpressions = undefined;

      // 3. Remove old-value save and drop
      // The assignment expression's $.variableName is the temp for saving old value
      const oldValueTempName = reassignmentAssignExpr.$?.variableName;
      if (oldValueTempName && branchBeginBlock.$?.deferredDropExpressions) {
        // Remove the drop expression for the old-value temp from the branch begin block
        branchBeginBlock.$.deferredDropExpressions =
          branchBeginBlock.$.deferredDropExpressions.filter((dropExpr) => {
            // Match drop expressions that target the old-value temp variable
            const targetName = getDropTargetName(dropExpr);
            return targetName !== oldValueTempName;
          });
        if (branchBeginBlock.$.deferredDropExpressions.length === 0) {
          branchBeginBlock.$.deferredDropExpressions = undefined;
        }
      }
      // Clear the save-old-value temp from the assignment expression
      if (reassignmentAssignExpr.$) {
        reassignmentAssignExpr.$.variableName = undefined;
      }

      // 4. Mark variable as consumed (scope-exit drop and before-return drops)
      const finalVars = getVariablesFromEnv(env, varName);
      if (finalVars.length > 0) {
        const finalVar = finalVars[finalVars.length - 1]!;
        env = updateExistingVariable(env, finalVar, {
          ...finalVar,
          consumedAtToken: finalVar.token,
        });
      }

      optimizedVarNames.add(varName);
    }
  }

  return { optimizedVarNames, env };
}

/**
 * Get the target variable name of a drop expression.
 * A drop expression is either `(varName.___drop)()` or `___drop(varName)`.
 */
function getDropTargetName(dropExpr: Expr): string | undefined {
  // Check: (varName.___drop)()
  if (
    exprIsFunctionCall(dropExpr) &&
    dropExpr.args.length === 0 &&
    exprIsFunctionCall(dropExpr.func) &&
    exprIsFunctionCallOf(dropExpr.func, ".", 2) &&
    exprIsAtom(dropExpr.func.args[1]!) &&
    dropExpr.func.args[1]!.token.value === BuiltinFunctions.___drop[0] &&
    exprIsAtom(dropExpr.func.args[0]!)
  ) {
    return dropExpr.func.args[0]!.token.value;
  }

  // Check: ___drop(varName)
  if (
    exprIsFunctionCall(dropExpr) &&
    exprIsFunctionCallOf(dropExpr, BuiltinFunctions.___drop) &&
    dropExpr.args.length >= 1 &&
    exprIsAtom(dropExpr.args[0]!)
  ) {
    return dropExpr.args[0]!.token.value;
  }
  return undefined;
}

/**
 * Check if an expression tree references a variable by name.
 * Used for escape analysis.
 */
function exprReferencesVariable(expr: Expr, varName: string): boolean {
  if (exprIsAtom(expr) && expr.token.value === varName) {
    return true;
  }
  if (exprIsFunctionCall(expr)) {
    if (exprReferencesVariable(expr.func, varName)) return true;
    for (const arg of expr.args) {
      if (exprReferencesVariable(arg, varName)) return true;
    }
  }
  return false;
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
  // When { expr } (without semicolons) is used as a function body, the parser
  // creates an anonymous struct _( expr ) instead of a begin block. Convert it
  // to a begin block so the last expression gets expectedType propagated correctly.
  // This fixes enum variant shorthand (e.g., .Ok(value)) not resolving inside
  // function bodies like: (fn() -> Result(i32, String))({ .Ok(i32(42)) })
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, "_") &&
    !exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    const fnCallExpr = expr as FnCallExpr;
    // Check that none of the args are labeled (: expressions) — if they are,
    // it's a real struct value like { x: 1, y: 2 }, not a begin block.
    const hasLabeledFields = fnCallExpr.args.some(
      (arg) => exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":")
    );
    if (!hasLabeledFields) {
      // Convert _( expr1, expr2, ... ) to begin( expr1, expr2, ... )
      fnCallExpr.func = {
        ...fnCallExpr.func,
        token: {
          ...(fnCallExpr.func as AtomExpr).token,
          value: BuiltinKeywords.begin[0]!,
        },
      } as AtomExpr;
    }
  }

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
  let hasRuntimeSideEffects = false;

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
      if (
        exprIsFunctionCall(exprToEvaluate) &&
        exprToEvaluate.args.length > 1
      ) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "return" keyword accepts at most one argument.`,
        });
      }

      if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "return" keyword can only be used inside a function body or async block.`,
        });
      }
      returnExpr = exprToEvaluate;

      if (
        exprIsAtom(exprToEvaluate) ||
        (exprIsFunctionCall(exprToEvaluate) && exprToEvaluate.args.length === 0)
      ) {
        // return; / return();
        // return unit
        exprToEvaluate.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          pathCollection: [],
          controlFlow: controlFlowOf("return"),
        };
        lastExpr = exprToEvaluate;
        break;
      } else {
        // return val;

        // Return the first argument
        // Evaluate the return expression
        if (!exprIsFunctionCall(exprToEvaluate)) {
          throw new Error(`Internal error: return expression is not a call`);
        }
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

        // Mark `&(ref-returning-call)` arguments to `return(...)` as
        // sitting in a return slot. The codegen for `&` then forwards
        // the inner pointer instead of spilling to a stack temp and
        // taking its address. See generateAddressOf in ptr-fns.ts.
        // Looks through a wrapping `unsafe(...)` (transparent at the
        // value level).
        {
          let candidate: Expr = evaluatedReturnArgExpr;
          while (
            exprIsFunctionCall(candidate) &&
            exprIsFunctionCallOf(candidate, BuiltinFunctions.unsafe, 1)
          ) {
            candidate = candidate.args[0]!;
          }
          if (
            exprIsFunctionCallOf(
              candidate,
              BuiltinFunctions.__yo_address_of,
              1
            ) &&
            candidate.$
          ) {
            candidate.$.isReturnSlot = true;
          }
        }

        // §4 escape boundary 1: function return type cannot be
        // control-bound. A control-bound type carries a control function
        // (transitively); returning it from a function takes the value
        // past its install frame, which is then dead — invoking it
        // later would unwind to a dead frame.
        //
        // Type-level check: `typeIsControlBound(returnType)` is true iff
        // the type contains a `ctl(...) -> ret` (directly or in a struct
        // field / tuple element / etc). This catches both bare CF
        // returns and aggregate-containing-CF returns.
        //
        // Carve-out: auto-generated derive functions (`___dup`, `___drop`,
        // `___dispose`, …) emit `return(__yo_self)` to satisfy their
        // signature. For struct types that transitively contain a `ctl`
        // field, these derive bodies trip the check at definition time
        // even though the function is never actually called for such
        // values at runtime (control-bound structs are stack-only and
        // skip RC). The token's `modulePath` starts with
        // `auto-generated://` for these expansions; skip the rule
        // there. User code on real source files still hits the check.
        {
          const returnedType = evaluatedReturnArgExpr.$?.type;
          if (
            returnedType &&
            typeIsControlBound(returnedType) &&
            !returnArg.token.modulePath.startsWith("auto-generated://")
          ) {
            throw formatErrorMessage({
              token: returnArg.token,
              errorMessage: `Cannot return a value whose type is control-bound (transitively contains a \`ctl(...) -> ret\` function type). Control-function values are stack-bound to their install frame; returning them lets them outlive that frame, and invoking them later would unwind to a dead frame.

Returned type: ${typeToString(returnedType)}

Install the handler at its use site instead:
  (raise : Raise) = ((msg) -> { unwind(...); });
  some_call(args, raise);`,
            });
          }
        }

        // plans/SLICE_FLOWABILITY.md Phase D — explicit `return(expr)`
        // inside a function whose declared return type carries a raw
        // pointer in its representation (Slice/str/struct-wrapping-slice,
        // etc.) must root the value in caller-owned storage. Matches the
        // function-return-position check in function-type.ts and
        // anonymous-function.ts.
        if (
          context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ) {
          const fnType = context.isEvaluatingFunctionBodyOrAsyncBlock.type;
          // (Ref-returning functions are banned at signature
          // evaluation, so only the raw-pointer-representation
          // rooting check remains for explicit `return(...)`.)
          if (
            !fnType.return.isCompileTimeOnly &&
            typeRepresentationContainsRawPtr(fnType.return.type) &&
            !isImplicitlyUnsafeCapableFile(returnArg.token.modulePath)
          ) {
            if (
              !isFlowableExpr(evaluatedReturnArgExpr, {
                allowParameterSource: true,
                allowComptimeSource: true,
              })
            ) {
              throw formatErrorMessage({
                token: returnArg.token,
                errorMessage: `'return(...)' from a function returning '${typeToString(fnType.return.type)}' carries a raw pointer in its representation; the returned value must be rooted in caller-owned storage. The returned expression is not flowable:\n  ${exprToString(returnArg)}\n\nFlowable sources: a 'ref'-bound parameter; a non-'ref' parameter (caller's value is alive across the call); a 'comptime' constant or string literal; '.field' on a flowable base; a call returning ref or slice with flowable arguments; or a 'cond'/'match' whose arms are all flowable.\n\nFixes:\n  - Take the source as a 'ref(name) : T' parameter and project a slice from it.\n  - Return an owned type ('ArrayList', 'String') instead — heap-allocated, no lifetime concern.\n  - Wrap unsafe construction in 'pragma(Pragma.AllowUnsafe);' at the file top if you genuinely need the raw form.`,
              });
            }
          }
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
          controlFlow: controlFlowOf("return"),
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
        controlFlow: controlFlowOf("break"),
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
        controlFlow: controlFlowOf("continue"),
      };
      lastExpr = exprToEvaluate;
      break;
    }
    // Check if it's the "unwind" keyword (ctl handler discontinue)
    else if (
      exprIsFunctionCall(exprToEvaluate) &&
      exprIsFunctionCallOf(exprToEvaluate, BuiltinKeywords.unwind)
    ) {
      if (
        i !== beginExpressions.length - 1 &&
        !(
          i === beginExpressions.length - 2 &&
          isUnitValueExpression(beginExpressions[beginExpressions.length - 1]!)
        )
      ) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "unwind" keyword can only be used as the last expression.`,
        });
      }

      if (!context.enclosingFunctionReturnType) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "unwind" keyword can only be used inside a function that has an enclosing function.`,
        });
      }

      returnExpr = exprToEvaluate;

      if (exprToEvaluate.args.length > 1) {
        throw formatErrorMessage({
          token: exprToEvaluate.token,
          errorMessage: `The "unwind" keyword accepts at most one argument.`,
        });
      }

      const unwindArg = exprToEvaluate.args[0];
      if (!unwindArg) {
        if (
          !isSomeType(context.enclosingFunctionReturnType) &&
          !areTypesCompatible(
            { type: context.enclosingFunctionReturnType, env },
            { type: VUnit.type, env }
          )
        ) {
          throw formatErrorMessage({
            token: exprToEvaluate.token,
            errorMessage: `Incompatible type for \`escape\` argument:
- Expected (enclosing function return type): ${typeToString(context.enclosingFunctionReturnType)}
- Got: ${typeToString(VUnit.type)}`,
          });
        }

        exprToEvaluate.$ = {
          env,
          type: VUnit.type,
          value: undefined,
          pathCollection: [],
          controlFlow: controlFlowOf("unwind"),
        };
        lastExpr = exprToEvaluate;
        break;
      }

      const evaluatedEscapeArgExpr = evaluateExpression({
        expr: unwindArg,
        env,
        context: {
          ...context,
          expectedType: {
            type: context.enclosingFunctionReturnType,
            env: env,
          },
        },
      });
      if (!evaluatedEscapeArgExpr.$) {
        throw formatErrorMessage({
          token: unwindArg.token,
          errorMessage: `Escape expression is not evaluated correctly:\n${exprToString(unwindArg)}`,
        });
      }

      exprToEvaluate.args[0] = evaluatedEscapeArgExpr;

      // Type-check against enclosingFunctionReturnType.
      // Skip when it is a SomeType (e.g., forall T hasn't resolved yet) —
      // the unwind value's type will determine the actual return type.
      if (
        !isSomeType(context.enclosingFunctionReturnType) &&
        !areTypesCompatible(
          {
            type: context.enclosingFunctionReturnType,
            env,
          },
          { type: evaluatedEscapeArgExpr.$.type, env }
        )
      ) {
        throw formatErrorMessage({
          token: unwindArg.token,
          errorMessage: `Incompatible type for \`escape\` argument:
- Expected (enclosing function return type): ${typeToString(context.enclosingFunctionReturnType)}
- Got: ${typeToString(evaluatedEscapeArgExpr.$.type)}`,
        });
      }

      attachTempVariableToExpr(evaluatedEscapeArgExpr, true);
      env = evaluatedEscapeArgExpr.$.env;

      exprToEvaluate.$ = {
        env,
        type: evaluatedEscapeArgExpr.$.type,
        value: evaluatedEscapeArgExpr.$.value,
        pathCollection: evaluatedEscapeArgExpr.$.pathCollection,
        variableName: evaluatedEscapeArgExpr.$.variableName,
        controlFlow: controlFlowOf("unwind"),
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

      // Track if any non-last expression is a runtime expression.
      // If so, the begin block has runtime side effects and should not
      // be folded to a compile-time value.
      if (i < beginExpressions.length - 1 && !hasRuntimeSideEffects) {
        if (evaluatedExpr.$?.value === undefined) {
          hasRuntimeSideEffects = true;
        }
        // := and = expressions always have $.value = VUnit (compile-time),
        // but they produce runtime side effects when their RHS is a runtime
        // expression. Check isCompileTimeOnlyAssignment which is set by the
        // assignment evaluator when the operation is provably compile-time.
        // This branch must take PRECEDENCE over the UnknownValue check
        // below: a comptime-only assignment in a comptime fn body carries a
        // typed unknown during the validation pass, and marking it runtime
        // broke every `comptime(ref(...))` function (CI unit-test catch).
        else if (
          exprIsFunctionCall(evaluatedExpr) &&
          (exprIsFunctionCallOf(evaluatedExpr, "=") ||
            exprIsFunctionCallOf(evaluatedExpr, ":="))
        ) {
          if (!evaluatedExpr.$.isCompileTimeOnlyAssignment) {
            hasRuntimeSideEffects = true;
          }
        }
        // For NON-assignment statements, only a CONCRETELY known value
        // proves the statement effect-free. An UnknownValue (e.g. a
        // runtime-condition cond over unit arms, which annotates itself
        // with a typed unknown) may execute anything at runtime — including
        // a conditional `return` — so folding the block to its tail value
        // would silently delete the statement
        // (issues/fixed/codegen-block-rhs-drops-nontail-statements.md).
        else if (isUnknownValue(evaluatedExpr.$.value)) {
          hasRuntimeSideEffects = true;
        }
      }

      if (hasAnyControlFlow(evaluatedExpr.$?.controlFlow)) {
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
  if (hasControlFlow(lastExpr.$.controlFlow, "return")) {
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
      if (
        returnValueExpr?.$?.type &&
        areTypesCompatible(
          { type: variable.type, env },
          { type: returnValueExpr.$.type, env }
        )
      ) {
        returnVariable = variable;
      }
    }
  }

  // When returning a variable from the current frame, mark it as consumed (ownership transfer)
  // When returning from an outer frame, call dup (borrowing)
  // Special case: own parameters (isOwningTheRcValue) in the parameter frame also transfer
  // ownership directly when returned from ANY nested begin block within the function body.
  // We identify own params by matching against the enclosing function's parameter list,
  // which works regardless of frame level differences caused by specialization.
  let directlyConsumedReturnVar: Variable | undefined = undefined;
  const funcCtx = context.isEvaluatingFunctionBodyOrAsyncBlock;
  const isOwnParamReturn =
    returnVariable?.isOwningTheRcValue &&
    !returnVariable.consumedAtToken &&
    funcCtx?.kind === "function-body" &&
    funcCtx.type.parameters.some(
      (p) => p.label === returnVariable!.name && p.isOwningTheRcValue
    );
  if (
    returnVariable?.isOwningTheRcValue &&
    (returnVariable.frameLevel === env.frames.length - 1 || isOwnParamReturn) &&
    !returnVariable.consumedAtToken
  ) {
    // Variable from current frame (or own parameter from parameter frame) -
    // transfer ownership by marking as consumed
    // Only track for escape drops if the type actually contains RC types and
    // is not an unresolved SomeType (matching getVariablesNeedingDrop filters).
    if (
      typeContainsRcType(returnVariable.type) &&
      !(
        isSomeType(returnVariable.type) &&
        !returnVariable.type.resolvedConcreteType &&
        returnVariable.type.requiredTraits.length === 0
      )
    ) {
      directlyConsumedReturnVar = returnVariable;
    }
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

    variablesNeedingDrop = variablesNeedingDrop.filter(
      (variable) => !variableIsCapturedByCurrentFunction(variable, context)
    );
    // Loop traversal borrow chain optimization:
    // Detect linked-list traversal patterns where a variable is initialized from a
    // parameter and reassigned inside a while-match loop from a field of itself.
    // These variables can safely borrow (no dup/drop needed) because the underlying
    // data structure is kept alive by the parameter.
    if (exprIsFunctionCall(expr)) {
      const loopOpt = optimizeLoopTraversalBorrowChain(expr, env);
      if (loopOpt.optimizedVarNames.size > 0) {
        env = loopOpt.env;
        // Remove optimized variables from variablesNeedingDrop
        variablesNeedingDrop = variablesNeedingDrop.filter(
          (v) => !loopOpt.optimizedVarNames.has(v.name)
        );
      }
    }

    // Optimization: Collect all dup calls using the existing infrastructure
    const dupCallsByBaseVariable = new Map<string, FnCallExpr[]>();
    // Track variables that have dups in some but not all branches - these should NOT be optimized
    const allVarsWithPartialBranchDups = new Set<string>();
    // Track which begin-block child index each dup expression belongs to
    const dupToChildIndex = new Map<FnCallExpr, number>();
    // Find the earliest child that contains a return expression.
    // If a variable's dup is in a later child, the early return path
    // won't execute the dup, so the scope-exit drop must be preserved.
    let earliestChildWithReturn = -1;

    // Scan through all expressions in the begin block to collect dup calls
    if (exprIsFunctionCall(expr)) {
      for (let childIdx = 0; childIdx < expr.args.length; childIdx++) {
        const arg = expr.args[childIdx]!;

        // Check if this child contains a return (or escape) expression
        if (earliestChildWithReturn < 0 && exprTreeContainsReturn(arg)) {
          earliestChildWithReturn = childIdx;
        }

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
              dupToChildIndex.set(dupExpr, childIdx);
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

    // Count consumed derived variables per base variable.
    // When a variable like v2 (derived from v via isOwningTheSameRcValueAs) is consumed
    // (e.g., by an `own` parameter), the dup that created v2's reference was transferred
    // to the callee. That dup cannot be paired with v's scope-end drop.
    const consumedDerivedCountByBase = new Map<string, number>();
    const topFrame = env.frames[env.frames.length - 1];
    if (topFrame) {
      for (const variable of topFrame.variables) {
        if (
          variable.consumedAtToken &&
          variable.isOwningTheSameRcValueAs &&
          typeContainsRcType(variable.type)
        ) {
          let base = variable as Variable;
          while (base.isOwningTheSameRcValueAs) {
            base = base.isOwningTheSameRcValueAs;
          }
          consumedDerivedCountByBase.set(
            base.id,
            (consumedDerivedCountByBase.get(base.id) ?? 0) + 1
          );
        }
      }
    }

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
        !isReferenceStructType(baseVariable.type) &&
        typeContainsRcType(baseVariable.type);

      // Check if this variable has dups in some but not all branches.
      // This happens when there's an early return in one branch that dups the variable,
      // but another branch doesn't dup it.
      // CONSERVATIVE: If partial branch dups exist, don't optimize this variable at all.
      // The early return branch needs the dup+drop, and optimizing the normal path
      // would leave the early return without proper cleanup.
      const hasPartialBranchDups = allVarsWithPartialBranchDups.has(baseId);

      // Check if a main-path dup is in a child that comes AFTER a child with an
      // early return. If so, the early return path never executes the dup, meaning
      // the variable's value is NOT transferred — it's still live and needs the
      // scope-exit drop. Don't cancel the dup+drop pair in this case.
      let hasReturnBeforeDup = false;
      if (earliestChildWithReturn >= 0 && dupCalls && dupCalls.length > 0) {
        for (const dupCallExpr of dupCalls) {
          const marker = dupCallExpr as FnCallExpr & {
            __isEarlyReturnDup?: boolean;
          };
          if (marker.__isEarlyReturnDup) continue;
          const childIdx = dupToChildIndex.get(dupCallExpr);
          if (childIdx !== undefined && childIdx > earliestChildWithReturn) {
            hasReturnBeforeDup = true;
            break;
          }
        }
      }

      if (
        dupCalls &&
        dupCalls.length > 0 &&
        !isValueTypeWithRCFields &&
        !hasPartialBranchDups &&
        !hasReturnBeforeDup
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

        // Subtract consumed derived variable count from runtimeDupCount.
        // When a derived variable (e.g., v2 from `v2 := v`) is consumed by an `own`
        // parameter or closure capture, the dup that created v2's reference was
        // transferred to the callee. It cannot be paired with the base variable's
        // scope-end drop — they represent different reference lifecycles.
        const consumedDups = consumedDerivedCountByBase.get(baseId) ?? 0;

        // Check if the base variable itself is consumed (e.g., by own parameter).
        // When `b := a` creates a derived copy and `a` is later consumed by
        // own(concat), the dup for b is essential — without it, `a` has rc=1
        // and the COW path would mutate in-place, corrupting `b`'s view.
        let baseConsumed = false;
        if (baseVariable !== variable && topFrame) {
          for (const v of topFrame.variables) {
            if (v.id === baseId && v.consumedAtToken) {
              baseConsumed = true;
              break;
            }
          }
        }

        if (consumedDups > 0 || baseConsumed) {
          // Don't optimize when there are consumed derived variables,
          // or when the base variable itself is consumed.
          // The dups for derived copies are needed to maintain correct RC.
          variablesActuallyNeedingDrop.push(variable);
        } else if (runtimeDupCount <= 1) {
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
          //
          // Record the consume point at the cancelled dup's USE SITE when
          // there is exactly one regular runtime dup: from that point on,
          // ownership lives in the dup's consumer (e.g. a struct literal
          // the variable was moved into), so early returns AFTER it must
          // not receive an early-return-only drop for this variable —
          // doing so double-freed the moved value (the consumer's dispose
          // drops it again). Early returns BEFORE the transfer still fall
          // inside the [init, consume) window and keep their drop. With a
          // branch-group dup (or no runtime dup at all) the transfer point
          // is not a single source location — keep the end-of-scope token,
          // which preserves the drop on every early return.
          let consumeSiteToken = lastExpr.token;
          if (runtimeDupCount === 1 && branchGroups.length === 0) {
            const regularDup = allDupExprsToRemove.find(
              (dupExpr) =>
                !(dupExpr as FnCallExpr & { __isEarlyReturnDup?: boolean })
                  .__isEarlyReturnDup
            ) as (FnCallExpr & { __useSiteToken?: Token }) | undefined;
            if (regularDup?.__useSiteToken) {
              consumeSiteToken = regularDup.__useSiteToken;
            }
          }
          env = updateExistingVariable(env, variable, {
            ...variable,
            consumedAtToken: consumeSiteToken,
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
  let consumedVariableDropExpressions: Expr[] | undefined = undefined;

  if (exprIsFunctionCall(expr) && env.frames.length > 0) {
    const currentFrameForEarlyReturns = env.frames[env.frames.length - 1]!;
    const regularDropIds = new Set(
      (OPTIMIZE_DUP_AND_DROP_PAIRS
        ? variablesActuallyNeedingDrop
        : variablesNeedingDrop
      ).map((variable) => variable.id)
    );
    const earlyReturnOnlyVariables: Variable[] = [];

    for (const variable of currentFrameForEarlyReturns.variables) {
      if (!variable.consumedAtToken) continue;
      if (!variable.initializedAtToken) continue;
      if (!tokenIsAtOrBefore(expr.token, variable.initializedAtToken)) continue;
      if (variableIsCapturedByCurrentFunction(variable, context)) continue;
      if (variable.token.modulePath.startsWith("auto-generated://")) continue;
      if (regularDropIds.has(variable.id)) continue;
      if (!variableCanNeedDropIgnoringConsumed(variable)) continue;
      earlyReturnOnlyVariables.push(variable);
    }

    if (earlyReturnOnlyVariables.length > 0) {
      let tempEnv = env;
      for (const variable of earlyReturnOnlyVariables) {
        tempEnv = updateExistingVariable(tempEnv, variable, {
          ...variable,
          consumedAtToken: undefined,
        });
      }

      const earlyDropResult = generateDeferredDropExpressions({
        variablesToDrop: earlyReturnOnlyVariables,
        env: tempEnv,
        context: {
          ...context,
          expectedType: undefined,
        },
      });
      const earlyDrops = earlyDropResult.deferredDropExpressions;
      if (earlyDrops) {
        for (let i = 0; i < earlyReturnOnlyVariables.length; i++) {
          const variable = earlyReturnOnlyVariables[i]!;
          const dropExpr = earlyDrops[i];
          if (!dropExpr) continue;
          for (const arg of expr.args) {
            attachEarlyReturnOnlyDropExpressionToReturns(
              arg,
              variable,
              dropExpr
            );
          }
        }
      }
    }
  }

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

  // Generate drops for the directly-consumed return variable.
  // When a variable is directly returned (e.g., `return out`), it's consumed
  // (ownership transferred to caller) and excluded from variablesNeedingDrop.
  // On normal return, the caller takes ownership — no drop needed.
  // On unwind propagation, the return value is discarded — the variable leaks
  // unless we explicitly drop it.
  //
  // NOTE: We do NOT include variables consumed by the dup/drop optimization
  // (e.g., variables captured by closures or moved into struct fields).
  // Those consumers are themselves dropped via normal deferred drops on escape,
  // which handles decrementing the refcount. Adding consumed var drops for those
  // would cause use-after-free (the consumer still holds a reference).
  if (OPTIMIZE_DUP_AND_DROP_PAIRS && directlyConsumedReturnVar) {
    // Temporarily unconsume the variable so the evaluator doesn't reject
    // the drop as "use of moved value".
    const tempEnv = updateExistingVariable(env, directlyConsumedReturnVar, {
      ...directlyConsumedReturnVar,
      consumedAtToken: undefined,
    });
    try {
      const consumedDropResult = generateDeferredDropExpressions({
        variablesToDrop: [directlyConsumedReturnVar],
        env: tempEnv,
        context: {
          ...context,
          expectedType: undefined,
        },
      });
      consumedVariableDropExpressions =
        consumedDropResult.deferredDropExpressions;
    } catch {
      // ___drop not resolvable for this type — skip
    }
    // Don't use the env from consumed drops — keep the original where it's consumed.
  }

  // For returns from nested blocks inside function bodies, also drop alive
  // own parameters from the parameter frame. When an own parameter is used as
  // a struct field in a return expression (e.g., `return PopResult(vec: self, ...)`),
  // the struct constructor dups the parameter. The dup needs a matching drop.
  // This doesn't apply to the function body begin block (handled by the
  // parameters frame check above) or to direct own parameter returns (already
  // consumed by directlyConsumedReturnVar).
  if (
    returnExpr &&
    !isEvaluatingFunctionBodyBeginBlock &&
    funcCtx?.kind === "function-body"
  ) {
    const ownParamsToDrop: Variable[] = [];
    for (const param of funcCtx.type.parameters) {
      if (param.isOwningTheRcValue && param.label) {
        const vars = getVariablesFromEnv(env, param.label);
        const v = vars[vars.length - 1];
        if (
          v &&
          !v.consumedAtToken &&
          v.isOwningTheRcValue &&
          typeContainsRcType(v.type)
        ) {
          ownParamsToDrop.push(v);
        }
      }
    }
    if (ownParamsToDrop.length > 0) {
      try {
        const ownParamDropResult = generateDeferredDropExpressions({
          variablesToDrop: ownParamsToDrop,
          env,
          context: {
            ...context,
            expectedType: undefined,
          },
        });
        const newDrops = ownParamDropResult.deferredDropExpressions;
        if (newDrops && newDrops.length > 0) {
          deferredDropExpressions = deferredDropExpressions
            ? [...deferredDropExpressions, ...newDrops]
            : newDrops;
        }
      } catch {
        // ___drop not resolvable — skip
      }
    }
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
    // If any non-last expression is a runtime expression, the begin block
    // has runtime side effects and must not be folded to a compile-time value.
    value: hasRuntimeSideEffects ? undefined : lastExpr.$.value,
    pathCollection: [],
    controlFlow: lastExpr.$.controlFlow,
    deferredDropExpressions,
    consumedVariableDropExpressions,
    poppedEnvFrame: currentFrame,
    // Propagate comptimeRef from the last expression so that
    // &(begin(self.x)) can create compile-time pointers via ComptimeIndex.
    comptimeRef: lastExpr.$.comptimeRef,
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
