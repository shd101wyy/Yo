/**
 * effect-analysis.ts
 *
 * Analyzes function bodies to identify ctl effect call points and local variables
 * that need to be captured in state machine structs.
 *
 * This is a thin wrapper around the shared suspension-point analysis,
 * providing the effect-specific suspension point detection (ctl calls, transitive calls).
 */

import { type Environment, getVariablesFromEnv } from "../../env";
import { type Expr, exprIsFunctionCallOf, ExprTag } from "../../expr";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isEffectsRowType,
  isFunctionType,
  isSourceNamespaceType,
  isSomeType,
} from "../../types/guards";
import { isTypeValue } from "../../value";
import { isIoAsyncCall } from "../async/await-analysis";
import {
  analyzeSuspensionPoints,
  extractTargetVariableId,
  type SuspensionPointDetector,
} from "../shared/suspension-analysis";
import { extractFnTraitFromType } from "../trait-checking";

export type {
  EffectAnalysisResult,
  EffectCallPoint,
  EffectCapturedVariable,
} from "./effect-analysis-types";

import type {
  EffectsRowType,
  FunctionType,
  Type,
} from "../../types/definitions";
import type {
  EffectAnalysisResult,
  EffectCallPoint,
  EffectCapturedVariable,
} from "./effect-analysis-types";

/**
 * Analyzes a function body to find all effect call points.
 *
 * An effect call point is a call to a variable whose handler function value
 * has isControlFunction: true (set when the handler body uses `escape`).
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
  // Check if the effect parameter type is a function type so we can use it
  // as a fallback for type info when sub-expressions lack evaluation data
  // (e.g., bodies of functions with forall(...(E)) spread effect parameters).
  const effectParamFnType = isFunctionType(effectParameterType)
    ? effectParameterType
    : undefined;

  const detector: SuspensionPointDetector<EffectCallPoint> = {
    detect(expr, parentExpr, points) {
      if (expr.tag !== ExprTag.FnCall) return;

      const isMatch = isEffectCall(
        expr,
        effectParameterName,
        effectFieldPath,
        /* allowMissingType */ true
      );

      // Check if this is a ctl effect call (call to the effect parameter)
      // Use allowMissingType=true so that calls in generic bodies (where
      // sub-expression type info may be missing) are still detected.
      if (isMatch) {
        const operationArgTypes: Type[] = [];
        for (const arg of expr.args) {
          if (arg.$?.type) {
            operationArgTypes.push(arg.$.type);
          }
        }

        // Fall back to the effect parameter function type for argument types
        // when the expression sub-nodes lack type info (generic body context).
        if (operationArgTypes.length === 0 && effectParamFnType) {
          for (const param of effectParamFnType.parameters) {
            if (!param.isCompileTimeOnly) {
              operationArgTypes.push(param.type);
            }
          }
        }

        // Fall back to the effect parameter return type for the result type
        const operationResultType =
          expr.$?.type ?? effectParamFnType?.return.type;

        if (operationArgTypes.length > 0 && operationResultType) {
          const targetVariableId = extractTargetVariableId(parentExpr);

          points.push({
            index: points.length,
            expr,
            operationArgTypes,
            operationResultType,
            targetVariableId,
          });
        }
      }

      // Check if this is a transitive effect call — a call to a function
      // that itself has a matching `using` ctl parameter.
      if (
        includeTransitiveCalls &&
        !isEffectCall(expr, effectParameterName, effectFieldPath)
      ) {
        const transitiveResult = isTransitiveEffectCall(
          expr,
          effectParameterName
        );
        if (transitiveResult) {
          const ctlType = effectParameterType as FunctionType;
          const operationArgTypes: Type[] = ctlType.parameters
            .filter((p) => !p.isCompileTimeOnly)
            .map((p) => p.type);
          const operationResultType = transitiveResult.viaClosure
            ? ctlType.return.type
            : expr.$?.type;

          if (operationArgTypes.length > 0 && operationResultType) {
            const targetVariableId = extractTargetVariableId(parentExpr);

            points.push({
              index: points.length,
              expr,
              operationArgTypes,
              operationResultType,
              targetVariableId,
              isTransitiveEffectCall: true,
              isTransitiveClosureCall: transitiveResult.viaClosure,
            });
          }
        }
      }
    },

    shouldSkipBody(expr) {
      return isIoAsyncCall(expr);
    },
  };

  const result = analyzeSuspensionPoints(body, detector);

  // Map shared captured variables to EffectCapturedVariable
  const capturedVariables: EffectCapturedVariable[] =
    result.capturedVariables.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      isOwningTheSameRcValueAs: undefined,
    }));

  return {
    effectCallPoints: result.suspensionPoints,
    capturedVariables,
    hasEffects: result.hasSuspensions,
    variableIdRemapping: result.variableIdRemapping,
    effectParameterName,
    effectParameterType,
    effectFieldPath,
  };
}

// --- Effect-specific detection helpers ---

/**
 * Checks if an expression is a call to the effect parameter.
 * This detects:
 * 1. Direct calls like `raise(msg)` where `raise` is the effect parameter name.
 * 2. Struct-record member calls like `raise_mod.raise(msg)` or nested like
 *    `mod.errors.raise(msg)` where the effectFieldPath traces the field access chain.
 *
 * When allowMissingType is true, the type check on func.$?.type is relaxed.
 * This is needed for functions with forall(...(E)) spread effect parameters
 * whose body sub-expressions may not have type info set during generic evaluation.
 */
function isEffectCall(
  expr: Expr,
  effectParameterName: string,
  effectFieldPath?: string[],
  allowMissingType: boolean = false
): boolean {
  if (expr.tag !== ExprTag.FnCall) return false;

  const func = expr.func;

  // Case 1: Direct effect call — raise(msg)
  if (!effectFieldPath || effectFieldPath.length === 0) {
    if (func.tag !== ExprTag.Atom) return false;
    if (func.token.value !== effectParameterName) return false;

    const funcType = func.$?.type;
    if (!allowMissingType && (!funcType || !isFunctionType(funcType)))
      return false;
    // When allowMissingType is true, we accept the match if the name matches
    // even without type info (the caller already knows this is a function type)
    if (allowMissingType && funcType && !isFunctionType(funcType)) return false;

    return true;
  }

  // Case 2: Struct-record member effect call — mod.raise(msg) or mod.errors.raise(msg)
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
  if (!allowMissingType && (!funcType || !isFunctionType(funcType)))
    return false;
  if (allowMissingType && funcType && !isFunctionType(funcType)) return false;

  return true;
}

/**
 * Checks if an expression is a transitive effect call — a call to a function
 * that itself has a matching `using` parameter for the effect. For example,
 * calling `might_fail()` where `might_fail` has `using(raise : Raise)`.
 * Also detects calls to closures typed as Impl(Fn(..., using(effect))) via
 * FnTrait extraction.
 *
 * Returns the matched implicit parameter type if found, or undefined.
 * When matched via FnTrait extraction (closure/Impl), the returned type
 * indicates the caller should use ctlType.return.type as operationResultType.
 */
function isTransitiveEffectCall(
  expr: Expr,
  effectParameterName: string
): { matched: true; viaClosure: boolean } | undefined {
  if (expr.tag !== ExprTag.FnCall) return undefined;

  const funcType = expr.func.$?.type;
  if (!funcType) return undefined;

  // Check direct function type
  if (isFunctionType(funcType)) {
    if (!funcType.implicitParameters) return undefined;
    for (const implicitParam of funcType.implicitParameters) {
      if (
        implicitParam.label === effectParameterName &&
        (isFunctionType(implicitParam.type) ||
          isSourceNamespaceType(implicitParam.type))
      ) {
        return { matched: true, viaClosure: false };
      }
      // Handle effect row spread: ...(E) — resolve E to check for the effect
      if (implicitParam.isEffectRowSpread) {
        if (
          hasEffectInSpread(
            implicitParam,
            effectParameterName,
            expr.func.$?.env
          )
        ) {
          return { matched: true, viaClosure: false };
        }
      }
    }
    return undefined;
  }

  // Check Impl(Fn(...)) / Dyn(Fn(...)) types by extracting the callType
  const fnTrait = extractFnTraitFromType(funcType);
  if (fnTrait) {
    const callType = fnTrait.isFn.callType;
    if (callType.implicitParameters) {
      for (const implicitParam of callType.implicitParameters) {
        if (
          implicitParam.label === effectParameterName &&
          (isFunctionType(implicitParam.type) ||
            isSourceNamespaceType(implicitParam.type))
        ) {
          return { matched: true, viaClosure: true };
        }
        // Handle effect row spread: ...(E) — resolve E to check for the effect
        if (implicitParam.isEffectRowSpread) {
          if (
            hasEffectInSpread(
              implicitParam,
              effectParameterName,
              expr.func.$?.env
            )
          ) {
            return { matched: true, viaClosure: true };
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Check if an effect row spread parameter contains the target effect.
 * Resolves the SomeType from the env to get the concrete EffectsRowType.
 */
function hasEffectInSpread(
  implicitParam: { label: string; type: Type; isEffectRowSpread?: boolean },
  effectParameterName: string,
  env: Environment | undefined
): boolean {
  if (!env) return false;
  const paramType = implicitParam.type;

  // Try to resolve the SomeType to an EffectsRowType
  let effectsRowType: EffectsRowType | undefined;
  if (isSomeType(paramType) && paramType.isEffectsRow) {
    // Look up by variable name
    const eVars = getVariablesFromEnv(env, implicitParam.label);
    const eVarValue = eVars.at(-1)?.value?.[0];
    if (
      eVarValue &&
      isTypeValue(eVarValue) &&
      isEffectsRowType(eVarValue.value)
    ) {
      effectsRowType = eVarValue.value;
    } else {
      const boundType = getValueOfSomeTypeFromEnv(env, paramType);
      if (isEffectsRowType(boundType)) {
        effectsRowType = boundType;
      }
    }
  } else if (isEffectsRowType(paramType)) {
    effectsRowType = paramType as EffectsRowType;
  }

  if (effectsRowType) {
    for (const innerParam of effectsRowType.implicitParameters) {
      if (
        innerParam.label === effectParameterName &&
        (isFunctionType(innerParam.type) ||
          isSourceNamespaceType(innerParam.type))
      ) {
        return true;
      }
    }
  }
  return false;
}
