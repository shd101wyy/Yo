/**
 * await-analysis.ts
 *
 * Analyzes async function bodies to identify await points and local variables
 * that need to be captured in state machine structs.
 */

import { getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import { TokenType } from "../../token";
import { Type } from "../../types";
import { FutureType } from "../../types/definitions";
import { TypeTag } from "../../types/tags";

/**
 * Information about a single await expression found in an async function.
 */
export interface AwaitPoint {
  /**
   * The index of this await point (0-based)
   */
  index: number;

  /**
   * The await expression itself
   */
  expr: Expr;

  /**
   * The type of the value being awaited (the T in Future(T))
   */
  resultType: Type;

  /**
   * The variable that should receive the await result (if any)
   * This is the variable ID from the captured variables
   */
  targetVariableId?: string;

  /**
   * The variable ID of the Future being awaited
   * This is used to reference the captured Future variable instead of creating a separate await_future_X field
   */
  futureVariableId?: string;

  /**
   * Whether this await is inside a cond expression
   * If true, the state machine needs a cond_branch_X field to track which branch was taken
   */
  isInsideCond?: boolean;

  /**
   * Whether this await is inside a while loop
   * If true, the state machine needs a while_loop_X_active field to track loop state
   */
  isInsideWhile?: boolean;
}

/**
 * Information about a local variable that needs to persist across await points.
 */
export interface CapturedVariable {
  /**
   * The unique ID of the variable
   */
  id: string;

  /**
   * The name of the variable
   */
  name: string;

  /**
   * The type of the variable
   */
  type: Type;

  /**
   * The kind of variable being captured
   * - "local": A variable defined in the async function body (uses var_{id} field naming)
   * - "outer": A variable captured from outer scope (uses variable name as field name)
   */
  kind: "local" | "outer";

  /**
   * If this variable is borrowing an Ref value from another variable,
   * this field holds a reference to the owner variable.
   * This is used to resolve temporary variable names in deferred drops.
   */
  isOwningTheSameRefValueAs: CapturedVariable | undefined;
}

/**
 * Result of analyzing an async function for await points.
 */
export interface AwaitAnalysisResult {
  /**
   * All await points found in the function, in order of appearance
   */
  awaitPoints: AwaitPoint[];

  /**
   * All local variables that need to be captured in the state machine
   */
  capturedVariables: CapturedVariable[];

  /**
   * Whether this function contains any await expressions
   */
  hasAwaits: boolean;
}

/**
 * Analyzes an async function body to find all await expressions.
 *
 * @param body The function body expression
 * @returns Analysis result containing await points and captured variables
 */
export function analyzeAwaitPoints(body: Expr): AwaitAnalysisResult {
  const awaitPoints: AwaitPoint[] = [];
  const capturedVariables = new Map<string, CapturedVariable>();

  // Walk the expression tree and collect await points
  walkExprForAwaits(body, awaitPoints, capturedVariables);

  // Also walk through deferred drop expressions to capture variables referenced there
  if (body.$?.deferredDropExpressions) {
    for (const dropExpr of body.$.deferredDropExpressions) {
      walkExprForAwaits(dropExpr, awaitPoints, capturedVariables);
    }
  }

  // If there are no await points, we don't need to capture any variables
  // since everything executes in a single state (state 0)
  if (awaitPoints.length === 0) {
    capturedVariables.clear();
  }

  return {
    awaitPoints,
    capturedVariables: Array.from(capturedVariables.values()),
    hasAwaits: awaitPoints.length > 0,
  };
}

/**
 * Recursively walks an expression tree to find await expressions.
 */
function walkExprForAwaits(
  expr: Expr,
  awaitPoints: AwaitPoint[],
  capturedVariables: Map<string, CapturedVariable>,
  parentExpr?: Expr
): void {
  switch (expr.tag) {
    case ExprTag.Atom:
      // Check if this is an atom that references a local variable
      if (expr.$ && expr.token.type === TokenType.Identifier) {
        const varName = expr.token.value;
        const varType = expr.$.type;

        // Check if this variable should be captured in the state machine
        const variables = getVariablesFromEnv(expr.$.env, varName);
        if (variables.length > 0) {
          // Use the last element (most recent scope)
          const variable = variables[variables.length - 1]!;

          // In state machines, we need to capture ALL local variables that are used
          // across await points, regardless of whether they're borrowing or owning.
          // This includes:
          // - Variables owning Ref values
          // - Variables borrowing Ref values (like task1_future, task2_future)
          // - Temp variables owning Ref values
          // - Non-Ref variables (primitives, etc.)
          // But skip compile-time-only values (types, compile-time functions, etc.)
          if (
            variable &&
            !capturedVariables.has(variable.id) &&
            !variable.isCompileTimeOnly
          ) {
            // Check if this variable is borrowing from another variable
            if (variable.isOwningTheSameRefValueAs) {
              const ownerVar = variable.isOwningTheSameRefValueAs;
              // Only capture the owner variable, not the borrower
              // The borrower is just an alias and doesn't need separate storage
              if (!capturedVariables.has(ownerVar.id)) {
                const ownerCaptured: CapturedVariable = {
                  id: ownerVar.id,
                  name: ownerVar.name,
                  type: ownerVar.type,
                  kind: "local",
                  isOwningTheSameRefValueAs: undefined,
                };
                capturedVariables.set(ownerVar.id, ownerCaptured);
              }
              // Don't capture the borrower itself - it's just an alias
            } else {
              // Variable is not borrowing - capture it normally
              capturedVariables.set(variable.id, {
                id: variable.id,
                name: varName,
                type: varType,
                kind: "local",
                isOwningTheSameRefValueAs: undefined,
              });
            }
          }
        }
      }
      break;

    case ExprTag.FuncCall: {
      // Check if this is a while loop - handle specially
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
        // For while loops, awaits in the loop body need special handling
        const initialAwaitCount = awaitPoints.length;

        // Walk through the condition and body
        walkExprForAwaits(expr.func, awaitPoints, capturedVariables, expr);
        for (const arg of expr.args) {
          walkExprForAwaits(arg, awaitPoints, capturedVariables, expr);
        }

        // Mark all awaits found in this while loop as isInsideWhile
        const newAwaitCount = awaitPoints.length;
        if (newAwaitCount > initialAwaitCount) {
          for (let i = initialAwaitCount; i < newAwaitCount; i++) {
            awaitPoints[i]!.isInsideWhile = true;
          }
        }
        break;
      }
      // Check if this is a cond expression - handle specially
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
        // For cond expressions, all awaits in branches are mutually exclusive
        // They should share the same await index
        const initialAwaitCount = awaitPoints.length;

        // Walk through all branches
        walkExprForAwaits(expr.func, awaitPoints, capturedVariables, expr);
        for (const arg of expr.args) {
          walkExprForAwaits(arg, awaitPoints, capturedVariables, expr);
        }

        // If multiple await points were added, merge them to use the same index
        // and mark them as inside cond
        const newAwaitCount = awaitPoints.length;
        if (newAwaitCount > initialAwaitCount) {
          // Mark all awaits found in this cond as isInsideCond
          for (let i = initialAwaitCount; i < newAwaitCount; i++) {
            awaitPoints[i]!.isInsideCond = true;
          }

          if (newAwaitCount > initialAwaitCount + 1) {
            // Multiple awaits were found in branches - make them share the same index
            const firstAwaitIndex = initialAwaitCount;
            for (let i = initialAwaitCount + 1; i < newAwaitCount; i++) {
              awaitPoints[i]!.index = firstAwaitIndex;
            }
            // Remove duplicate entries, keeping only the first one
            awaitPoints.splice(
              initialAwaitCount + 1,
              newAwaitCount - initialAwaitCount - 1
            );
          }
        }
        break;
      }

      // Check if this is a match expression - handle specially
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
        // For match expressions, all awaits in branches are mutually exclusive
        // They should share the same await index
        const initialAwaitCount = awaitPoints.length;

        // Walk through all branches
        walkExprForAwaits(expr.func, awaitPoints, capturedVariables, expr);
        for (const arg of expr.args) {
          walkExprForAwaits(arg, awaitPoints, capturedVariables, expr);
        }

        // If multiple await points were added, merge them to use the same index
        // and mark them as inside match
        const newAwaitCount = awaitPoints.length;
        if (newAwaitCount > initialAwaitCount) {
          // Mark all awaits found in this match as isInsideMatch
          for (let i = initialAwaitCount; i < newAwaitCount; i++) {
            // Use isInsideCond since match branches work similarly to cond branches
            awaitPoints[i]!.isInsideCond = true;
          }

          if (newAwaitCount > initialAwaitCount + 1) {
            // Multiple awaits were found in branches - make them share the same index
            const firstAwaitIndex = initialAwaitCount;
            for (let i = initialAwaitCount + 1; i < newAwaitCount; i++) {
              awaitPoints[i]!.index = firstAwaitIndex;
            }
            // Remove duplicate entries, keeping only the first one
            awaitPoints.splice(
              initialAwaitCount + 1,
              newAwaitCount - initialAwaitCount - 1
            );
          }
        }
        break;
      }

      // Check if this is an await call
      if (isAwaitCall(expr)) {
        // This is an await expression
        const awaitArg = expr.args[0];
        if (!awaitArg) {
          break;
        }

        const futureType = awaitArg.$?.type;

        if (futureType && futureType.tag === TypeTag.Future) {
          const ft = futureType as FutureType;

          // Get the Future variable ID from the await argument
          let futureVariableId: string | undefined;
          if (
            awaitArg.tag === ExprTag.Atom &&
            awaitArg.token.type === TokenType.Identifier &&
            awaitArg.$
          ) {
            const futureVarName = awaitArg.token.value;
            const futureVariables = getVariablesFromEnv(
              awaitArg.$.env,
              futureVarName
            );
            if (futureVariables.length > 0) {
              const futureVar = futureVariables[futureVariables.length - 1]!;
              // If the Future variable is borrowing from another variable, use the owner's ID
              // This ensures we reference the correct field in the state machine struct
              if (futureVar.isOwningTheSameRefValueAs) {
                futureVariableId = futureVar.isOwningTheSameRefValueAs.id;
              } else {
                futureVariableId = futureVar.id;
              }
            }
          }

          // Check if parent is an assignment to capture target variable
          let targetVariableId: string | undefined;
          if (
            parentExpr &&
            parentExpr.tag === ExprTag.FuncCall &&
            exprIsFunctionCallOf(parentExpr, ":=")
          ) {
            const varExpr = parentExpr.args[0];
            if (
              varExpr &&
              varExpr.tag === ExprTag.Atom &&
              varExpr.token.type === TokenType.Identifier
            ) {
              const varName = varExpr.token.value;
              if (varExpr.$) {
                const variables = getVariablesFromEnv(varExpr.$.env, varName);
                if (variables.length > 0) {
                  targetVariableId = variables[variables.length - 1]!.id;
                }
              }
            }
          }

          awaitPoints.push({
            index: awaitPoints.length,
            expr,
            resultType: ft.childType,
            targetVariableId,
            futureVariableId,
          });
        }
      }

      // Recursively walk the function and arguments, passing current expr as parent
      walkExprForAwaits(expr.func, awaitPoints, capturedVariables, expr);
      for (const arg of expr.args) {
        walkExprForAwaits(arg, awaitPoints, capturedVariables, expr);
      }
      break;
    }
  }
}

/**
 * Checks if an expression is an await function call.
 */
function isAwaitCall(expr: Expr): boolean {
  return exprIsFunctionCallOf(expr, BuiltinFunctions.await);
}

/**
 * Gets the local variable declarations from a function body.
 * This captures variables that are defined within the function scope.
 */
export function getLocalVariablesFromBody(body: Expr): CapturedVariable[] {
  const variables: CapturedVariable[] = [];
  const seen = new Set<string>();

  // Walk the expression and collect variable bindings
  collectVariableBindings(body, variables, seen);

  return variables;
}

/**
 * Recursively collects variable bindings from an expression.
 */
function collectVariableBindings(
  expr: Expr,
  variables: CapturedVariable[],
  seen: Set<string>
): void {
  switch (expr.tag) {
    case ExprTag.Atom:
      // Atoms don't introduce new bindings
      break;

    case ExprTag.FuncCall: {
      // Check if this is a let binding or variable declaration
      const func = expr.func;
      if (func.tag === ExprTag.Atom) {
        const funcName = func.token.value;

        // Handle let bindings: let(name, value, body)
        if (funcName === "let" && expr.args.length >= 2) {
          const nameArg = expr.args[0];
          if (nameArg && nameArg.tag === ExprTag.Atom && nameArg.$) {
            const varName = nameArg.token.value;
            const varType = expr.args[1]?.$?.type;

            if (varType) {
              const vars = getVariablesFromEnv(nameArg.$.env, varName);
              if (vars.length > 0) {
                // Use the last element (most recent scope)
                const variable = vars[vars.length - 1];
                if (
                  variable &&
                  !variable.isOwningTheSameRefValueAs &&
                  !variable.isCompileTimeOnly &&
                  !seen.has(variable.id)
                ) {
                  variables.push({
                    id: variable.id,
                    name: varName,
                    type: varType,
                    kind: "local",
                    isOwningTheSameRefValueAs: undefined,
                  });
                  seen.add(variable.id);
                }
              }
            }
          }
        }

        // Handle variable assignments: :=(name, value)
        if (funcName === ":=" && expr.args.length >= 2) {
          const nameArg = expr.args[0];
          if (nameArg && nameArg.tag === ExprTag.Atom && nameArg.$) {
            const varName = nameArg.token.value;
            const varType = expr.args[1]?.$?.type;

            if (varType) {
              const vars = getVariablesFromEnv(nameArg.$.env, varName);
              if (vars.length > 0) {
                // Use the last element (most recent scope)
                const variable = vars[vars.length - 1];
                if (
                  variable &&
                  !variable.isOwningTheSameRefValueAs &&
                  !variable.isCompileTimeOnly &&
                  !seen.has(variable.id)
                ) {
                  variables.push({
                    id: variable.id,
                    name: varName,
                    type: varType,
                    kind: "local",
                    isOwningTheSameRefValueAs: undefined,
                  });
                  seen.add(variable.id);
                }
              }
            }
          }
        }
      }

      // Recursively walk arguments
      collectVariableBindings(expr.func, variables, seen);
      for (const arg of expr.args) {
        collectVariableBindings(arg, variables, seen);
      }
      break;
    }
  }
}
