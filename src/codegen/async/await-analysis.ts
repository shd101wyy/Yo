/**
 * await-analysis.ts
 *
 * Analyzes async function bodies to identify await points and local variables
 * that need to be captured in state machine structs.
 */

import { getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
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
          // But skip compile-time-only values (types, compile-time functions, etc.)
          if (
            variable &&
            !capturedVariables.has(variable.id) &&
            !variable.isCompileTimeOnly
          ) {
            {
              // Variable is not borrowing - capture it normally
              capturedVariables.set(variable.id, {
                id: variable.id,
                name: varName,
                type: varType,
                kind: "local",
              });
            }
          }
        }
      }
      break;

    case ExprTag.FuncCall: {
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
              futureVariableId = futureVar.id;
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
                  !variable.isCompileTimeOnly &&
                  !seen.has(variable.id)
                ) {
                  variables.push({
                    id: variable.id,
                    name: varName,
                    type: varType,
                    kind: "local",
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
                  !variable.isCompileTimeOnly &&
                  !seen.has(variable.id)
                ) {
                  variables.push({
                    id: variable.id,
                    name: varName,
                    type: varType,
                    kind: "local",
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
