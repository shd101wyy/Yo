/**
 * await-analysis.ts
 *
 * Analyzes async function bodies to identify await points and local variables
 * that need to be captured in state machine structs.
 *
 * This is a thin wrapper around the shared suspension-point analysis,
 * providing the async-specific suspension point detection (io.await/io.join).
 */

import { getVariablesFromEnv } from "../../env";
import { type Expr, ExprTag } from "../../expr";
import { TokenType } from "../../token";
import { createUnitType } from "../../types/creators";
import type { Type } from "../../types/definitions";

import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../trait-checking";
import {
  analyzeSuspensionPoints,
  extractTargetVariableId,
  type SuspensionPointDetector,
} from "../shared/suspension-analysis";

// Re-export types from the types file
export type {
  AwaitAnalysisResult,
  AwaitPoint,
  CapturedVariable,
} from "./await-analysis-types";

import type {
  AwaitAnalysisResult,
  AwaitPoint,
  CapturedVariable,
} from "./await-analysis-types";

/**
 * Analyzes an async function body to find all await expressions.
 *
 * @param body The function body expression
 * @returns Analysis result containing await points and captured variables
 */
export function analyzeAwaitPoints(body: Expr): AwaitAnalysisResult {
  const detector: SuspensionPointDetector<AwaitPoint> = {
    detect(expr, parentExpr, points) {
      if (expr.tag !== ExprTag.FnCall) return;

      // Check if this is an await call
      if (isIoAwaitCall(expr)) {
        const awaitArg = expr.args[0];
        if (!awaitArg) return;

        const futureType = awaitArg.$?.type;
        if (futureType && typeImplementsFuture(futureType)) {
          const futureModuleType = extractFutureTraitFromType(futureType);
          if (!futureModuleType) return;

          const resultType = futureModuleType.isFuture.outputType;

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
              if (futureVar.isOwningTheSameRcValueAs) {
                futureVariableId = futureVar.isOwningTheSameRcValueAs.id;
              } else {
                futureVariableId = futureVar.id;
              }
            }
          }

          const targetVariableId = extractTargetVariableId(parentExpr);

          points.push({
            index: points.length,
            expr,
            resultType,
            futureType: futureModuleType,
            targetVariableId,
            futureVariableId,
          });
        }
      }

      // Check if this is a join call
      if (isIoJoinCall(expr)) {
        const joinFutureVariableIds: string[] = [];
        const joinFutureTypes: Type[] = [];
        let allArgsAreFutures = true;

        for (const arg of expr.args) {
          const argFutureType = arg.$?.type;
          if (!argFutureType || !typeImplementsFuture(argFutureType)) {
            allArgsAreFutures = false;
            break;
          }

          const futureModuleType = extractFutureTraitFromType(argFutureType);
          if (!futureModuleType) {
            allArgsAreFutures = false;
            break;
          }

          joinFutureTypes.push(argFutureType);

          let futureVariableId: string | undefined;
          if (
            arg.tag === ExprTag.Atom &&
            arg.token.type === TokenType.Identifier &&
            arg.$
          ) {
            const futureVarName = arg.token.value;
            const futureVariables = getVariablesFromEnv(
              arg.$.env,
              futureVarName
            );
            if (futureVariables.length > 0) {
              const futureVar = futureVariables[futureVariables.length - 1]!;
              if (futureVar.isOwningTheSameRcValueAs) {
                futureVariableId = futureVar.isOwningTheSameRcValueAs.id;
              } else {
                futureVariableId = futureVar.id;
              }
            }
          }

          if (futureVariableId) {
            joinFutureVariableIds.push(futureVariableId);
          } else {
            allArgsAreFutures = false;
            break;
          }
        }

        if (allArgsAreFutures && joinFutureVariableIds.length > 0) {
          points.push({
            index: points.length,
            expr,
            resultType: createUnitType(),
            isJoinPoint: true,
            joinFutureVariableIds,
            joinFutureCount: expr.args.length,
            joinFutureTypes,
          });
        }
      }
    },

    shouldSkipBody(expr) {
      return isIoAsyncCall(expr);
    },
  };

  const result = analyzeSuspensionPoints(body, detector);

  // Map shared captured variables to CapturedVariable (adding kind: "local")
  const capturedVariables: CapturedVariable[] = result.capturedVariables.map(
    (v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      kind: "local" as const,
      isOwningTheSameRcValueAs: undefined,
    })
  );

  return {
    awaitPoints: result.suspensionPoints,
    capturedVariables,
    hasAwaits: result.hasSuspensions,
    variableIdRemapping: result.variableIdRemapping,
  };
}

// --- IO builtin checks (kept here since they're imported by many codegen files) ---

/**
 * Checks if an expression is an io.async(closure) call.
 * Uses the ioBuiltin marker on the callee's type.
 */
export function isIoAsyncCall(expr: Expr): boolean {
  if (expr.tag !== ExprTag.FnCall) return false;
  return expr.func.$?.type?.ioBuiltin === "io_async";
}

/**
 * Checks if an expression is an io.await(future) call.
 * Uses the ioBuiltin marker on the callee's type.
 */
export function isIoAwaitCall(expr: Expr): boolean {
  if (expr.tag !== ExprTag.FnCall) return false;
  return expr.func.$?.type?.ioBuiltin === "io_await";
}

/**
 * Checks if an expression is an io.join(...) call.
 * Uses the ioBuiltin marker on the callee's type.
 */
export function isIoJoinCall(expr: Expr): boolean {
  if (expr.tag !== ExprTag.FnCall) return false;
  return expr.func.$?.type?.ioBuiltin === "io_join";
}

// --- Local variable collection (used by async codegen, not part of suspension analysis) ---

/**
 * Gets the local variable declarations from a function body.
 * This captures variables that are defined within the function scope.
 */
export function getLocalVariablesFromBody(body: Expr): CapturedVariable[] {
  const variables: CapturedVariable[] = [];
  const seen = new Set<string>();

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
      break;

    case ExprTag.FnCall: {
      const func = expr.func;
      if (func.tag === ExprTag.Atom) {
        const funcName = func.token.value;

        if (funcName === "let" && expr.args.length >= 2) {
          const nameArg = expr.args[0];
          if (nameArg && nameArg.tag === ExprTag.Atom && nameArg.$) {
            const varName = nameArg.token.value;
            const varType = expr.args[1]?.$?.type;

            if (varType) {
              const vars = getVariablesFromEnv(nameArg.$.env, varName);
              if (vars.length > 0) {
                const variable = vars[vars.length - 1];
                if (
                  variable &&
                  !variable.isOwningTheSameRcValueAs &&
                  !variable.isCompileTimeOnly &&
                  !seen.has(variable.id)
                ) {
                  variables.push({
                    id: variable.id,
                    name: varName,
                    type: varType,
                    kind: "local",
                    isOwningTheSameRcValueAs: undefined,
                  });
                  seen.add(variable.id);
                }
              }
            }
          }
        }

        if (funcName === ":=" && expr.args.length >= 2) {
          const nameArg = expr.args[0];
          if (nameArg && nameArg.tag === ExprTag.Atom && nameArg.$) {
            const varName = nameArg.token.value;
            const varType = expr.args[1]?.$?.type;

            if (varType) {
              const vars = getVariablesFromEnv(nameArg.$.env, varName);
              if (vars.length > 0) {
                const variable = vars[vars.length - 1];
                if (
                  variable &&
                  !variable.isOwningTheSameRcValueAs &&
                  !variable.isCompileTimeOnly &&
                  !seen.has(variable.id)
                ) {
                  variables.push({
                    id: variable.id,
                    name: varName,
                    type: varType,
                    kind: "local",
                    isOwningTheSameRcValueAs: undefined,
                  });
                  seen.add(variable.id);
                }
              }
            }
          }
        }
      }

      collectVariableBindings(expr.func, variables, seen);
      for (const arg of expr.args) {
        collectVariableBindings(arg, variables, seen);
      }
      break;
    }
  }
}
