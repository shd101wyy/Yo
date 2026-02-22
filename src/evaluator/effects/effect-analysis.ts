/**
 * effect-analysis.ts
 *
 * Analyzes function bodies to identify ctl effect call points and local variables
 * that need to be captured in state machine structs.
 *
 * This is analogous to await-analysis.ts but for algebraic effects (ctl/resume).
 * When a function body calls a ctl operation (e.g., raise(msg)), the function
 * needs to be transformed into a state machine that can suspend at those points.
 */

import { getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import { TokenType } from "../../token";
import { isFunctionType } from "../../types/guards";

export type {
  EffectAnalysisResult,
  EffectCallPoint,
  EffectCapturedVariable,
} from "./effect-analysis-types";

import type { FunctionType, Type } from "../../types/definitions";
import type {
  EffectAnalysisResult,
  EffectCallPoint,
  EffectCapturedVariable,
} from "./effect-analysis-types";

/**
 * Analyzes a function body to find all effect call points.
 *
 * An effect call point is a call to a variable whose handler function value
 * has isControlFunction: true (set when the handler body uses `abort`).
 * These are analogous to await points in async functions.
 *
 * @param body The function body expression
 * @param effectParameterName The name of the ctl parameter (e.g., "raise")
 * @param effectParameterType The type of the ctl parameter
 * @returns Analysis result containing effect call points and captured variables
 */
export function analyzeEffectCallPoints(
  body: Expr,
  effectParameterName: string,
  effectParameterType: Type,
  includeTransitiveCalls: boolean = false,
  effectFieldPath?: string[]
): EffectAnalysisResult {
  const effectCallPoints: EffectCallPoint[] = [];
  const capturedVariables = new Map<string, EffectCapturedVariable>();
  const nameFrameToOriginalId = new Map<string, string>();
  const variableIdRemapping = new Map<string, string>();

  walkExprForEffects(
    body,
    effectCallPoints,
    capturedVariables,
    nameFrameToOriginalId,
    variableIdRemapping,
    effectParameterName,
    effectParameterType,
    includeTransitiveCalls,
    effectFieldPath
  );

  if (body.$?.deferredDropExpressions) {
    for (const dropExpr of body.$.deferredDropExpressions) {
      walkExprForEffects(
        dropExpr,
        effectCallPoints,
        capturedVariables,
        nameFrameToOriginalId,
        variableIdRemapping,
        effectParameterName,
        effectParameterType,
        includeTransitiveCalls,
        effectFieldPath
      );
    }
  }

  if (effectCallPoints.length === 0) {
    capturedVariables.clear();
  }

  return {
    effectCallPoints,
    capturedVariables: Array.from(capturedVariables.values()),
    hasEffects: effectCallPoints.length > 0,
    variableIdRemapping,
    effectParameterName,
    effectParameterType,
    effectFieldPath,
  };
}

/**
 * Recursively walks an expression tree to find ctl effect call points.
 */
function walkExprForEffects(
  expr: Expr,
  effectCallPoints: EffectCallPoint[],
  capturedVariables: Map<string, EffectCapturedVariable>,
  nameFrameToOriginalId: Map<string, string>,
  variableIdRemapping: Map<string, string>,
  effectParameterName: string,
  effectParameterType: Type,
  includeTransitiveCalls: boolean,
  effectFieldPath: string[] | undefined,
  parentExpr?: Expr
): void {
  switch (expr.tag) {
    case ExprTag.Atom:
      if (expr.$ && expr.token.type === TokenType.Identifier) {
        const varName = expr.token.value;
        const varType = expr.$.type;
        const variables = getVariablesFromEnv(expr.$.env, varName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          if (
            variable &&
            !capturedVariables.has(variable.id) &&
            !variable.isCompileTimeOnly
          ) {
            const nameFrameKey = `${variable.name}:${variable.frameLevel}`;
            const existingOriginalId = nameFrameToOriginalId.get(nameFrameKey);

            if (existingOriginalId && existingOriginalId !== variable.id) {
              variableIdRemapping.set(variable.id, existingOriginalId);
            } else if (variable.isOwningTheSameRcValueAs) {
              const ownerVar = variable.isOwningTheSameRcValueAs;
              if (!capturedVariables.has(ownerVar.id)) {
                const ownerCaptured: EffectCapturedVariable = {
                  id: ownerVar.id,
                  name: ownerVar.name,
                  type: ownerVar.type,
                  isOwningTheSameRcValueAs: undefined,
                };
                capturedVariables.set(ownerVar.id, ownerCaptured);
                const ownerNameFrameKey = `${ownerVar.name}:${ownerVar.frameLevel}`;
                if (!nameFrameToOriginalId.has(ownerNameFrameKey)) {
                  nameFrameToOriginalId.set(ownerNameFrameKey, ownerVar.id);
                }
              }
            } else {
              capturedVariables.set(variable.id, {
                id: variable.id,
                name: varName,
                type: varType,
                isOwningTheSameRcValueAs: undefined,
              });
              if (!nameFrameToOriginalId.has(nameFrameKey)) {
                nameFrameToOriginalId.set(nameFrameKey, variable.id);
              }
            }
          }
        }
      }
      break;

    case ExprTag.FnCall: {
      // Check if this is a while loop
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
        const initialCount = effectCallPoints.length;
        walkExprForEffects(
          expr.func,
          effectCallPoints,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          effectParameterName,
          effectParameterType,
          includeTransitiveCalls,
          effectFieldPath,
          expr
        );
        for (const arg of expr.args) {
          walkExprForEffects(
            arg,
            effectCallPoints,
            capturedVariables,
            nameFrameToOriginalId,
            variableIdRemapping,
            effectParameterName,
            effectParameterType,
            includeTransitiveCalls,
            effectFieldPath,
            expr
          );
        }
        const newCount = effectCallPoints.length;
        if (newCount > initialCount) {
          for (let i = initialCount; i < newCount; i++) {
            effectCallPoints[i]!.isInsideWhile = true;
            effectCallPoints[i]!.whileNestingDepth =
              (effectCallPoints[i]!.whileNestingDepth ?? 0) + 1;
          }
        }
        break;
      }

      // Check if this is a cond expression
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
        const initialCount = effectCallPoints.length;
        walkExprForEffects(
          expr.func,
          effectCallPoints,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          effectParameterName,
          effectParameterType,
          includeTransitiveCalls,
          effectFieldPath,
          expr
        );
        const perBranchEffects: EffectCallPoint[][] = [];
        for (const arg of expr.args) {
          const branchStart = effectCallPoints.length;
          walkExprForEffects(
            arg,
            effectCallPoints,
            capturedVariables,
            nameFrameToOriginalId,
            variableIdRemapping,
            effectParameterName,
            effectParameterType,
            includeTransitiveCalls,
            effectFieldPath,
            expr
          );
          perBranchEffects.push(effectCallPoints.slice(branchStart));
        }
        const maxDepth = Math.max(...perBranchEffects.map((b) => b.length), 0);
        if (maxDepth > 0) {
          effectCallPoints.splice(initialCount);
          const firstIndex = initialCount;
          for (let pos = 0; pos < maxDepth; pos++) {
            let representative: EffectCallPoint | undefined;
            for (const branchList of perBranchEffects) {
              if (pos < branchList.length) {
                representative = branchList[pos];
                break;
              }
            }
            if (representative) {
              representative.index = effectCallPoints.length;
              representative.isInsideCond = true;
              if (pos === 0) {
                representative.needsOwnCondBranchField = true;
              }
              if (pos > 0) {
                representative.condBranchSourceIndex = firstIndex;
              }
              effectCallPoints.push(representative);
            }
          }
        }
        break;
      }

      // Check if this is a match expression
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
        const initialCount = effectCallPoints.length;
        walkExprForEffects(
          expr.func,
          effectCallPoints,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          effectParameterName,
          effectParameterType,
          includeTransitiveCalls,
          effectFieldPath,
          expr
        );
        const perBranchEffects: EffectCallPoint[][] = [];
        for (const arg of expr.args) {
          const branchStart = effectCallPoints.length;
          walkExprForEffects(
            arg,
            effectCallPoints,
            capturedVariables,
            nameFrameToOriginalId,
            variableIdRemapping,
            effectParameterName,
            effectParameterType,
            includeTransitiveCalls,
            effectFieldPath,
            expr
          );
          perBranchEffects.push(effectCallPoints.slice(branchStart));
        }
        const maxDepth = Math.max(...perBranchEffects.map((b) => b.length), 0);
        if (maxDepth > 0) {
          effectCallPoints.splice(initialCount);
          const firstIndex = initialCount;
          for (let pos = 0; pos < maxDepth; pos++) {
            let representative: EffectCallPoint | undefined;
            for (const branchList of perBranchEffects) {
              if (pos < branchList.length) {
                representative = branchList[pos];
                break;
              }
            }
            if (representative) {
              representative.index = effectCallPoints.length;
              representative.isInsideCond = true;
              if (pos === 0) {
                representative.needsOwnCondBranchField = true;
              }
              if (pos > 0) {
                representative.condBranchSourceIndex = firstIndex;
              }
              effectCallPoints.push(representative);
            }
          }
        }
        break;
      }

      // Check if this is a ctl effect call (call to the effect parameter)
      if (isEffectCall(expr, effectParameterName, effectFieldPath)) {
        // Collect all runtime argument types from the ctl call
        const operationArgTypes: Type[] = [];
        for (const arg of expr.args) {
          if (arg.$?.type) {
            operationArgTypes.push(arg.$.type);
          }
        }
        const operationResultType = expr.$?.type;

        if (operationArgTypes.length > 0 && operationResultType) {
          let targetVariableId: string | undefined;
          if (
            parentExpr &&
            parentExpr.tag === ExprTag.FnCall &&
            exprIsFunctionCallOf(parentExpr, ":=")
          ) {
            const varExpr = parentExpr.args[0];
            if (
              varExpr &&
              varExpr.tag === ExprTag.Atom &&
              varExpr.token.type === TokenType.Identifier &&
              varExpr.$
            ) {
              const varName = varExpr.token.value;
              const variables = getVariablesFromEnv(varExpr.$.env, varName);
              if (variables.length > 0) {
                targetVariableId = variables[variables.length - 1]!.id;
              }
            }
          }

          effectCallPoints.push({
            index: effectCallPoints.length,
            expr,
            operationArgTypes,
            operationResultType,
            targetVariableId,
          });
        }
      }

      // Check if this is a transitive effect call — a call to a function
      // that itself has a matching `using` ctl parameter. The outer function
      // must become a state machine that re-yields when the inner SM yields.
      // This is only needed for effect-polymorphic functions (using ...(E) spread),
      // not for functions that directly declare their ctl parameters.
      if (
        includeTransitiveCalls &&
        !isEffectCall(expr, effectParameterName, effectFieldPath) &&
        isTransitiveEffectCall(expr, effectParameterName)
      ) {
        // Get yield types from the ctl type's runtime parameters
        const ctlType = effectParameterType as FunctionType;
        const operationArgTypes: Type[] = ctlType.parameters
          .filter((p) => !p.isCompileTimeOnly)
          .map((p) => p.type);
        // The result type is the transitive call's return type
        const operationResultType = expr.$?.type;

        if (operationArgTypes.length > 0 && operationResultType) {
          let targetVariableId: string | undefined;
          if (
            parentExpr &&
            parentExpr.tag === ExprTag.FnCall &&
            exprIsFunctionCallOf(parentExpr, ":=")
          ) {
            const varExpr = parentExpr.args[0];
            if (
              varExpr &&
              varExpr.tag === ExprTag.Atom &&
              varExpr.token.type === TokenType.Identifier &&
              varExpr.$
            ) {
              const varName = varExpr.token.value;
              const variables = getVariablesFromEnv(varExpr.$.env, varName);
              if (variables.length > 0) {
                targetVariableId = variables[variables.length - 1]!.id;
              }
            }
          }

          effectCallPoints.push({
            index: effectCallPoints.length,
            expr,
            operationArgTypes,
            operationResultType,
            targetVariableId,
            isTransitiveEffectCall: true,
          });
        }
      }

      // Skip async block bodies (they have their own analysis)
      if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
        if (expr.$?.deferredDupExpressions) {
          for (const dupExpr of expr.$.deferredDupExpressions) {
            walkExprForEffects(
              dupExpr,
              effectCallPoints,
              capturedVariables,
              nameFrameToOriginalId,
              variableIdRemapping,
              effectParameterName,
              effectParameterType,
              includeTransitiveCalls,
              effectFieldPath,
              expr
            );
          }
        }
        break;
      }

      // Recurse into function and arguments
      walkExprForEffects(
        expr.func,
        effectCallPoints,
        capturedVariables,
        nameFrameToOriginalId,
        variableIdRemapping,
        effectParameterName,
        effectParameterType,
        includeTransitiveCalls,
        effectFieldPath,
        expr
      );
      for (const arg of expr.args) {
        walkExprForEffects(
          arg,
          effectCallPoints,
          capturedVariables,
          nameFrameToOriginalId,
          variableIdRemapping,
          effectParameterName,
          effectParameterType,
          includeTransitiveCalls,
          effectFieldPath,
          expr
        );
      }

      // Walk deferred drop expressions
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          walkExprForEffects(
            dropExpr,
            effectCallPoints,
            capturedVariables,
            nameFrameToOriginalId,
            variableIdRemapping,
            effectParameterName,
            effectParameterType,
            includeTransitiveCalls,
            effectFieldPath,
            expr
          );
        }
      }
      break;
    }
  }
}

/**
 * Checks if an expression is a call to the effect parameter.
 * This detects:
 * 1. Direct calls like `raise(msg)` where `raise` is the effect parameter name.
 * 2. Module member calls like `raise_mod.raise(msg)` or nested like
 *    `mod.errors.raise(msg)` where the effectFieldPath traces the field access chain.
 */
function isEffectCall(
  expr: Expr,
  effectParameterName: string,
  effectFieldPath?: string[]
): boolean {
  if (expr.tag !== ExprTag.FnCall) return false;

  const func = expr.func;

  // Case 1: Direct effect call — raise(msg)
  if (!effectFieldPath || effectFieldPath.length === 0) {
    if (func.tag !== ExprTag.Atom) return false;
    if (func.token.value !== effectParameterName) return false;

    const funcType = func.$?.type;
    if (!funcType || !isFunctionType(funcType)) return false;

    return true;
  }

  // Case 2: Module member effect call — mod.raise(msg) or mod.errors.raise(msg)
  const accessPath: string[] = [];
  let current: Expr = func;
  while (
    current.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(current, ".") &&
    current.args.length >= 2
  ) {
    const fieldArg = current.args[1];
    if (!fieldArg || fieldArg.tag !== ExprTag.Atom) return false;
    accessPath.unshift(fieldArg.token.value);
    current = current.args[0]!;
  }

  // The root should be an atom matching the effect parameter name
  if (current.tag !== ExprTag.Atom) return false;
  if (current.token.value !== effectParameterName) return false;

  // The access path should match effectFieldPath exactly
  if (accessPath.length !== effectFieldPath.length) return false;
  for (let i = 0; i < accessPath.length; i++) {
    if (accessPath[i] !== effectFieldPath[i]) return false;
  }

  // Verify the resolved type of the outermost "." expression is a function
  const funcType = func.$?.type;
  if (!funcType || !isFunctionType(funcType)) return false;

  return true;
}

/**
 * Checks if an expression is a transitive effect call — a call to a function
 * that itself has a matching `using` parameter for the effect. For example,
 * calling `might_fail()` where `might_fail` has `using(raise : Raise)`.
 */
function isTransitiveEffectCall(
  expr: Expr,
  effectParameterName: string
): boolean {
  if (expr.tag !== ExprTag.FnCall) return false;

  const funcType = expr.func.$?.type;
  if (!funcType || !isFunctionType(funcType)) return false;

  if (!funcType.implicitParameters) return false;
  for (const implicitParam of funcType.implicitParameters) {
    if (
      implicitParam.label === effectParameterName &&
      isFunctionType(implicitParam.type)
    ) {
      return true;
    }
  }
  return false;
}
