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
import type {
  DynType,
  FunctionType,
  SomeType,
  Type,
} from "../../types/definitions";
import { isUnitType } from "../../types/guards";
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
import { getTypeString, sanitizeForCIdentifier } from "../utils/index";

/**
 * Information about a generated effect state machine.
 */
export interface EffectStateMachineInfo {
  structName: string;
  resumeFunctionName: string;
  analysis: EffectAnalysisResult;
  functionType: FunctionType;
  returnTypeCName: string;
  yieldTypeCNames: string[];
  resumeTypeCName: string;
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

  for (let i = 0; i < yieldTypeCNames.length; i++) {
    emitter.emitDeclarationLine(`  ${yieldTypeCNames[i]} yield_${i};`);
  }
  emitter.emitDeclarationLine(`  ${resumeTypeCName} resume_value;`);

  // Generate fields for function parameters (runtime only, skip implicit/comptime)
  for (const param of functionType.parameters) {
    if (param.isCompileTimeOnly || param.isImplicit) continue;
    const paramTypeCName = getTypeString(param.type, context);
    emitter.emitDeclarationLine(
      `  ${paramTypeCName} ${sanitizeForCIdentifier(param.label)};`
    );
  }

  // Generate fields for captured local variables
  for (const capturedVar of analysis.capturedVariables) {
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
  if (!funcValue || !isFunctionValue(funcValue)) return undefined;
  // funcValue is narrowed to FunctionValue here
  const funcId = funcValue.funcId;
  const funcEntry = context.functions[funcId];
  if (!funcEntry) return undefined;
  return funcEntry.effectStateMachineInfo as EffectStateMachineInfo | undefined;
}

/**
 * Build a CapturedVariable map compatible with what atom.ts expects
 * for stateMachineVariables, from the effect analysis captured variables.
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
 */
function splitBodyAtEffectCallPoints(
  body: Expr,
  effectCallPoints: EffectCallPoint[]
): EffectStateSegment[] {
  const segments: EffectStateSegment[] = [];

  if (body.tag !== ExprTag.FnCall || !exprIsFunctionCallOf(body, "begin")) {
    if (effectCallPoints.length === 0) {
      return [{ stateNumber: 0, expressions: [body], effectCallPoint: null }];
    }
    return [
      {
        stateNumber: 0,
        expressions: [body],
        effectCallPoint: effectCallPoints[0] ?? null,
      },
    ];
  }

  const expressions = body.args;
  const segmentExpressions: Expr[][] = [];
  let currentSegment: Expr[] = [];

  for (const expr of expressions) {
    const effectIndex = findEffectCallInExpr(expr, effectCallPoints);
    if (effectIndex !== -1) {
      currentSegment.push(expr);
      segmentExpressions.push(currentSegment);
      currentSegment = [];
    } else {
      currentSegment.push(expr);
    }
  }

  if (currentSegment.length > 0) {
    segmentExpressions.push(currentSegment);
  }

  for (let i = 0; i < segmentExpressions.length; i++) {
    const exprs = segmentExpressions[i]!;
    const effectCallPoint =
      i < effectCallPoints.length ? effectCallPoints[i]! : null;
    segments.push({ stateNumber: i, expressions: exprs, effectCallPoint });
  }

  return segments;
}

function findEffectCallInExpr(
  expr: Expr,
  effectCallPoints: EffectCallPoint[]
): number {
  for (let i = 0; i < effectCallPoints.length; i++) {
    if (containsEffectCallExpr(expr, effectCallPoints[i]!.expr as Expr)) {
      return i;
    }
  }
  return -1;
}

function containsEffectCallExpr(expr: Expr, effectExpr: Expr): boolean {
  if (expr === effectExpr) return true;
  if (expr.tag === ExprTag.FnCall) {
    if (containsEffectCallExpr(expr.func, effectExpr)) return true;
    for (const arg of expr.args) {
      if (containsEffectCallExpr(arg, effectExpr)) return true;
    }
  }
  return false;
}

/**
 * Generate the resume function implementation for an effect state machine.
 */
export function generateEffectResumeFunction(
  bodyExpr: Expr,
  info: EffectStateMachineInfo,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const { structName, resumeFunctionName, analysis } = info;

  const previousInEffectStateMachine = context.inEffectStateMachine;
  const previousInStateMachine = context.inStateMachine;
  const previousStateMachineVariables = context.stateMachineVariables;
  const previousVariableIdRemapping = context.variableIdRemapping;

  const variableMap = buildStateMachineVariableMap(analysis);

  context.inEffectStateMachine = info;
  context.inStateMachine = {
    futureType: info.functionType.return.type as unknown as SomeType | DynType,
  };
  context.stateMachineVariables = variableMap;
  context.variableIdRemapping = analysis.variableIdRemapping;

  const segments = splitBodyAtEffectCallPoints(
    bodyExpr,
    analysis.effectCallPoints
  );

  emitter.emitLine(`void ${resumeFunctionName}(${structName}* sm) {`);
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
      if (prevEffect.targetVariableId) {
        const fieldName = sanitizeForCIdentifier(
          `var_${prevEffect.targetVariableId}`
        );
        emitter.emitLine(`      sm->${fieldName} = sm->resume_value;`);
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
  // When an effect call yields (e.g., raise(msg) inside a cond), it sets
  // sm->state = nextState and returns. We need a case for that nextState
  // to handle the resume and complete the SM.
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
          emitter.emitLine(
            `      ${innerSmField}.resume_value = sm->resume_value;`
          );
          emitter.emitLine(
            `      ${innerSmInfo.resumeFunctionName}(&${innerSmField});`
          );
          emitter.emitLine(`      if (!${innerSmField}.completed) {`);
          // Inner SM yielded again — re-yield
          for (let i = 0; i < info.yieldTypeCNames.length; i++) {
            emitter.emitLine(
              `        sm->yield_${i} = ${innerSmField}.yield_${i};`
            );
          }
          emitter.emitLine(`        return;`);
          emitter.emitLine(`      }`);
          // Inner SM completed
          if (effectCallPoint.targetVariableId) {
            const fieldName = sanitizeForCIdentifier(
              `var_${effectCallPoint.targetVariableId}`
            );
            emitter.emitLine(
              `      sm->${fieldName} = ${innerSmField}.result;`
            );
          }
          if (!isUnitType(info.functionType.return.type)) {
            emitter.emitLine(`      sm->result = ${innerSmField}.result;`);
          }
        }
      } else {
        // Direct resume: store resume value
        if (effectCallPoint.targetVariableId) {
          const fieldName = sanitizeForCIdentifier(
            `var_${effectCallPoint.targetVariableId}`
          );
          emitter.emitLine(`      sm->${fieldName} = sm->resume_value;`);
        }
        if (!isUnitType(info.functionType.return.type)) {
          emitter.emitLine(`      sm->result = sm->resume_value;`);
        }
        if (bodyExpr.$?.deferredDropExpressions) {
          generateDeferredDropExpressions(bodyExpr, "      ", context);
        } else {
          // bodyExpr has no deferred drops — drop yield fields directly.
          generateYieldFieldDrops(analysis, "      ", context);
        }
      }

      emitter.emitLine(`      sm->completed = 1;`);
      emitter.emitLine(`      return;`);
      emitter.emitLine(`    }`);
    }
  }

  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);

  context.inEffectStateMachine = previousInEffectStateMachine;
  context.inStateMachine = previousInStateMachine;
  context.stateMachineVariables = previousStateMachineVariables;
  context.variableIdRemapping = previousVariableIdRemapping;
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
  _info: EffectStateMachineInfo
): void {
  const emitter = context.emitter;
  const nextState = effectCallPoint.index + 1;
  const effectArgs = (effectExpr as FnCallExpr).args;
  for (let i = 0; i < effectArgs.length; i++) {
    const arg = effectArgs[i]!;
    const argCode = generateExpr(arg, indent, context);
    emitter.emitLine(`${indent}sm->yield_${i} = ${argCode};`);
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
  for (let i = 0; i < info.yieldTypeCNames.length; i++) {
    emitter.emitLine(`${indent}  sm->yield_${i} = ${innerSmField}.yield_${i};`);
  }
  emitter.emitLine(`${indent}  sm->state = ${nextState};`);
  emitter.emitLine(`${indent}  return;`);
  emitter.emitLine(`${indent}}`);

  // Inner SM completed immediately (no effect was triggered)
  if (!isUnitType(info.functionType.return.type)) {
    if (effectCallPoint.targetVariableId) {
      const fieldName = sanitizeForCIdentifier(
        `var_${effectCallPoint.targetVariableId}`
      );
      emitter.emitLine(`${indent}sm->${fieldName} = ${innerSmField}.result;`);
    }
    emitter.emitLine(`${indent}sm->result = ${innerSmField}.result;`);
  }
  emitter.emitLine(`${indent}sm->completed = 1;`);
  emitter.emitLine(`${indent}return;`);
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
 * For resume case (one-shot):
 *   SM sm = {0}; sm.params = args;
 *   resumeFn(&sm);
 *   if (!sm.completed) {
 *     // bind yield_value, then execute handler body
 *     // handler body contains resume(value) which drives SM to completion
 *   }
 *   result = sm.result;
 *
 * For discontinue case (no resume):
 *   SM sm = {0}; sm.params = args;
 *   resumeFn(&sm);
 *   if (!sm.completed) {
 *     // bind yield_value, return handler body result (early return from caller)
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

  emitter.emitLine(`${indent}if (!${smVar}.completed) {`);
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

  if (tempVar && !isUnitType(functionType.return.type)) {
    const resultTypeCName = info.returnTypeCName;
    emitter.emitLine(
      `${indent}${resultTypeCName} ${tempVar} = ${smVar}.result;`
    );
  }
  return tempVar ?? "";
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
  for (const effectCallPoint of analysis.effectCallPoints) {
    for (let i = 0; i < effectCallPoint.operationArgTypes.length; i++) {
      const argType = effectCallPoint.operationArgTypes[i]!;
      if (typeContainsRcType(argType)) {
        const dropCode = generateDropCodeForValue(
          `sm->yield_${i}`,
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
  hasResume: boolean
): void {
  const emitter = context.emitter;

  // Bind all handler runtime parameters to their respective sm.yield_N fields.
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
    if (hasResume && typeContainsRcType(handlerParam.type)) {
      // DUP for resume handlers to avoid use-after-free during SM resume.
      const dupCode = generateDupCodeForValue(
        `${smVar}.yield_${i}`,
        handlerParam.type,
        context
      );
      if (dupCode) {
        emitter.emitLine(
          `${indent}${paramTypeCName} ${paramCName} = ${dupCode};`
        );
      } else {
        emitter.emitLine(
          `${indent}${paramTypeCName} ${paramCName} = ${smVar}.yield_${i};`
        );
      }
    } else {
      emitter.emitLine(
        `${indent}${paramTypeCName} ${paramCName} = ${smVar}.yield_${i};`
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
    continuationVars.set("resume", { smVar, smInfo: info });
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
