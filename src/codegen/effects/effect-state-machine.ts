/**
 * effect-state-machine.ts
 *
 * Generates C code for algebraic effect state machines.
 *
 * When a function contains ctl effect calls (e.g., raise(msg)), it is transformed
 * into a state machine that can suspend at effect call points and be resumed by
 * the handler. The state machine is stack-allocated (no reference counting needed)
 * since effects are synchronous and one-shot.
 *
 * The generated code consists of:
 * 1. A state machine struct containing: state, completed flag, result, yield value,
 *    resume value, function parameters, and all local variables that cross effect boundaries.
 * 2. A resume function that uses switch(sm->state) to dispatch to the correct
 *    code segment.
 *
 * At call sites, the caller:
 * 1. Creates the state machine struct on the stack
 * 2. Initializes arguments
 * 3. Calls the resume function
 * 4. Checks if the function completed or yielded
 * 5. If yielded, runs the handler body inline
 * 6. If handler calls resume(value), sets resume_value and calls resume again
 * 7. If handler doesn't call resume (discontinue), uses handler's return value directly
 */

import type { CapturedVariable } from "../../evaluator/async/await-analysis";
import type {
  EffectAnalysisResult,
  EffectCallPoint,
} from "../../evaluator/effects/effect-analysis-types";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  ExprTag,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import type { FunctionValue } from "../../function-value";
import type { FunctionType, SomeType, Type } from "../../types/definitions";
import { isSomeType, isStructType, isUnitType } from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { isFunctionValue } from "../../value";
import {
  generateDeferredDropExpressions,
  generateDropCodeForValue,
  generateDupCodeForValue,
} from "../exprs/drop-dup";
import { generateExpr } from "../exprs/expr";
import type { FunctionGenerationContext } from "../functions/context";
import {
  containsSuspensionExpr,
  splitBodyAtSuspensionPoints,
} from "../shared/suspension-codegen";
import { getTypeString, sanitizeForCIdentifier } from "../utils/index";

function isMultiEffect(info: EffectStateMachineInfo): boolean {
  return !!info.effectInfos && info.effectInfos.length > 1;
}

/**
 * Check if a handler body contains an explicit return(value) call.
 * Handlers with explicit return resume the SM within the generated body code,
 * so we must NOT emit an implicit resume after them.
 * Does not recurse into nested anonymous function bodies (->).
 */
export function handlerBodyContainsExplicitReturn(expr: Expr): boolean {
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    return true;
  }
  if (expr.tag === ExprTag.FnCall) {
    const fnCall = expr as FnCallExpr;
    if (exprIsFunctionCallOf(expr, "->")) {
      return false;
    }
    for (const arg of fnCall.args) {
      if (handlerBodyContainsExplicitReturn(arg)) return true;
    }
    if (fnCall.func && handlerBodyContainsExplicitReturn(fnCall.func)) {
      return true;
    }
  }
  return false;
}

function yieldFieldName(
  info: EffectStateMachineInfo,
  effectCallPoint: EffectCallPoint,
  argIndex: number
): string {
  if (isMultiEffect(info) && effectCallPoint.effectIndex !== undefined) {
    return `yield_${effectCallPoint.effectIndex}_${argIndex}`;
  }
  return `yield_${argIndex}`;
}

function resumeValueFieldName(
  info: EffectStateMachineInfo,
  effectCallPoint: EffectCallPoint
): string {
  if (isMultiEffect(info) && effectCallPoint.effectIndex !== undefined) {
    return `resume_value_${effectCallPoint.effectIndex}`;
  }
  return `resume_value`;
}

function getEffectResumeTypeCName(
  info: EffectStateMachineInfo,
  effectCallPoint: EffectCallPoint
): string {
  if (isMultiEffect(info) && effectCallPoint.effectIndex !== undefined) {
    return info.effectInfos![effectCallPoint.effectIndex]!.resumeTypeCName;
  }
  return info.resumeTypeCName;
}

/**
 * Information about a generated effect state machine.
 */
export interface EffectSmTypeInfo {
  yieldTypeCNames: string[];
  resumeTypeCName: string;
}

export interface EffectStateMachineInfo {
  structName: string;
  resumeFunctionName: string;
  analysis: EffectAnalysisResult;
  functionType: FunctionType;
  returnTypeCName: string;
  yieldTypeCNames: string[];
  resumeTypeCName: string;
  effectInfos?: EffectSmTypeInfo[];
  isClosure?: boolean;
  closureCaptureTypeCName?: string;
  closureCapturedVarNames?: Set<string>;
}

/**
 * Generate the state machine struct definition for an effectful function.
 */
export function generateEffectStateMachineStruct(
  info: EffectStateMachineInfo,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const {
    structName,
    analysis,
    functionType,
    returnTypeCName,
    yieldTypeCNames,
    resumeTypeCName,
  } = info;

  emitter.emitDeclarationLine(`typedef struct ${structName} {`);
  emitter.emitDeclarationLine(`  int state;`);
  emitter.emitDeclarationLine(`  int completed;`);

  if (!isUnitType(functionType.return.type)) {
    emitter.emitDeclarationLine(`  ${returnTypeCName} result;`);
  }

  if (info.effectInfos) {
    // Multi-effect: per-effect yield and resume fields, plus effect_tag
    emitter.emitDeclarationLine(`  int effect_tag;`);
    for (let e = 0; e < info.effectInfos.length; e++) {
      const ei = info.effectInfos[e]!;
      for (let i = 0; i < ei.yieldTypeCNames.length; i++) {
        emitter.emitDeclarationLine(
          `  ${ei.yieldTypeCNames[i]} yield_${e}_${i};`
        );
      }
      if (ei.resumeTypeCName !== "void") {
        emitter.emitDeclarationLine(
          `  ${ei.resumeTypeCName} resume_value_${e};`
        );
      }
    }
  } else {
    // Single-effect: original field layout
    for (let i = 0; i < yieldTypeCNames.length; i++) {
      emitter.emitDeclarationLine(`  ${yieldTypeCNames[i]} yield_${i};`);
    }
    if (resumeTypeCName !== "void") {
      emitter.emitDeclarationLine(`  ${resumeTypeCName} resume_value;`);
    }
  }

  // Generate fields for function parameters (runtime only, skip implicit/comptime)
  if (info.isClosure) {
    emitter.emitDeclarationLine(`  void* closure_context;`);
  }
  // Build a set of parameter names to avoid duplicate fields
  const paramNames = new Set<string>();
  for (const param of functionType.parameters) {
    if (param.isCompileTimeOnly || param.isImplicit) continue;
    const paramTypeCName = getTypeString(param.type, context);
    emitter.emitDeclarationLine(
      `  ${paramTypeCName} ${sanitizeForCIdentifier(param.label)};`
    );
    paramNames.add(param.label);
  }

  // Generate fields for captured local variables (exclude closure captures)
  for (const capturedVar of analysis.capturedVariables) {
    if (info.closureCapturedVarNames?.has(capturedVar.name)) continue;
    const varTypeCName = getTypeString(capturedVar.type, context);
    const fieldName = sanitizeForCIdentifier(`var_${capturedVar.id}`);
    emitter.emitDeclarationLine(`  ${varTypeCName} ${fieldName};`);
  }

  // Generate inner SM fields for transitive effect call points
  for (const callPoint of analysis.effectCallPoints) {
    if (callPoint.isTransitiveEffectCall) {
      const innerSmInfo = getInnerSmInfo(callPoint, context);
      if (innerSmInfo) {
        emitter.emitDeclarationLine(
          `  ${innerSmInfo.structName} _inner_sm_${callPoint.index};`
        );
      }
    }
  }

  emitter.emitDeclarationLine(`} ${structName};`);
  emitter.emitDeclarationLine(``);
}

/**
 * Generate the forward declaration for the effect resume function.
 */
export function generateEffectResumeFunctionDeclaration(
  info: EffectStateMachineInfo,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(
    `void ${info.resumeFunctionName}(${info.structName}* sm);`
  );
}

/**
 * Look up the inner function's EffectStateMachineInfo for a transitive effect call point.
 */
function getInnerSmInfo(
  callPoint: EffectCallPoint,
  context: FunctionGenerationContext
): EffectStateMachineInfo | undefined {
  const callExpr = callPoint.expr as FnCallExpr;
  const funcValue = callExpr.func.$?.value;

  // Regular function lookup
  if (funcValue && isFunctionValue(funcValue)) {
    const funcId = funcValue.funcId;
    const funcEntry = context.functions[funcId];
    if (!funcEntry) return undefined;
    return funcEntry.effectStateMachineInfo as
      | EffectStateMachineInfo
      | undefined;
  }

  // Closure lookup via implClosureCallMap
  if (callPoint.isTransitiveClosureCall) {
    const funcType = callExpr.func.$?.type;
    if (funcType && isSomeType(funcType)) {
      const someType = funcType as SomeType;
      const concreteTypeId = someType.resolvedConcreteType?.id;
      if (concreteTypeId) {
        // First try implClosureCallMap (populated during function body codegen)
        const mapped = context.implClosureCallMap.get(concreteTypeId);
        if (mapped) {
          const closureFuncEntry = Object.values(context.functions).find(
            (f) => f.cName === mapped.functionCName
          );
          if (closureFuncEntry?.effectStateMachineInfo) {
            return closureFuncEntry.effectStateMachineInfo as EffectStateMachineInfo;
          }
        }

        // Fallback: search all closure functions by capture type ID.
        // This is needed during struct generation (preRegisterEffectfulFunctions)
        // when implClosureCallMap hasn't been populated yet.
        for (const funcId in context.functions) {
          const entry = context.functions[funcId]!;
          if (
            entry.value.type.isClosure &&
            entry.value.closureInfo?.captureType?.id === concreteTypeId &&
            entry.effectStateMachineInfo
          ) {
            return entry.effectStateMachineInfo as EffectStateMachineInfo;
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Build a CapturedVariable map compatible with what atom.ts expects
 * for stateMachineVariables, from the effect analysis captured variables.
 * Variables that correspond to function parameters get kind:"param" so atom.ts
 * accesses them as sm->paramLabel (matching the SM struct's parameter fields)
 * instead of sm->var_{id} (which would be a non-existent or zero-initialized field).
 */
function buildStateMachineVariableMap(
  analysis: EffectAnalysisResult
): Map<string, CapturedVariable> {
  const variableMap = new Map<string, CapturedVariable>();

  for (const capturedVar of analysis.capturedVariables) {
    variableMap.set(capturedVar.id, {
      id: capturedVar.id,
      name: capturedVar.name,
      type: capturedVar.type,
      kind: "local",
      isOwningTheSameRcValueAs: capturedVar.isOwningTheSameRcValueAs
        ? {
            id: capturedVar.isOwningTheSameRcValueAs.id,
            name: capturedVar.isOwningTheSameRcValueAs.name,
            type: capturedVar.isOwningTheSameRcValueAs.type,
            kind: "local",
            isOwningTheSameRcValueAs: undefined,
          }
        : undefined,
    });
  }

  return variableMap;
}

/**
 * Represents a code segment between effect call points in an effectful function body.
 */
interface EffectStateSegment {
  stateNumber: number;
  expressions: Expr[];
  effectCallPoint: EffectCallPoint | null;
}

/**
 * Split the function body at effect call points into state segments.
 *
 * Thin wrapper around the shared `splitBodyAtSuspensionPoints`, mapping
 * the generic `suspensionPoint` field to the effect-specific `effectCallPoint`.
 */
function splitBodyAtEffectCallPoints(
  body: Expr,
  effectCallPoints: EffectCallPoint[]
): EffectStateSegment[] {
  const shared = splitBodyAtSuspensionPoints(body, effectCallPoints);

  return shared.map((seg) => ({
    stateNumber: seg.stateNumber,
    expressions: seg.expressions,
    effectCallPoint: seg.suspensionPoint,
  }));
}

/**
 * Checks if an expression tree contains a specific effect call expression.
 *
 * Thin wrapper around the shared `containsSuspensionExpr`.
 */
function containsEffectCallExpr(expr: Expr, effectExpr: Expr): boolean {
  return containsSuspensionExpr(expr, effectExpr);
}

/**
 * Generate the resume function implementation for an effect state machine.
 */
export function generateEffectResumeFunction(
  bodyExpr: Expr,
  info: EffectStateMachineInfo,
  context: FunctionGenerationContext,
  functionValue?: FunctionValue
): void {
  const emitter = context.emitter;
  const { structName, resumeFunctionName, analysis } = info;

  const previousInEffectStateMachine = context.inEffectStateMachine;
  const previousStateMachineVariables = context.stateMachineVariables;
  const previousVariableIdRemapping = context.variableIdRemapping;

  // Save and set up closure context for SM generation
  const previousClosureCaptures = context.currentClosureCaptures;
  const previousClosureCaptureFrameLevel =
    context.currentClosureCaptureFrameLevel;
  const previousClosureCaptureTypeCName =
    context.currentClosureCaptureTypeCName;

  if (info.isClosure && functionValue?.closureInfo) {
    const captureType = functionValue.closureInfo.captureType;
    if (
      captureType &&
      isStructType(captureType) &&
      captureType.fields.length > 0
    ) {
      context.currentClosureCaptures = captureType.fields.map((f) => f.label);
      context.currentClosureCaptureFrameLevel = functionValue.frameLevel;
      if (info.closureCaptureTypeCName) {
        context.currentClosureCaptureTypeCName = info.closureCaptureTypeCName;
      }
    }
  }

  // Build the SM variable map, excluding closure-captured variables.
  // Closure captures are accessed through closure_context, not SM struct fields.
  const closureCaptureNames = info.closureCapturedVarNames ?? new Set<string>();
  const variableMap = buildStateMachineVariableMap(analysis);
  if (closureCaptureNames.size > 0) {
    for (const [id, cv] of variableMap) {
      if (closureCaptureNames.has(cv.name)) {
        variableMap.delete(id);
      }
    }
  }

  context.inEffectStateMachine = info;
  context.stateMachineVariables = variableMap;
  context.variableIdRemapping = analysis.variableIdRemapping;

  const segments = splitBodyAtEffectCallPoints(
    bodyExpr,
    analysis.effectCallPoints
  );

  emitter.emitLine(`void ${resumeFunctionName}(${structName}* sm) {`);
  if (info.isClosure) {
    emitter.emitLine(`  void* closure_context = sm->closure_context;`);
  }
  emitter.emitLine(`  switch (sm->state) {`);

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!;
    const isLastSegment = segmentIndex === segments.length - 1;

    emitter.emitLine(`    case ${segment.stateNumber}: {`);

    if (segment.stateNumber === 0) {
      // Copy parameter values into corresponding captured variable fields.
      // The call site sets sm->paramName, but the SM body reads sm->var_{capturedId}.
      const runtimeParams = info.functionType.parameters.filter(
        (p) => !p.isCompileTimeOnly && !p.isImplicit
      );
      for (const param of runtimeParams) {
        const capturedVar = analysis.capturedVariables.find(
          (cv) => cv.name === param.label
        );
        if (capturedVar) {
          const capturedFieldName = sanitizeForCIdentifier(
            `var_${capturedVar.id}`
          );
          const paramFieldName = sanitizeForCIdentifier(param.label);
          emitter.emitLine(
            `      sm->${capturedFieldName} = sm->${paramFieldName};`
          );
        }
      }
    }

    if (
      segment.stateNumber > 0 &&
      analysis.effectCallPoints[segment.stateNumber - 1]
    ) {
      const prevEffect = analysis.effectCallPoints[segment.stateNumber - 1]!;
      if (prevEffect.isTransitiveEffectCall) {
        // Transitive resume: forward resume value to inner SM and drive it
        const innerSmInfo = getInnerSmInfo(prevEffect, context);
        if (innerSmInfo) {
          const innerSmField = `sm->_inner_sm_${prevEffect.index}`;
          const outerResumeField = resumeValueFieldName(info, prevEffect);
          if (innerSmInfo.resumeTypeCName !== "void") {
            emitter.emitLine(
              `      ${innerSmField}.resume_value = sm->${outerResumeField};`
            );
          }
          emitter.emitLine(
            `      ${innerSmInfo.resumeFunctionName}(&${innerSmField});`
          );
          emitter.emitLine(`      if (!${innerSmField}.completed) {`);
          // Inner SM yielded again — re-yield
          for (let yi = 0; yi < innerSmInfo.yieldTypeCNames.length; yi++) {
            const outerField = yieldFieldName(info, prevEffect, yi);
            emitter.emitLine(
              `        sm->${outerField} = ${innerSmField}.yield_${yi};`
            );
          }
          if (isMultiEffect(info) && prevEffect.effectIndex !== undefined) {
            emitter.emitLine(
              `        sm->effect_tag = ${prevEffect.effectIndex};`
            );
          }
          emitter.emitLine(`        return;`);
          emitter.emitLine(`      }`);
          // Inner SM completed — store result in target variable if needed
          const innerReturnIsVoid = innerSmInfo.returnTypeCName === "void";
          if (prevEffect.targetVariableId && !innerReturnIsVoid) {
            const fieldName = sanitizeForCIdentifier(
              `var_${prevEffect.targetVariableId}`
            );
            emitter.emitLine(
              `      sm->${fieldName} = ${innerSmField}.result;`
            );
          }
        }
      } else {
        // Direct resume: store resume value into target variable
        const prevResumeField = resumeValueFieldName(info, prevEffect);
        const prevResumeType = getEffectResumeTypeCName(info, prevEffect);
        if (prevEffect.targetVariableId && prevResumeType !== "void") {
          const fieldName = sanitizeForCIdentifier(
            `var_${prevEffect.targetVariableId}`
          );
          emitter.emitLine(`      sm->${fieldName} = sm->${prevResumeField};`);
        }
      }

      // If the previous effect was inside a while loop, emit remaining
      // body expressions (with break/continue context) then step + goto
      // back to while_loop_{index} in case 0 (which has the full while body
      // including the inner SM init + call) instead of falling through to
      // the segment's remaining expressions.
      if (prevEffect.isInsideWhile && prevEffect.enclosingWhileExpr) {
        const whileExpr = prevEffect.enclosingWhileExpr as Expr;
        const whileArgs = (whileExpr as FnCallExpr).args;
        let whileStep: Expr | undefined;
        let whileBody: Expr;
        if (whileArgs.length === 3) {
          whileStep = whileArgs[1]!;
          whileBody = whileArgs[2]!;
        } else {
          whileBody = whileArgs[1]!;
        }

        // Original loop label in case 0 (goto across cases works in C)
        const originalLoopLabel = `while_loop_${prevEffect.index}`;
        // Unique done label for break in this case block
        const doneLabel = `while_done_${prevEffect.index}_s${segment.stateNumber}`;

        const { remainingExprs, bodyDropExprs } =
          extractWhileBodyRemainingExprs(whileBody, prevEffect);

        generateEffectWhileRemainingExprs(
          remainingExprs,
          bodyDropExprs,
          originalLoopLabel,
          whileStep,
          doneLabel,
          "      ",
          context
        );

        emitter.emitLine(`      ${doneLabel}:;`);
        emitter.emitLine(`      sm->completed = 1;`);
        emitter.emitLine(`      return;`);
        emitter.emitLine(`    }`);
        continue;
      }
    }

    for (let i = 0; i < segment.expressions.length; i++) {
      const expr = segment.expressions[i]!;
      const isLastExpr = i === segment.expressions.length - 1;
      const hasEffectCall =
        segment.effectCallPoint &&
        containsEffectCallExpr(expr, segment.effectCallPoint.expr as Expr);

      if (hasEffectCall && segment.effectCallPoint) {
        generateExprWithEffectCall(
          expr,
          segment.effectCallPoint,
          segment.stateNumber,
          "      ",
          context,
          info
        );
      } else if (
        isLastExpr &&
        isLastSegment &&
        !isUnitType(info.functionType.return.type)
      ) {
        const code = generateExpr(expr, "      ", context);
        if (code) {
          emitter.emitLine(`      sm->result = ${code};`);
        }
      } else {
        const code = generateExpr(expr, "      ", context);
        if (
          code &&
          expr.$ &&
          !isTempVariableName(expr.$.env.modulePath, code)
        ) {
          emitter.emitLine(`      ${code};`);
        }
      }
    }

    if (isLastSegment && !segment.effectCallPoint) {
      if (bodyExpr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(bodyExpr, "      ", context);
      } else {
        // bodyExpr has no deferred drops (e.g., effect call is inside a cond branch
        // whose drops are in the cond scope, not the body scope). Drop yield fields
        // directly since they alias captured vars that won't be cleaned up otherwise.
        generateYieldFieldDrops(analysis, "      ", context);
      }
      emitter.emitLine(`      sm->completed = 1;`);
      emitter.emitLine(`      return;`);
    }

    emitter.emitLine(`    }`);
  }

  // Generate resume continuation states for effect call points that yield.
  const maxSegmentState =
    segments.length > 0 ? segments[segments.length - 1]!.stateNumber : -1;
  for (const effectCallPoint of analysis.effectCallPoints) {
    const resumeState = effectCallPoint.index + 1;
    // Only generate if this resume state is not already covered by a segment
    if (resumeState > maxSegmentState) {
      emitter.emitLine(`    case ${resumeState}: {`);

      if (effectCallPoint.isTransitiveEffectCall) {
        // Transitive resume: forward resume value to inner SM and drive it
        const innerSmInfo = getInnerSmInfo(effectCallPoint, context);
        if (innerSmInfo) {
          const innerSmField = `sm->_inner_sm_${effectCallPoint.index}`;
          const outerResumeField = resumeValueFieldName(info, effectCallPoint);
          if (innerSmInfo.resumeTypeCName !== "void") {
            emitter.emitLine(
              `      ${innerSmField}.resume_value = sm->${outerResumeField};`
            );
          }
          emitter.emitLine(
            `      ${innerSmInfo.resumeFunctionName}(&${innerSmField});`
          );
          emitter.emitLine(`      if (!${innerSmField}.completed) {`);
          // Inner SM yielded again — re-yield to outer SM's per-effect fields
          for (let i = 0; i < innerSmInfo.yieldTypeCNames.length; i++) {
            const outerField = yieldFieldName(info, effectCallPoint, i);
            emitter.emitLine(
              `        sm->${outerField} = ${innerSmField}.yield_${i};`
            );
          }
          if (
            isMultiEffect(info) &&
            effectCallPoint.effectIndex !== undefined
          ) {
            emitter.emitLine(
              `        sm->effect_tag = ${effectCallPoint.effectIndex};`
            );
          }
          emitter.emitLine(`        return;`);
          emitter.emitLine(`      }`);
          // Inner SM completed
          const innerReturnIsVoid = innerSmInfo.returnTypeCName === "void";
          if (effectCallPoint.targetVariableId && !innerReturnIsVoid) {
            const fieldName = sanitizeForCIdentifier(
              `var_${effectCallPoint.targetVariableId}`
            );
            emitter.emitLine(
              `      sm->${fieldName} = ${innerSmField}.result;`
            );
          }
          if (
            !isUnitType(info.functionType.return.type) &&
            !innerReturnIsVoid
          ) {
            emitter.emitLine(`      sm->result = ${innerSmField}.result;`);
          }
        }
      } else {
        // Direct resume: store resume value
        const resumeField = resumeValueFieldName(info, effectCallPoint);
        const resumeType = getEffectResumeTypeCName(info, effectCallPoint);
        if (effectCallPoint.targetVariableId && resumeType !== "void") {
          const fieldName = sanitizeForCIdentifier(
            `var_${effectCallPoint.targetVariableId}`
          );
          emitter.emitLine(`      sm->${fieldName} = sm->${resumeField};`);
        }
        if (
          !isUnitType(info.functionType.return.type) &&
          resumeType !== "void"
        ) {
          emitter.emitLine(`      sm->result = sm->${resumeField};`);
        }
        if (bodyExpr.$?.deferredDropExpressions) {
          generateDeferredDropExpressions(bodyExpr, "      ", context);
        } else {
          // bodyExpr has no deferred drops — drop yield fields directly.
          generateYieldFieldDrops(analysis, "      ", context);
        }
      }

      // If the effect call is inside a while loop, emit remaining body
      // expressions with break/continue context, then step + goto
      // back to while_loop_{index} in case 0 (which has the full while body
      // including the inner SM init + call) instead of completing the SM.
      if (effectCallPoint.isInsideWhile && effectCallPoint.enclosingWhileExpr) {
        const whileExpr = effectCallPoint.enclosingWhileExpr as Expr;
        const whileArgs = (whileExpr as FnCallExpr).args;
        let whileStep: Expr | undefined;
        let whileBody: Expr;
        if (whileArgs.length === 3) {
          whileStep = whileArgs[1]!;
          whileBody = whileArgs[2]!;
        } else {
          whileBody = whileArgs[1]!;
        }

        // Original loop label in case 0 (goto across cases works in C)
        const originalLoopLabel = `while_loop_${effectCallPoint.index}`;
        // Unique done label for break in this case block
        const doneLabel = `while_done_${effectCallPoint.index}_r${resumeState}`;

        const { remainingExprs, bodyDropExprs } =
          extractWhileBodyRemainingExprs(whileBody, effectCallPoint);

        generateEffectWhileRemainingExprs(
          remainingExprs,
          bodyDropExprs,
          originalLoopLabel,
          whileStep,
          doneLabel,
          "      ",
          context
        );

        emitter.emitLine(`      ${doneLabel}:;`);
        emitter.emitLine(`      sm->completed = 1;`);
        emitter.emitLine(`      return;`);
      } else {
        emitter.emitLine(`      sm->completed = 1;`);
        emitter.emitLine(`      return;`);
      }
      emitter.emitLine(`    }`);
    }
  }

  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);

  context.inEffectStateMachine = previousInEffectStateMachine;
  context.stateMachineVariables = previousStateMachineVariables;
  context.variableIdRemapping = previousVariableIdRemapping;
  context.currentClosureCaptures = previousClosureCaptures;
  context.currentClosureCaptureFrameLevel = previousClosureCaptureFrameLevel;
  context.currentClosureCaptureTypeCName = previousClosureCaptureTypeCName;
}

function generateExprWithEffectCall(
  expr: Expr,
  effectCallPoint: EffectCallPoint,
  stateNumber: number,
  indent: string,
  context: FunctionGenerationContext,
  info: EffectStateMachineInfo
): void {
  const emitter = context.emitter;
  const effectExpr = effectCallPoint.expr as Expr;

  if (exprIsFunctionCallOf(expr, ":=")) {
    const rhs = (expr as FnCallExpr).args[1]!;
    if (rhs === effectExpr) {
      if (effectCallPoint.isTransitiveEffectCall) {
        generateTransitiveEffectYield(
          effectExpr,
          effectCallPoint,
          stateNumber,
          indent,
          context,
          info
        );
      } else {
        generateEffectYield(
          effectExpr,
          effectCallPoint,
          stateNumber,
          indent,
          context,
          info
        );
      }
      return;
    }
    if (containsEffectCallExpr(rhs, effectExpr)) {
      generateExprWithEffectCall(
        rhs,
        effectCallPoint,
        stateNumber,
        indent,
        context,
        info
      );
      return;
    }
    const code = generateExpr(expr, indent, context);
    if (code) {
      emitter.emitLine(`${indent}${code};`);
    }
    return;
  }

  if (expr === effectExpr) {
    if (effectCallPoint.isTransitiveEffectCall) {
      generateTransitiveEffectYield(
        effectExpr,
        effectCallPoint,
        stateNumber,
        indent,
        context,
        info
      );
    } else {
      generateEffectYield(
        effectExpr,
        effectCallPoint,
        stateNumber,
        indent,
        context,
        info
      );
    }
    return;
  }

  if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    generateCondWithEffectCall(
      expr,
      effectCallPoint,
      stateNumber,
      indent,
      context,
      info
    );
    return;
  }

  if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    generateMatchWithEffectCall(
      expr,
      effectCallPoint,
      stateNumber,
      indent,
      context,
      info
    );
    return;
  }

  if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    generateWhileWithEffectCall(
      expr,
      effectCallPoint,
      stateNumber,
      indent,
      context,
      info
    );
    return;
  }

  if (expr.tag === ExprTag.FnCall) {
    if (containsEffectCallExpr(expr.func, effectExpr)) {
      generateExprWithEffectCall(
        expr.func,
        effectCallPoint,
        stateNumber,
        indent,
        context,
        info
      );
      return;
    }
    for (const arg of expr.args) {
      if (containsEffectCallExpr(arg, effectExpr)) {
        generateExprWithEffectCall(
          arg,
          effectCallPoint,
          stateNumber,
          indent,
          context,
          info
        );
        return;
      }
    }
  }

  const code = generateExpr(expr, indent, context);
  if (code) {
    emitter.emitLine(`${indent}${code};`);
  }
}

function generateEffectYield(
  effectExpr: Expr,
  effectCallPoint: EffectCallPoint,
  stateNumber: number,
  indent: string,
  context: FunctionGenerationContext,
  info: EffectStateMachineInfo
): void {
  const emitter = context.emitter;
  const nextState = effectCallPoint.index + 1;
  const effectArgs = (effectExpr as FnCallExpr).args;
  for (let i = 0; i < effectArgs.length; i++) {
    const arg = effectArgs[i]!;
    const argCode = generateExpr(arg, indent, context);
    emitter.emitLine(
      `${indent}sm->${yieldFieldName(info, effectCallPoint, i)} = ${argCode};`
    );
  }
  if (isMultiEffect(info) && effectCallPoint.effectIndex !== undefined) {
    emitter.emitLine(
      `${indent}sm->effect_tag = ${effectCallPoint.effectIndex};`
    );
  }
  emitter.emitLine(`${indent}sm->state = ${nextState};`);
  emitter.emitLine(`${indent}return;`);
}

/**
 * Generate a transitive effect yield — creates the inner SM, drives it,
 * and re-yields if the inner SM yields. If the inner SM completes immediately
 * (no effect triggered), stores the result and continues.
 */
function generateTransitiveEffectYield(
  effectExpr: Expr,
  effectCallPoint: EffectCallPoint,
  _stateNumber: number,
  indent: string,
  context: FunctionGenerationContext,
  info: EffectStateMachineInfo
): void {
  const emitter = context.emitter;
  const innerSmInfo = getInnerSmInfo(effectCallPoint, context);
  if (!innerSmInfo) {
    emitter.emitLine(
      `${indent}// ERROR: Could not find inner SM info for transitive effect call`
    );
    return;
  }

  const nextState = effectCallPoint.index + 1;
  const innerSmField = `sm->_inner_sm_${effectCallPoint.index}`;

  // Initialize the inner SM
  emitter.emitLine(
    `${indent}${innerSmField} = (${innerSmInfo.structName}){0};`
  );

  // For closure transitive calls, set the closure context pointer
  if (innerSmInfo.isClosure && effectCallPoint.isTransitiveClosureCall) {
    const closureCode = generateExpr(
      (effectExpr as FnCallExpr).func,
      indent,
      context
    );
    emitter.emitLine(
      `${indent}${innerSmField}.closure_context = &(${closureCode});`
    );
  }

  // Set inner SM's runtime parameters from the call expression's arguments
  const innerFuncType = innerSmInfo.functionType;
  const innerRuntimeParams = innerFuncType.parameters.filter(
    (p) => !p.isCompileTimeOnly && !p.isImplicit
  );
  const callArgs = (effectExpr as FnCallExpr).args;
  for (let i = 0; i < innerRuntimeParams.length && i < callArgs.length; i++) {
    const param = innerRuntimeParams[i]!;
    const argCode = generateExpr(callArgs[i]!, indent, context);
    emitter.emitLine(
      `${indent}${innerSmField}.${sanitizeForCIdentifier(param.label)} = ${argCode};`
    );
  }

  // Drive the inner SM
  emitter.emitLine(
    `${indent}${innerSmInfo.resumeFunctionName}(&${innerSmField});`
  );

  // Check if inner SM yielded
  emitter.emitLine(`${indent}if (!${innerSmField}.completed) {`);

  // Copy yield values from inner to outer SM (move semantics — no DUP needed,
  // the inner SM's captured variable owns the RC reference)
  // The inner SM is typically single-effect with yield_0, yield_1, etc.
  // Copy to the outer SM's per-effect yield fields when multi-effect.
  for (let i = 0; i < innerSmInfo.yieldTypeCNames.length; i++) {
    const outerField = yieldFieldName(info, effectCallPoint, i);
    emitter.emitLine(
      `${indent}  sm->${outerField} = ${innerSmField}.yield_${i};`
    );
  }
  if (isMultiEffect(info) && effectCallPoint.effectIndex !== undefined) {
    emitter.emitLine(
      `${indent}  sm->effect_tag = ${effectCallPoint.effectIndex};`
    );
  }
  emitter.emitLine(`${indent}  sm->state = ${nextState};`);
  emitter.emitLine(`${indent}  return;`);
  emitter.emitLine(`${indent}}`);

  // Inner SM completed immediately (no effect was triggered)
  const innerReturnIsVoid = innerSmInfo.returnTypeCName === "void";
  if (!isUnitType(info.functionType.return.type) && !innerReturnIsVoid) {
    if (effectCallPoint.targetVariableId) {
      const fieldName = sanitizeForCIdentifier(
        `var_${effectCallPoint.targetVariableId}`
      );
      emitter.emitLine(`${indent}sm->${fieldName} = ${innerSmField}.result;`);
    }
    emitter.emitLine(`${indent}sm->result = ${innerSmField}.result;`);
  } else if (effectCallPoint.targetVariableId && !innerReturnIsVoid) {
    const fieldName = sanitizeForCIdentifier(
      `var_${effectCallPoint.targetVariableId}`
    );
    emitter.emitLine(`${indent}sm->${fieldName} = ${innerSmField}.result;`);
  }

  // If inside a while loop, emit remaining body expressions + step + goto
  const whileLoop = context.effectWhileLoopContinuation;
  if (whileLoop) {
    generateEffectWhileRemainingExprs(
      whileLoop.remainingExprs,
      whileLoop.bodyDropExprs,
      whileLoop.label,
      whileLoop.stepExpr,
      whileLoop.whileDoneLabel,
      indent,
      context
    );
    // Emit the done label for break to target
    emitter.emitLine(`${indent}${whileLoop.whileDoneLabel}:;`);
    emitter.emitLine(`${indent}sm->completed = 1;`);
    emitter.emitLine(`${indent}return;`);
  } else {
    emitter.emitLine(`${indent}sm->completed = 1;`);
    emitter.emitLine(`${indent}return;`);
  }
}

/**
 * Extract remaining expressions from a while body begin block after the effect call.
 */
function extractWhileBodyRemainingExprs(
  whileBody: Expr,
  effectCallPoint: EffectCallPoint
): { remainingExprs: Expr[]; bodyDropExprs: Expr[] } {
  const effectExpr = effectCallPoint.expr as Expr;
  const bodyDropExprs = whileBody.$?.deferredDropExpressions ?? [];

  let bodyExprs: Expr[];
  if (
    whileBody.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(whileBody, "begin")
  ) {
    bodyExprs = whileBody.args;
  } else {
    bodyExprs = [whileBody];
  }

  const remainingExprs: Expr[] = [];
  let effectFoundIndex = -1;
  for (let i = 0; i < bodyExprs.length; i++) {
    if (containsEffectCallExpr(bodyExprs[i]!, effectExpr)) {
      effectFoundIndex = i;
      break;
    }
  }
  if (effectFoundIndex !== -1) {
    for (let i = effectFoundIndex + 1; i < bodyExprs.length; i++) {
      remainingExprs.push(bodyExprs[i]!);
    }
  }
  return { remainingExprs, bodyDropExprs };
}

/**
 * Generate remaining while body expressions after an effect call completes,
 * with break/continue context set so atom.ts generates correct gotos.
 * After remaining expressions, emit step + goto to loop back.
 */
function generateEffectWhileRemainingExprs(
  remainingExprs: Expr[],
  bodyDropExprs: Expr[],
  loopLabel: string,
  stepExpr: Expr | undefined,
  doneLabel: string,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  if (remainingExprs.length > 0) {
    const prevBreak = context.smWhileBreakInfo;
    const prevContinue = context.smWhileContinueInfo;
    const prevBodyDrops = context.smWhileBodyDrops;
    context.smWhileBreakInfo = { label: doneLabel };
    context.smWhileContinueInfo = {
      label: loopLabel,
      stepExpr,
      emitDropsBeforeGoto: true,
    };
    context.smWhileBodyDrops = [...bodyDropExprs];

    for (const expr of remainingExprs) {
      const code = generateExpr(expr, indent, context);
      if (code && expr.$ && !isTempVariableName(expr.$.env.modulePath, code)) {
        emitter.emitLine(`${indent}${code};`);
      }
    }

    context.smWhileBreakInfo = prevBreak;
    context.smWhileContinueInfo = prevContinue;
    context.smWhileBodyDrops = prevBodyDrops;
  }

  // Normal loop continuation: emit step + goto
  if (stepExpr) {
    const stepCode = generateExpr(stepExpr, indent, context);
    if (stepCode) {
      emitter.emitLine(`${indent}${stepCode};`);
    }
  }
  emitter.emitLine(`${indent}goto ${loopLabel};`);
}

function generateWhileWithEffectCall(
  whileExpr: Expr,
  effectCallPoint: EffectCallPoint,
  stateNumber: number,
  indent: string,
  context: FunctionGenerationContext,
  info: EffectStateMachineInfo
): void {
  const emitter = context.emitter;
  const whileArgs = (whileExpr as FnCallExpr).args;

  const conditionExpr = whileArgs[0]!;
  let stepExpr: Expr | undefined;
  let bodyExpr: Expr;

  if (whileArgs.length === 3) {
    stepExpr = whileArgs[1]!;
    bodyExpr = whileArgs[2]!;
  } else {
    bodyExpr = whileArgs[1]!;
  }

  const loopLabel = `while_loop_${effectCallPoint.index}`;
  const doneLabel = `while_done_${effectCallPoint.index}`;

  // Emit while loop label
  emitter.emitLine(`${indent}${loopLabel}:;`);

  // Emit condition check
  const condCode = generateExpr(conditionExpr, indent, context);
  emitter.emitLine(`${indent}if (!(${condCode})) {`);
  emitter.emitLine(`${indent}  sm->completed = 1;`);
  emitter.emitLine(`${indent}  return;`);
  emitter.emitLine(`${indent}}`);

  // Split the while body begin block to find expressions before/after the effect call.
  // This lets us generate pre-effect expressions now and store post-effect ones
  // for the resume path (where break/continue need special goto handling).
  let bodyExprs: Expr[];
  if (
    bodyExpr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(bodyExpr, "begin")
  ) {
    bodyExprs = bodyExpr.args;
  } else {
    bodyExprs = [bodyExpr];
  }

  const effectExpr = effectCallPoint.expr as Expr;
  let effectFoundIndex = -1;
  for (let i = 0; i < bodyExprs.length; i++) {
    if (containsEffectCallExpr(bodyExprs[i]!, effectExpr)) {
      effectFoundIndex = i;
      break;
    }
  }

  const remainingExprs: Expr[] = [];
  if (effectFoundIndex !== -1) {
    for (let i = effectFoundIndex + 1; i < bodyExprs.length; i++) {
      remainingExprs.push(bodyExprs[i]!);
    }
  }

  const bodyDropExprs = bodyExpr.$?.deferredDropExpressions ?? [];

  // Generate pre-effect expressions with break/continue context
  const prevBreak = context.smWhileBreakInfo;
  const prevContinue = context.smWhileContinueInfo;
  const prevBodyDrops = context.smWhileBodyDrops;
  context.smWhileBreakInfo = { label: doneLabel };
  context.smWhileContinueInfo = {
    label: loopLabel,
    stepExpr,
    emitDropsBeforeGoto: true,
  };
  context.smWhileBodyDrops = [...bodyDropExprs];

  for (let i = 0; i < effectFoundIndex; i++) {
    const expr = bodyExprs[i]!;
    const code = generateExpr(expr, indent, context);
    if (code && expr.$ && !isTempVariableName(expr.$.env.modulePath, code)) {
      emitter.emitLine(`${indent}${code};`);
    }
  }

  context.smWhileBreakInfo = prevBreak;
  context.smWhileContinueInfo = prevContinue;
  context.smWhileBodyDrops = prevBodyDrops;

  // Set up while loop continuation context so that generateTransitiveEffectYield
  // (or generateEffectYield) emits step + goto instead of completed=1.
  const prevWhileLoop = context.effectWhileLoopContinuation;
  context.effectWhileLoopContinuation = {
    label: loopLabel,
    stepExpr,
    whileDoneLabel: doneLabel,
    remainingExprs,
    bodyDropExprs,
  };

  // Generate the expression containing the effect call
  if (effectFoundIndex !== -1) {
    generateExprWithEffectCall(
      bodyExprs[effectFoundIndex]!,
      effectCallPoint,
      stateNumber,
      indent,
      context,
      info
    );
  }

  // Restore context
  context.effectWhileLoopContinuation = prevWhileLoop;
}

function generateCondWithEffectCall(
  condExpr: Expr,
  effectCallPoint: EffectCallPoint,
  stateNumber: number,
  indent: string,
  context: FunctionGenerationContext,
  info: EffectStateMachineInfo
): void {
  const emitter = context.emitter;
  const effectExpr = effectCallPoint.expr as Expr;
  const branches = (condExpr as FnCallExpr).args;

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!;
    if (!exprIsFunctionCallOf(branch, "=>")) continue;

    const conditionExpr = (branch as FnCallExpr).args[0]!;
    const bodyExpr = (branch as FnCallExpr).args[1]!;
    const isDefaultBranch =
      conditionExpr.tag === ExprTag.Atom &&
      conditionExpr.token.value === "true";

    if (isDefaultBranch) {
      emitter.emitLine(`${indent}} else {`);
    } else {
      const condCode = generateExpr(conditionExpr, indent, context);
      if (i === 0) {
        emitter.emitLine(`${indent}if (${condCode}) {`);
      } else {
        emitter.emitLine(`${indent}} else if (${condCode}) {`);
      }
    }

    const bodyContainsEffect = containsEffectCallExpr(bodyExpr, effectExpr);
    if (bodyContainsEffect) {
      generateExprWithEffectCall(
        bodyExpr,
        effectCallPoint,
        stateNumber,
        `${indent}  `,
        context,
        info
      );
    } else {
      const bodyCode = generateExpr(bodyExpr, `${indent}  `, context);
      if (bodyCode && !isUnitType(info.functionType.return.type)) {
        emitter.emitLine(`${indent}  sm->result = ${bodyCode};`);
      } else if (bodyCode) {
        emitter.emitLine(`${indent}  ${bodyCode};`);
      }
      if (condExpr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(condExpr, `${indent}  `, context);
      }
      emitter.emitLine(`${indent}  sm->completed = 1;`);
      emitter.emitLine(`${indent}  return;`);
    }
  }

  emitter.emitLine(`${indent}}`);
}

function generateMatchWithEffectCall(
  matchExpr: Expr,
  effectCallPoint: EffectCallPoint,
  stateNumber: number,
  indent: string,
  context: FunctionGenerationContext,
  _info: EffectStateMachineInfo
): void {
  const code = generateExpr(matchExpr, indent, context);
  if (code) {
    context.emitter.emitLine(`${indent}${code};`);
  }
}

/**
 * Generate call-site code for calling an effectful function.
 *
 * Uses a while loop to handle multiple yields:
 *   SM sm = {0}; sm.params = args;
 *   resumeFn(&sm);
 *   while (!sm.completed) {
 *     // bind yield_value, then execute handler body
 *     // resume: handler sets resume_value and calls resumeFn again
 *     // abort: handler returns from enclosing function
 *   }
 *   result = sm.result;
 */
export function generateEffectCallSite(
  info: EffectStateMachineInfo,
  argCodes: string[],
  functionType: FunctionType,
  handlerBody: Expr,
  handlerType: FunctionType,
  handlerHasResume: boolean,
  callerReturnType: Type | undefined,
  tempVar: string | undefined,
  indent: string,
  context: FunctionGenerationContext,
  closureContextCode?: string
): string {
  const emitter = context.emitter;
  const { structName, resumeFunctionName } = info;

  const smVar = tempVar
    ? `_eff_sm_${sanitizeForCIdentifier(tempVar)}`
    : `_eff_sm`;

  emitter.emitLine(`${indent}${structName} ${smVar} = {0};`);

  if (closureContextCode) {
    emitter.emitLine(
      `${indent}${smVar}.closure_context = ${closureContextCode};`
    );
  }

  const runtimeParams = functionType.parameters.filter(
    (p) => !p.isCompileTimeOnly && !p.isImplicit
  );
  for (let i = 0; i < runtimeParams.length && i < argCodes.length; i++) {
    const param = runtimeParams[i]!;
    emitter.emitLine(
      `${indent}${smVar}.${sanitizeForCIdentifier(param.label)} = ${argCodes[i]};`
    );
  }

  emitter.emitLine(`${indent}${resumeFunctionName}(&${smVar});`);

  // For abort handlers, track which arg C names are RC-type SM arguments.
  // Their ownership is transferred to the SM (no dup), so the handler param drops
  // already free them. Pending deferred drops must skip these to avoid double-free.
  const prevConsumedArgs = context.effectSmConsumedArgCNames;
  if (!handlerHasResume) {
    const consumedArgs = new Set<string>();
    for (let i = 0; i < runtimeParams.length && i < argCodes.length; i++) {
      const param = runtimeParams[i]!;
      if (typeContainsRcType(param.type)) {
        consumedArgs.add(argCodes[i]!);
      }
    }
    if (consumedArgs.size > 0) {
      context.effectSmConsumedArgCNames = consumedArgs;
    }
  }

  emitter.emitLine(`${indent}while (!${smVar}.completed) {`);
  generateHandlerBodyInline(
    handlerBody,
    handlerType,
    smVar,
    info,
    `${indent}  `,
    context,
    handlerHasResume
  );
  emitter.emitLine(`${indent}}`);

  context.effectSmConsumedArgCNames = prevConsumedArgs;

  if (tempVar && !isUnitType(functionType.return.type)) {
    const resultTypeCName = info.returnTypeCName;
    emitter.emitLine(
      `${indent}${resultTypeCName} ${tempVar} = ${smVar}.result;`
    );
    return tempVar;
  }
  return "";
}

/**
 * Handler entry for multi-effect call site generation.
 */
export interface EffectCallSiteHandler {
  handlerBody: Expr;
  handlerType: FunctionType;
  hasResume: boolean;
  effectIndex: number;
}

/**
 * Generate call-site code for calling a multi-effect function.
 *
 * Uses a while+switch pattern to dispatch to the correct handler based on effect_tag:
 *   SM sm = {0}; sm.params = args;
 *   resumeFn(&sm);
 *   while (!sm.completed) {
 *     switch (sm.effect_tag) {
 *       case 0: { handler0 body; break; }
 *       case 1: { handler1 body; break; }
 *     }
 *   }
 *   result = sm.result;
 */
export function generateMultiEffectCallSite(
  info: EffectStateMachineInfo,
  argCodes: string[],
  functionType: FunctionType,
  handlers: EffectCallSiteHandler[],
  tempVar: string | undefined,
  indent: string,
  context: FunctionGenerationContext
): string {
  const emitter = context.emitter;
  const { structName, resumeFunctionName } = info;

  const smVar = tempVar
    ? `_eff_sm_${sanitizeForCIdentifier(tempVar)}`
    : `_eff_sm`;

  emitter.emitLine(`${indent}${structName} ${smVar} = {0};`);

  const runtimeParams = functionType.parameters.filter(
    (p) => !p.isCompileTimeOnly && !p.isImplicit
  );
  for (let i = 0; i < runtimeParams.length && i < argCodes.length; i++) {
    const param = runtimeParams[i]!;
    emitter.emitLine(
      `${indent}${smVar}.${sanitizeForCIdentifier(param.label)} = ${argCodes[i]};`
    );
  }

  emitter.emitLine(`${indent}${resumeFunctionName}(&${smVar});`);

  // For abort handlers in multi-effect, track consumed RC arg C names.
  const hasAnyAbortHandler = handlers.some((h) => !h.hasResume);
  const prevConsumedArgs = context.effectSmConsumedArgCNames;
  if (hasAnyAbortHandler) {
    const consumedArgs = new Set<string>();
    for (let i = 0; i < runtimeParams.length && i < argCodes.length; i++) {
      const param = runtimeParams[i]!;
      if (typeContainsRcType(param.type)) {
        consumedArgs.add(argCodes[i]!);
      }
    }
    if (consumedArgs.size > 0) {
      context.effectSmConsumedArgCNames = consumedArgs;
    }
  }

  emitter.emitLine(`${indent}while (!${smVar}.completed) {`);
  emitter.emitLine(`${indent}  switch (${smVar}.effect_tag) {`);

  for (const handler of handlers) {
    emitter.emitLine(`${indent}    case ${handler.effectIndex}: {`);
    generateHandlerBodyInline(
      handler.handlerBody,
      handler.handlerType,
      smVar,
      info,
      `${indent}      `,
      context,
      handler.hasResume,
      handler.effectIndex
    );
    emitter.emitLine(`${indent}      break;`);
    emitter.emitLine(`${indent}    }`);
  }

  emitter.emitLine(`${indent}  }`);
  emitter.emitLine(`${indent}}`);

  context.effectSmConsumedArgCNames = prevConsumedArgs;
  if (tempVar && !isUnitType(functionType.return.type)) {
    const resultTypeCName = info.returnTypeCName;
    emitter.emitLine(
      `${indent}${resultTypeCName} ${tempVar} = ${smVar}.result;`
    );
    return tempVar;
  }
  return "";
}

/**
 * Drop all RC-typed yield fields in the SM. Used in continuation states
 * when bodyExpr has no deferred drop expressions (e.g., effect call inside
 * a cond branch where drops are in the branch scope, not body scope).
 * Since yield fields alias captured vars, this serves as the cleanup
 * that bodyExpr deferred drops would normally provide.
 */
function generateYieldFieldDrops(
  analysis: EffectAnalysisResult,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const isMulti =
    analysis.effectHandlerInfos && analysis.effectHandlerInfos.length > 1;
  for (const effectCallPoint of analysis.effectCallPoints) {
    for (let i = 0; i < effectCallPoint.operationArgTypes.length; i++) {
      const argType = effectCallPoint.operationArgTypes[i]!;
      if (typeContainsRcType(argType)) {
        const fieldName =
          isMulti && effectCallPoint.effectIndex !== undefined
            ? `yield_${effectCallPoint.effectIndex}_${i}`
            : `yield_${i}`;
        const dropCode = generateDropCodeForValue(
          `sm->${fieldName}`,
          argType,
          context
        );
        if (dropCode) {
          emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  }
}

/**
 * Generate the handler body inline at the effect call site.
 *
 * For resume (handler uses `return(value)`):
 *   return(value) resumes the continuation by setting sm.resume_value and calling resumeFn.
 *   After resumeFn returns, sm.completed should be true and sm.result has the continuation's result.
 *
 * For discontinue (handler uses `abort(value)`):
 *   The handler body returns a value that becomes the enclosing function's return value.
 *   We emit: return <handler_body_result>;
 */
function generateHandlerBodyInline(
  handlerBody: Expr,
  handlerType: FunctionType,
  smVar: string,
  info: EffectStateMachineInfo,
  indent: string,
  context: FunctionGenerationContext,
  hasResume: boolean,
  effectIndex?: number
): void {
  const emitter = context.emitter;

  // Bind all handler runtime parameters to their respective sm.yield_N fields.
  // For multi-effect, use sm.yield_{effectIndex}_{i} fields.
  // For RESUME handlers: DUP RC values so the handler has its own reference.
  //   The SM retains its reference and will drop it when completed.
  // For ABORT handlers: NO DUP — handler "steals" the SM's reference.
  //   The SM is abandoned (never resumes/completes), so no double-free.
  const runtimeParams = handlerType.parameters.filter(
    (p) => !p.isCompileTimeOnly
  );
  const paramDropCodes: string[] = [];
  for (let i = 0; i < runtimeParams.length; i++) {
    const handlerParam = runtimeParams[i]!;
    const paramTypeCName = getTypeString(handlerParam.type, context);
    const paramCName = sanitizeForCIdentifier(handlerParam.label);
    const yieldField =
      effectIndex !== undefined
        ? `${smVar}.yield_${effectIndex}_${i}`
        : `${smVar}.yield_${i}`;
    if (hasResume && typeContainsRcType(handlerParam.type)) {
      // DUP for resume handlers to avoid use-after-free during SM resume.
      const dupCode = generateDupCodeForValue(
        yieldField,
        handlerParam.type,
        context
      );
      if (dupCode) {
        emitter.emitLine(
          `${indent}${paramTypeCName} ${paramCName} = ${dupCode};`
        );
      } else {
        emitter.emitLine(
          `${indent}${paramTypeCName} ${paramCName} = ${yieldField};`
        );
      }
    } else {
      emitter.emitLine(
        `${indent}${paramTypeCName} ${paramCName} = ${yieldField};`
      );
    }
    if (typeContainsRcType(handlerParam.type)) {
      const dropCode = generateDropCodeForValue(
        paramCName,
        handlerParam.type,
        context
      );
      if (dropCode) {
        paramDropCodes.push(dropCode);
      }
    }
  }

  if (hasResume) {
    // Register the continuation variable so that return(value) in the handler body
    // generates SM driving code (sm.resume_value = value; resumeFn(&sm);).
    const prevContinuationVars = context.continuationVariables;
    const continuationVars = new Map(prevContinuationVars);
    continuationVars.set("resume", { smVar, smInfo: info, effectIndex });
    context.continuationVariables = continuationVars;

    // Make handler param drops available to generateReturnAsResume so it can
    // emit them BEFORE the resume call. This prevents use-after-free: the SM
    // may free yielded data during resume, so params must be dropped first.
    const prevHandlerDrops = context.effectHandlerParamDrops;
    context.effectHandlerParamDrops = paramDropCodes;

    const bodyCode = generateExpr(handlerBody, indent, context);
    if (bodyCode) {
      emitter.emitLine(`${indent}${bodyCode};`);
    }

    // Implicit resume: only needed when the handler body has NO explicit return(value).
    // Handlers with explicit return(value) resume the SM within generateReturnAsResume.
    // Emitting an implicit resume for such handlers would cause double-resume and
    // double-drops of handler parameters.
    if (!handlerBodyContainsExplicitReturn(handlerBody)) {
      emitter.emitLine(`${indent}if (!${smVar}.completed) {`);
      for (const dropCode of paramDropCodes) {
        emitter.emitLine(`${indent}  ${dropCode};`);
      }
      const resumeField =
        effectIndex !== undefined &&
        info.effectInfos &&
        info.effectInfos.length > 1
          ? `resume_value_${effectIndex}`
          : `resume_value`;
      const resumeTypeCName =
        effectIndex !== undefined &&
        info.effectInfos &&
        info.effectInfos.length > 1
          ? info.effectInfos[effectIndex]!.resumeTypeCName
          : info.resumeTypeCName;
      if (resumeTypeCName !== "void") {
        emitter.emitLine(
          `${indent}  ${smVar}.${resumeField} = (${resumeTypeCName}){0};`
        );
      }
      emitter.emitLine(`${indent}  ${info.resumeFunctionName}(&${smVar});`);
      emitter.emitLine(`${indent}}`);
    }
    context.effectHandlerParamDrops = prevHandlerDrops;
    context.continuationVariables = prevContinuationVars;
  } else {
    // Discontinue (abort): handler body contains abort(value) which generates
    // `return <value>;` to return from the enclosing function.
    // Set up handler param drops so generateAbort can emit them before returning.
    const prevHandlerDrops = context.effectHandlerParamDrops;
    context.effectHandlerParamDrops = paramDropCodes;

    const bodyCode = generateExpr(handlerBody, indent, context);
    if (bodyCode) {
      emitter.emitLine(`${indent}${bodyCode};`);
    }

    context.effectHandlerParamDrops = prevHandlerDrops;
  }
}
