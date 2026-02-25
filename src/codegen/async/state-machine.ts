/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import type {
  AwaitAnalysisResult,
  AwaitPoint,
  CapturedVariable,
} from "../../evaluator/async/await-analysis";
import { isIoAwaitCall } from "../../evaluator/async/await-analysis";
import { extractFutureTraitFromType } from "../../evaluator/trait-checking";
import {
  type Expr,
  BuiltinKeywords,
  exprIsAtomOf,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import { exprContainsAwait } from "../../expr-traversal";
import type {
  DynType,
  SomeType,
  StructType,
  Type,
} from "../../types/definitions";
import {
  isConcreteTraitType,
  isDynType,
  isSomeType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { emitAsyncFutureCompletion } from "../exprs/async-completion";
import { getDupFunctionForType } from "../exprs/drop-dup";
import { generateExpr } from "../exprs/expr";
import type { FunctionGenerationContext } from "../functions/context";
import { sanitizeForCIdentifier } from "../utils";
import {
  generateAwaitExpression,
  generateStateSegmentCode,
  splitIntoStateSegments,
} from "./state-code-gen";

/**
 * Get the state machine field name for the Future being awaited.
 * Uses the captured Future variable instead of a separate await_future_X field.
 */
export function getFutureFieldName(
  awaitPoint: AwaitPoint,
  analysis: AwaitAnalysisResult
): string {
  if (awaitPoint.futureVariableId) {
    // Find the captured variable
    const capturedVar = analysis.capturedVariables.find(
      (v) => v.id === awaitPoint.futureVariableId
    );
    if (capturedVar) {
      // Use the captured variable's field name
      const fieldName =
        capturedVar.kind === "outer"
          ? capturedVar.name
          : `var_${capturedVar.id}`;
      return fieldName;
    }
  }

  // Fallback: If we can't find the variable (e.g., it's a pattern-bound variable from match),
  // use a dedicated await_future_{index} field
  return `await_future_${awaitPoint.index}`;
}

/**
 * Gets the state machine field name for a future variable by its ID.
 * Used by join codegen to reference each future being joined.
 */
export function getFutureFieldNameByVariableId(
  futureVariableId: string,
  analysis: AwaitAnalysisResult
): string {
  const capturedVar = analysis.capturedVariables.find(
    (v) => v.id === futureVariableId
  );
  if (capturedVar) {
    return capturedVar.kind === "outer"
      ? capturedVar.name
      : `var_${capturedVar.id}`;
  }
  return `var_${futureVariableId}`;
}

/**
 * Check if a future type is an IO future (yo_io_future_t) rather than a state
 * machine future (from io.async). IO futures have a Concrete(...) trait and are
 * already submitted to io_uring at creation — they don't have __yo_resume_fn
 * and should not be "cold-started".
 *
 * Detection: IO futures (from Impl(Concrete(yo_io_future_t), Future(i32)))
 * have their resolvedConcreteType set to an extern SomeType (the Concrete type).
 * State machine futures may also have resolvedConcreteType as a SomeType, but
 * it won't be extern.
 */
function isIoFutureType(type: Type | undefined): boolean {
  if (!type || !isSomeType(type)) return false;
  // Check if the concrete type resolution came from a Concrete(...) trait
  // pointing to an extern C type like yo_io_future_t. State machine futures
  // also have resolvedConcreteType set (from return-type resolution), but
  // their resolved type is never an extern type.
  if (
    type.resolvedConcreteType &&
    isSomeType(type.resolvedConcreteType) &&
    type.resolvedConcreteType.isExtern
  ) {
    return true;
  }
  // Also check requiredTraits directly (in case resolution hasn't stripped them)
  return type.requiredTraits.some((t) => isConcreteTraitType(t.traitType));
}

/**
 * Information about a generated state machine.
 */
export interface StateMachineInfo {
  /**
   * The C struct name for this state machine
   */
  structName: string;

  /**
   * The C function name for the resume function
   */
  resumeFunctionName: string;

  /**
   * Analysis result containing await points and captured variables
   */
  analysis: AwaitAnalysisResult;
}

/**
 * Generates the forward declaration for the resume function.
 */
export function generateResumeFunctionDeclaration(
  info: StateMachineInfo,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(
    `void ${info.resumeFunctionName}(${info.structName}* sm);`
  );
}

/**
 * Gets the C field name for a captured variable in a state machine struct.
 * This ensures consistent naming across struct definition and usage.
 */
export function getStateMachineFieldName(
  variableId: string,
  kind?: "outer" | "local"
): string {
  if (kind === "outer") {
    // Outer captured variables are accessed through __capture struct
    return `__capture.${sanitizeForCIdentifier(variableId)}`;
  }
  // Local variables use var_{id} naming
  return sanitizeForCIdentifier(`var_${variableId}`);
}

/**
 * Generates the resume function implementation for an async block state machine.
 * This is the canonical implementation used for all async code (functions are just syntax sugar).
 */
export function generateAsyncBlockResumeFunction(
  bodyExpr: Expr,
  asyncBlockId: string,
  structName: string,
  resumeFunctionName: string,
  analysis: AwaitAnalysisResult,
  futureType: SomeType | DynType,
  captureType: StructType | undefined,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  const futureModuleType = extractFutureTraitFromType(futureType)!;
  const childType = futureModuleType.isFuture.outputType;
  const isUnitResult = isUnitType(childType);

  // Clear asyncCondBranchInfo and asyncWhileLoopInfo for this async block to prevent
  // data from other async blocks (or outer scopes) from leaking in.
  // Each async block should only see its own branch/loop information.
  context.asyncCondBranchInfo = new Map();
  context.asyncWhileLoopInfo = new Map();

  // Initialize the while loop index counter for allocating unique indices
  // to outer while loops in nested while-with-await scenarios.
  // Indices 0..awaitPoints.length-1 are reserved for innermost while loops
  // (matching their await point indices). Outer while loops get indices starting
  // from awaitPoints.length.
  context.asyncNextWhileLoopIndex = analysis.awaitPoints.length;

  // Split the body into state segments
  const segments = splitIntoStateSegments(bodyExpr, analysis.awaitPoints);

  emitter.emitLine(`// Resume function for async block ${asyncBlockId}`);
  emitter.emitLine(`void ${resumeFunctionName}(${structName}* sm) {`);
  emitter.emitLine(
    `  ASYNC_DEBUG("${asyncBlockId}_resume: state=%d\\n", sm->state);`
  );
  emitter.emitLine(`  switch (sm->state) {`);

  // Generate code for each state segment
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (!segment) continue;

    const stateNumber = segment.stateNumber;
    const isLastSegment = segmentIndex === segments.length - 1;

    // State case label
    emitter.emitLine(`
    state_${stateNumber}:`);

    emitter.emitLine(`    case ${stateNumber}: { // State ${stateNumber}`);
    emitter.emitLine(
      `      ASYNC_DEBUG("${asyncBlockId}: Entering state ${stateNumber}\\n");`
    );

    // If this is not the first state, extract the result from the previous await
    if (stateNumber > 0 && analysis.awaitPoints[stateNumber - 1]) {
      const prevAwait = analysis.awaitPoints[stateNumber - 1]!;
      const prevFutureFieldName = getFutureFieldName(prevAwait, analysis);

      // When previous await was inside a cond, the future may be NULL
      // (non-await branch was taken). Guard all result extraction and cond handling.
      if (prevAwait.isInsideCond) {
        emitter.emitLine(`      if (sm->${prevFutureFieldName} != NULL) {`);
      }

      // When the output type is an unresolved SomeType (e.g., forall(T) from
      // io.await evaluated with io=UnknownValue), treat it as unit.
      const isPrevAwaitResultUnit =
        isUnitType(prevAwait.resultType) ||
        (isSomeType(prevAwait.resultType) &&
          !(prevAwait.resultType as SomeType).resolvedConcreteType);

      // Always check if the awaited Future was aborted by an effect handler
      if (!prevAwait.isJoinPoint) {
        emitter.emitLine(`      // Check if the awaited Future was aborted`);
        emitter.emitLine(
          `      if (atomic_load_explicit(&sm->${prevFutureFieldName}->state, memory_order_acquire) == -3) {`
        );
        emitter.emitLine(
          `        fprintf(stderr, "panic: attempted to await an aborted Future\\n");`
        );
        emitter.emitLine(`        abort();`);
        emitter.emitLine(`      }`);
      }

      if (prevAwait && !isPrevAwaitResultUnit) {
        emitter.emitLine(
          `      // Extract result from await ${stateNumber - 1}`
        );
        emitter.emitLine(
          `      int state_before_read = atomic_load_explicit(&sm->${prevFutureFieldName}->state, memory_order_acquire);`
        );
        emitter.emitLine(
          `      ASYNC_DEBUG("${asyncBlockId}: Reading result from await ${stateNumber - 1}, state=%d\\n", state_before_read);`
        );
        // If the result contains Rc-managed data, we need to dup it before copying
        // because the Future's dispose function will drop it, and we need our own reference
        if (typeContainsRcType(prevAwait.resultType)) {
          const dupFunctionName = getDupFunctionForType(
            prevAwait.resultType,
            context
          );
          if (dupFunctionName) {
            emitter.emitLine(
              `      sm->await_result_${stateNumber - 1} = ${dupFunctionName}(sm->${prevFutureFieldName}->result);`
            );
          } else {
            emitter.emitLine(
              `      /* Warning: No ___dup function found for result type, shallow copy may cause use-after-free */`
            );
            emitter.emitLine(
              `      sm->await_result_${stateNumber - 1} = sm->${prevFutureFieldName}->result;`
            );
          }
        } else {
          // For non-Rc types (primitives), simple copy is fine
          emitter.emitLine(
            `      sm->await_result_${stateNumber - 1} = sm->${prevFutureFieldName}->result;`
          );
        }

        // If this await has a target variable, assign the result to it
        if (prevAwait.targetVariableId) {
          const fieldName = getStateMachineFieldName(
            prevAwait.targetVariableId,
            "local"
          );
          emitter.emitLine(
            `      sm->${fieldName} = sm->await_result_${stateNumber - 1};`
          );
        }

        emitter.emitLine(``);
      }

      // If the awaited Future was a temporary stored in await_future_X, drop it now.
      // (Captured Future variables may outlive the await and are handled by normal drops.)
      // Since Futures are ref-counted, we use __yo_decr_rc instead of direct dispose.
      // Skip for join points — join futures are always captured variables.
      if (!prevAwait.futureVariableId && !prevAwait.isJoinPoint) {
        const awaitExpr = prevAwait.expr as Expr;
        if (awaitExpr.tag === ExprTag.FnCall) {
          const futureArg = awaitExpr.args[0];
          const argFutureType = futureArg?.$?.type;
          if (
            argFutureType &&
            (isSomeType(argFutureType) || isDynType(argFutureType))
          ) {
            emitter.emitLine(
              `      if (sm->${prevFutureFieldName} != NULL) { __yo_decr_rc((void*)sm->${prevFutureFieldName}); sm->${prevFutureFieldName} = NULL; }`
            );
            emitter.emitLine(``);
          }
        }
      }

      // Check if this await was part of a cond expression
      // If so, we need to execute the remaining code from the chosen branch
      const functionContext = context as FunctionGenerationContext;
      if (prevAwait) {
        const condBranchData = functionContext.asyncCondBranchInfo?.get(
          prevAwait.index
        );
        if (condBranchData && condBranchData.branches.some((b) => b.hasAwait)) {
          // Use condBranchFieldIndex if set (for continuation states), otherwise use prevAwait.index
          const condBranchFieldIndex =
            condBranchData.condBranchFieldIndex ?? prevAwait.index;
          emitter.emitLine(
            `      // Execute remaining code from chosen cond branch`
          );
          emitter.emitLine(
            `      switch (sm->cond_branch_${condBranchFieldIndex}) {`
          );

          // Check if the current segment has an additional cond await point
          const hasAdditionalCondAwait =
            segment.awaitPoint?.isInsideCond ?? false;

          for (const branch of condBranchData.branches) {
            if (branch.hasAwait) {
              emitter.emitLine(`        case ${branch.index}: {`);
              emitter.emitLine(
                `          ASYNC_DEBUG("${asyncBlockId}: Executing remaining code from branch ${branch.index}\\n");`
              );

              // If there are remaining expressions, generate them
              if (branch.remainingExprs && branch.remainingExprs.length > 0) {
                // Set up state machine context for code generation
                const previousInStateMachineForBranch =
                  context.inAsyncStateMachine;
                const previousStateMachineVariablesForBranch =
                  context.stateMachineVariables;
                const previousVariableIdRemappingForBranch =
                  context.variableIdRemapping;
                const previousPendingDeferredDropsForBranch =
                  context.pendingDeferredDrops;

                context.inAsyncStateMachine = { futureType };
                context.variableIdRemapping = analysis.variableIdRemapping;
                // Set pending deferred drops so early returns in cond branches
                // can drop async block local variables
                context.pendingDeferredDrops = [
                  ...(bodyExpr.$?.deferredDropExpressions ?? []),
                ];
                // Combine outer captured variables and local variables
                const combinedVariables = new Map<string, CapturedVariable>();
                for (const v of analysis.capturedVariables) {
                  combinedVariables.set(v.id, v);
                }
                if (captureType) {
                  for (const field of captureType.fields) {
                    combinedVariables.set(field.label, {
                      id: field.label,
                      name: field.label,
                      type: field.type,
                      kind: "outer",
                      isOwningTheSameRcValueAs: undefined, // FIXME
                    });
                  }
                }
                context.stateMachineVariables = combinedVariables;

                // Generate remaining expressions, detecting additional awaits
                let foundAdditionalAwait = false;
                const additionalRemainingExprs: Expr[] = [];

                // Determine assignment target for the last remaining expression
                // (used by match/cond with await where branch result != await result)
                const branchTargetAssignmentCode =
                  condBranchData.targetAssignmentCode;

                for (
                  let exprIdx = 0;
                  exprIdx < branch.remainingExprs.length;
                  exprIdx++
                ) {
                  const expr = branch.remainingExprs[exprIdx]!;
                  const isLastExpr =
                    exprIdx === branch.remainingExprs.length - 1;

                  if (foundAdditionalAwait) {
                    additionalRemainingExprs.push(expr);
                    continue;
                  }

                  // Check if this expression contains an additional await
                  if (hasAdditionalCondAwait && exprContainsAwait(expr)) {
                    foundAdditionalAwait = true;
                    // Store the future for the next await point
                    generateRemainingExprFuture(
                      expr,
                      segment.awaitPoint!,
                      analysis,
                      "          ",
                      context
                    );
                    continue;
                  }

                  // Normal expression
                  const code = generateExpr(expr, "          ", context);
                  // Skip empty code, expressions without metadata, and temp variable references
                  if (
                    !code ||
                    !expr.$ ||
                    isTempVariableName(expr.$.env.modulePath, code)
                  ) {
                    // Skip
                  } else if (isLastExpr && branchTargetAssignmentCode) {
                    emitter.emitLine(
                      `          ${branchTargetAssignmentCode} = ${code};`
                    );
                  } else {
                    emitter.emitLine(`          ${code};`);
                  }
                }

                // If this branch has no remaining expressions and there's a target,
                // assign from await_result (the await result IS the branch value)
                if (
                  branch.remainingExprs.length === 0 &&
                  branchTargetAssignmentCode
                ) {
                  emitter.emitLine(
                    `          ${branchTargetAssignmentCode} = sm->await_result_${prevAwait.index};`
                  );
                }

                if (foundAdditionalAwait && segment.awaitPoint) {
                  // Store continuation info for the next state
                  const nextIndex = segment.awaitPoint.index;
                  if (!functionContext.asyncCondBranchInfo) {
                    functionContext.asyncCondBranchInfo = new Map();
                  }
                  const existing =
                    functionContext.asyncCondBranchInfo.get(nextIndex);
                  if (existing) {
                    // Entry already exists (from a nested cond's generateCondWithAwait).
                    // Chain the outer cond's remaining code as a separate layer.
                    if (!existing.chainedBranches) {
                      existing.chainedBranches = [];
                    }
                    existing.chainedBranches.push({
                      branches: [
                        {
                          index: branch.index,
                          value: branch.value,
                          hasAwait:
                            additionalRemainingExprs.length > 0 ||
                            additionalRemainingExprs.some((e) =>
                              exprContainsAwait(e)
                            ),
                          remainingExprs: additionalRemainingExprs,
                          deferredDropExpressions:
                            branch.deferredDropExpressions,
                        },
                      ],
                      condBranchFieldIndex: condBranchFieldIndex,
                    });
                  } else {
                    const newEntry = {
                      branches: [
                        {
                          index: branch.index,
                          value: branch.value,
                          hasAwait:
                            additionalRemainingExprs.length > 0 ||
                            additionalRemainingExprs.some((e) =>
                              exprContainsAwait(e)
                            ),
                          remainingExprs: additionalRemainingExprs,
                          deferredDropExpressions:
                            branch.deferredDropExpressions,
                        },
                      ],
                      condBranchFieldIndex: condBranchFieldIndex,
                    };
                    functionContext.asyncCondBranchInfo.set(
                      nextIndex,
                      newEntry
                    );
                  }
                } else {
                  // No more awaits - generate deferred drop expressions
                  // Filter out drops that reference temp variables not in state machine scope
                  if (branch.deferredDropExpressions) {
                    for (const dropExpr of branch.deferredDropExpressions) {
                      const dropCode = generateExpr(
                        dropExpr,
                        "          ",
                        context
                      );
                      // Skip drops that don't use state machine fields (sm->var_*)
                      // These are temp variables from the original scope that aren't accessible
                      if (dropCode && dropCode.includes("sm->")) {
                        emitter.emitLine(`          ${dropCode};`);
                      }
                    }
                  }
                }

                // Restore context
                context.inAsyncStateMachine = previousInStateMachineForBranch;
                context.stateMachineVariables =
                  previousStateMachineVariablesForBranch;
                context.variableIdRemapping =
                  previousVariableIdRemappingForBranch;
                context.pendingDeferredDrops =
                  previousPendingDeferredDropsForBranch;
              }

              emitter.emitLine(`          break;`);
              emitter.emitLine(`        }`);
            }
          }

          emitter.emitLine(`      }`);

          // Process chained branches (outer cond's remaining code after nested cond's switch)
          if (condBranchData.chainedBranches) {
            for (const chainedLayer of condBranchData.chainedBranches) {
              for (const chainedBranch of chainedLayer.branches) {
                if (
                  chainedBranch.hasAwait &&
                  chainedBranch.remainingExprs &&
                  chainedBranch.remainingExprs.length > 0
                ) {
                  // Set up state machine context for code generation
                  const previousInStateMachineForChained =
                    context.inAsyncStateMachine;
                  const previousStateMachineVariablesForChained =
                    context.stateMachineVariables;
                  const previousVariableIdRemappingForChained =
                    context.variableIdRemapping;
                  const previousPendingDeferredDropsForChained =
                    context.pendingDeferredDrops;

                  context.inAsyncStateMachine = { futureType };
                  context.variableIdRemapping = analysis.variableIdRemapping;
                  context.pendingDeferredDrops = [
                    ...(bodyExpr.$?.deferredDropExpressions ?? []),
                  ];
                  const combinedVariablesChained = new Map<
                    string,
                    CapturedVariable
                  >();
                  for (const v of analysis.capturedVariables) {
                    combinedVariablesChained.set(v.id, v);
                  }
                  if (captureType) {
                    for (const field of captureType.fields) {
                      combinedVariablesChained.set(field.label, {
                        id: field.label,
                        name: field.label,
                        type: field.type,
                        kind: "outer",
                        isOwningTheSameRcValueAs: undefined,
                      });
                    }
                  }
                  context.stateMachineVariables = combinedVariablesChained;

                  const hasAdditionalCondAwaitChained =
                    segment.awaitPoint?.isInsideCond ?? false;
                  let foundAdditionalAwaitChained = false;
                  const additionalRemainingExprsChained: Expr[] = [];

                  for (const expr of chainedBranch.remainingExprs) {
                    if (foundAdditionalAwaitChained) {
                      additionalRemainingExprsChained.push(expr);
                      continue;
                    }

                    if (
                      hasAdditionalCondAwaitChained &&
                      exprContainsAwait(expr)
                    ) {
                      foundAdditionalAwaitChained = true;
                      generateRemainingExprFuture(
                        expr,
                        segment.awaitPoint!,
                        analysis,
                        "      ",
                        context
                      );
                      continue;
                    }

                    const code = generateExpr(expr, "      ", context);
                    if (
                      !code ||
                      !expr.$ ||
                      isTempVariableName(expr.$.env.modulePath, code)
                    ) {
                      // Skip
                    } else {
                      emitter.emitLine(`      ${code};`);
                    }
                  }

                  if (foundAdditionalAwaitChained && segment.awaitPoint) {
                    const nextIndex = segment.awaitPoint.index;
                    if (!functionContext.asyncCondBranchInfo) {
                      functionContext.asyncCondBranchInfo = new Map();
                    }
                    const existingChained =
                      functionContext.asyncCondBranchInfo.get(nextIndex);
                    if (existingChained) {
                      if (!existingChained.chainedBranches) {
                        existingChained.chainedBranches = [];
                      }
                      existingChained.chainedBranches.push({
                        branches: [
                          {
                            index: chainedBranch.index,
                            value: chainedBranch.value,
                            hasAwait:
                              additionalRemainingExprsChained.length > 0 ||
                              additionalRemainingExprsChained.some((e) =>
                                exprContainsAwait(e)
                              ),
                            remainingExprs: additionalRemainingExprsChained,
                            deferredDropExpressions:
                              chainedBranch.deferredDropExpressions,
                          },
                        ],
                        condBranchFieldIndex: chainedLayer.condBranchFieldIndex,
                      });
                    } else {
                      functionContext.asyncCondBranchInfo.set(nextIndex, {
                        branches: [
                          {
                            index: chainedBranch.index,
                            value: chainedBranch.value,
                            hasAwait:
                              additionalRemainingExprsChained.length > 0 ||
                              additionalRemainingExprsChained.some((e) =>
                                exprContainsAwait(e)
                              ),
                            remainingExprs: additionalRemainingExprsChained,
                            deferredDropExpressions:
                              chainedBranch.deferredDropExpressions,
                          },
                        ],
                        condBranchFieldIndex: chainedLayer.condBranchFieldIndex,
                      });
                    }
                  } else {
                    if (chainedBranch.deferredDropExpressions) {
                      for (const dropExpr of chainedBranch.deferredDropExpressions) {
                        const dropCode = generateExpr(
                          dropExpr,
                          "      ",
                          context
                        );
                        if (dropCode && dropCode.includes("sm->")) {
                          emitter.emitLine(`      ${dropCode};`);
                        }
                      }
                    }
                  }

                  context.inAsyncStateMachine =
                    previousInStateMachineForChained;
                  context.stateMachineVariables =
                    previousStateMachineVariablesForChained;
                  context.variableIdRemapping =
                    previousVariableIdRemappingForChained;
                  context.pendingDeferredDrops =
                    previousPendingDeferredDropsForChained;
                }
              }
            }
          }

          // If the cond result is assigned to a variable, assign the await result now
          if (condBranchData.targetVariableId) {
            const fieldName = getStateMachineFieldName(
              condBranchData.targetVariableId,
              "local"
            );
            emitter.emitLine(`      // Assign cond result to target variable`);
            emitter.emitLine(
              `      sm->${fieldName} = sm->await_result_${prevAwait.index};`
            );
          }
          // Note: targetAssignmentCode is handled inside each branch's remaining
          // expression generation (the last expression is assigned to the target)

          emitter.emitLine(``);
        }

        // Close the isInsideCond NULL guard
        if (prevAwait.isInsideCond) {
          emitter.emitLine(`      }`);
        }

        // Check if this await was part of a while loop
        // If so, we need to execute remaining body expressions, then re-evaluate the loop condition
        const whileLoopData = functionContext.asyncWhileLoopInfo?.get(
          prevAwait.index
        );
        if (whileLoopData) {
          emitter.emitLine(
            `      // Execute remaining code from while loop body and continue loop`
          );
          emitter.emitLine(
            `      if (sm->while_loop_${prevAwait.index}_active) {`
          );

          // If there are remaining expressions after the await, generate them
          if (
            whileLoopData.bodyExprsAfterAwait &&
            whileLoopData.bodyExprsAfterAwait.length > 0
          ) {
            // Set up state machine context for code generation
            const previousInStateMachineForLoop = context.inAsyncStateMachine;
            const previousStateMachineVariablesForLoop =
              context.stateMachineVariables;
            const previousVariableIdRemappingForLoop =
              context.variableIdRemapping;
            const previousPendingDeferredDropsForLoop =
              context.pendingDeferredDrops;

            context.inAsyncStateMachine = { futureType };
            context.variableIdRemapping = analysis.variableIdRemapping;
            context.pendingDeferredDrops = [
              ...(whileLoopData.bodyExpr.$?.deferredDropExpressions ?? []),
              ...(bodyExpr.$?.deferredDropExpressions ?? []),
            ];

            // Combine outer captured variables and local variables
            const combinedVariables = new Map<string, CapturedVariable>();
            for (const v of analysis.capturedVariables) {
              combinedVariables.set(v.id, v);
            }
            if (captureType) {
              for (const field of captureType.fields) {
                combinedVariables.set(field.label, {
                  id: field.label,
                  name: field.label,
                  type: field.type,
                  kind: "outer",
                  isOwningTheSameRcValueAs: undefined, // FIXME
                });
              }
            }
            context.stateMachineVariables = combinedVariables;

            // Set up break/continue handling: in the state machine switch, plain "break"
            // and "continue" don't work as expected. We need goto instead.
            const previousSmWhileBreakInfo = context.smWhileBreakInfo;
            const previousSmWhileContinueInfo = context.smWhileContinueInfo;
            const previousSmWhileBodyDrops = context.smWhileBodyDrops;
            context.smWhileBreakInfo = {
              label: `after_while_loop_${prevAwait.index}`,
              activeIndex: prevAwait.index,
            };
            context.smWhileContinueInfo = {
              label: `while_loop_${prevAwait.index}_continue`,
            };
            context.smWhileBodyDrops = [
              ...(whileLoopData.bodyExpr.$?.deferredDropExpressions ?? []),
            ];

            // Generate the remaining expressions
            for (const expr of whileLoopData.bodyExprsAfterAwait) {
              const code = generateExpr(expr, "        ", context);
              // Skip empty code, expressions without metadata, and temp variable references
              if (
                !code ||
                !expr.$ ||
                isTempVariableName(expr.$.env.modulePath, code)
              ) {
                // Skip
              } else {
                emitter.emitLine(`        ${code};`);
              }
            }

            // Restore context
            context.smWhileBreakInfo = previousSmWhileBreakInfo;
            context.smWhileContinueInfo = previousSmWhileContinueInfo;
            context.smWhileBodyDrops = previousSmWhileBodyDrops;
            context.inAsyncStateMachine = previousInStateMachineForLoop;
            context.stateMachineVariables =
              previousStateMachineVariablesForLoop;
            context.variableIdRemapping = previousVariableIdRemappingForLoop;
            context.pendingDeferredDrops = previousPendingDeferredDropsForLoop;
          }

          // Label for continue to jump to (skip rest of body, re-evaluate condition)
          emitter.emitLine(`      while_loop_${prevAwait.index}_continue:`);

          // Drop while loop body locals before condition re-evaluation
          // Both normal fall-through and explicit 'continue' reach this label
          {
            const whileBodyDrops =
              whileLoopData.bodyExpr.$?.deferredDropExpressions ?? [];
            if (whileBodyDrops.length > 0) {
              const prevInSM = context.inAsyncStateMachine;
              const prevSMVars = context.stateMachineVariables;
              const prevVarRemap = context.variableIdRemapping;
              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;

              const dropCombinedVars = new Map<string, CapturedVariable>();
              for (const v of analysis.capturedVariables) {
                dropCombinedVars.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  dropCombinedVars.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = dropCombinedVars;

              for (const dropExpr of whileBodyDrops) {
                const dropCode = generateExpr(dropExpr, "        ", context);
                if (dropCode && dropCode.includes("sm->")) {
                  emitter.emitLine(`        ${dropCode};`);
                }
              }

              context.inAsyncStateMachine = prevInSM;
              context.stateMachineVariables = prevSMVars;
              context.variableIdRemapping = prevVarRemap;
            }
          }

          // Re-evaluate the loop condition
          emitter.emitLine(
            `        ASYNC_DEBUG("${asyncBlockId}: Re-evaluating while loop condition\\n");`
          );

          // Set up state machine context for condition evaluation
          const previousInStateMachineForCond = context.inAsyncStateMachine;
          const previousStateMachineVariablesForCond =
            context.stateMachineVariables;
          const previousVariableIdRemappingForCond =
            context.variableIdRemapping;

          context.inAsyncStateMachine = { futureType };
          context.variableIdRemapping = analysis.variableIdRemapping;

          // Combine outer captured variables and local variables
          const combinedVariablesForCond = new Map<string, CapturedVariable>();
          for (const v of analysis.capturedVariables) {
            combinedVariablesForCond.set(v.id, v);
          }
          if (captureType) {
            for (const field of captureType.fields) {
              combinedVariablesForCond.set(field.label, {
                id: field.label,
                name: field.label,
                type: field.type,
                kind: "outer",
                isOwningTheSameRcValueAs: undefined, // FIXME
              });
            }
          }
          context.stateMachineVariables = combinedVariablesForCond;

          // Generate condition check
          const condCode = generateExpr(
            whileLoopData.conditionExpr,
            "        ",
            context
          );

          // Restore context
          context.inAsyncStateMachine = previousInStateMachineForCond;
          context.stateMachineVariables = previousStateMachineVariablesForCond;
          context.variableIdRemapping = previousVariableIdRemappingForCond;

          emitter.emitLine(`        if (!(${condCode})) {`);
          emitter.emitLine(
            `          sm->while_loop_${prevAwait.index}_active = false;`
          );
          emitter.emitLine(
            `          ASYNC_DEBUG("${asyncBlockId}: While loop condition false, exiting loop\\n");`
          );
          emitter.emitLine(`        } else {`);
          emitter.emitLine(
            `          ASYNC_DEBUG("${asyncBlockId}: While loop condition true, continuing iteration\\n");`
          );

          // Transition back to the state where the while loop started
          // The while loop is in the state that contains the await - which is prevAwait.index
          const whileLoopStateNumber = prevAwait.index;
          emitter.emitLine(
            `          // Loop back by transitioning to while loop state`
          );
          emitter.emitLine(`          sm->state = ${whileLoopStateNumber};`);
          emitter.emitLine(
            `          goto while_loop_${whileLoopStateNumber}_start;`
          );

          emitter.emitLine(`        }`);
          emitter.emitLine(`      }`);

          emitter.emitLine(``);
          // Add label for code after while loop (for break to jump to)
          emitter.emitLine(`      after_while_loop_${prevAwait.index}:`);

          // Handle outer while loop continuation (for nested while-with-await)
          if (whileLoopData.outerWhileLoop) {
            const outerWhile = whileLoopData.outerWhileLoop;
            const outerIndex = outerWhile.whileLoopIndex;

            emitter.emitLine(
              `      // Execute remaining code from outer while loop body`
            );
            emitter.emitLine(
              `      if (sm->while_loop_${outerIndex}_active) {`
            );

            // Generate the outer while's remaining body expressions
            if (outerWhile.bodyExprsAfterAwait.length > 0) {
              const prevInSMOuter = context.inAsyncStateMachine;
              const prevSMVarsOuter = context.stateMachineVariables;
              const prevVarRemapOuter = context.variableIdRemapping;
              const prevPendingDropsOuter = context.pendingDeferredDrops;

              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;
              context.pendingDeferredDrops = [
                ...(outerWhile.bodyExpr.$?.deferredDropExpressions ?? []),
                ...(bodyExpr.$?.deferredDropExpressions ?? []),
              ];

              const outerCombinedVars = new Map<string, CapturedVariable>();
              for (const v of analysis.capturedVariables) {
                outerCombinedVars.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  outerCombinedVars.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = outerCombinedVars;

              const prevBreakInfoOuter = context.smWhileBreakInfo;
              const prevContinueInfoOuter = context.smWhileContinueInfo;
              const prevBodyDropsOuter = context.smWhileBodyDrops;
              context.smWhileBreakInfo = {
                label: `after_while_loop_${outerIndex}`,
                activeIndex: outerIndex,
              };
              context.smWhileContinueInfo = {
                label: `while_loop_${outerIndex}_continue`,
              };
              context.smWhileBodyDrops = [
                ...(outerWhile.bodyExpr.$?.deferredDropExpressions ?? []),
              ];

              for (const expr of outerWhile.bodyExprsAfterAwait) {
                const code = generateExpr(expr, "        ", context);
                if (
                  !code ||
                  !expr.$ ||
                  isTempVariableName(expr.$.env.modulePath, code)
                ) {
                  // Skip
                } else {
                  emitter.emitLine(`        ${code};`);
                }
              }

              context.smWhileBreakInfo = prevBreakInfoOuter;
              context.smWhileContinueInfo = prevContinueInfoOuter;
              context.smWhileBodyDrops = prevBodyDropsOuter;
              context.inAsyncStateMachine = prevInSMOuter;
              context.stateMachineVariables = prevSMVarsOuter;
              context.variableIdRemapping = prevVarRemapOuter;
              context.pendingDeferredDrops = prevPendingDropsOuter;
            }

            // Label for outer while continue
            emitter.emitLine(`      while_loop_${outerIndex}_continue:`);

            // Drop outer while body locals before condition re-evaluation
            {
              const outerDrops =
                outerWhile.bodyExpr.$?.deferredDropExpressions ?? [];
              if (outerDrops.length > 0) {
                const prevInSM2 = context.inAsyncStateMachine;
                const prevSMVars2 = context.stateMachineVariables;
                const prevVarRemap2 = context.variableIdRemapping;
                context.inAsyncStateMachine = { futureType };
                context.variableIdRemapping = analysis.variableIdRemapping;

                const dropVars2 = new Map<string, CapturedVariable>();
                for (const v of analysis.capturedVariables) {
                  dropVars2.set(v.id, v);
                }
                if (captureType) {
                  for (const field of captureType.fields) {
                    dropVars2.set(field.label, {
                      id: field.label,
                      name: field.label,
                      type: field.type,
                      kind: "outer",
                      isOwningTheSameRcValueAs: undefined,
                    });
                  }
                }
                context.stateMachineVariables = dropVars2;

                for (const dropExpr of outerDrops) {
                  const dropCode = generateExpr(dropExpr, "        ", context);
                  if (dropCode && dropCode.includes("sm->")) {
                    emitter.emitLine(`        ${dropCode};`);
                  }
                }

                context.inAsyncStateMachine = prevInSM2;
                context.stateMachineVariables = prevSMVars2;
                context.variableIdRemapping = prevVarRemap2;
              }
            }

            // Re-evaluate outer while condition
            {
              const prevInSM3 = context.inAsyncStateMachine;
              const prevSMVars3 = context.stateMachineVariables;
              const prevVarRemap3 = context.variableIdRemapping;
              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;

              const condVars3 = new Map<string, CapturedVariable>();
              for (const v of analysis.capturedVariables) {
                condVars3.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  condVars3.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = condVars3;

              const outerCondCode = generateExpr(
                outerWhile.conditionExpr,
                "        ",
                context
              );

              context.inAsyncStateMachine = prevInSM3;
              context.stateMachineVariables = prevSMVars3;
              context.variableIdRemapping = prevVarRemap3;

              emitter.emitLine(`        if (!(${outerCondCode})) {`);
              emitter.emitLine(
                `          sm->while_loop_${outerIndex}_active = false;`
              );
              emitter.emitLine(`        } else {`);
              emitter.emitLine(`          sm->state = ${prevAwait.index};`);
              emitter.emitLine(
                `          goto while_loop_${outerIndex}_start;`
              );
              emitter.emitLine(`        }`);
            }

            emitter.emitLine(`      }`);
            emitter.emitLine(``);
            emitter.emitLine(`      after_while_loop_${outerIndex}:`);
          }
        }
      }
    }

    // Set up state machine context
    const previousInStateMachine = context.inAsyncStateMachine;
    const previousStateMachineVariables = context.stateMachineVariables;
    const previousVariableIdRemapping = context.variableIdRemapping;

    context.inAsyncStateMachine = { futureType };
    context.variableIdRemapping = analysis.variableIdRemapping;
    // Combine outer captured variables and local variables into stateMachineVariables
    // This allows generateAtom to find all variables that should be accessed via sm->
    const combinedVariables = new Map<string, CapturedVariable>();

    // Add local variables from the analysis
    for (const v of analysis.capturedVariables) {
      combinedVariables.set(v.id, v);
    }

    // Add outer captured variables from the capture struct
    // We create synthetic entries with the variable name as the ID
    // Access will be through sm->__capture.varName
    if (captureType) {
      for (const field of captureType.fields) {
        combinedVariables.set(field.label, {
          id: field.label, // Use label as ID
          name: field.label,
          type: field.type,
          kind: "outer",
          isOwningTheSameRcValueAs: undefined,
        });
      }
    }

    context.stateMachineVariables = combinedVariables;

    // Set pending deferred drops from the body expression
    // These need to be generated when the async function completes early (e.g., from a cond branch)
    const previousPendingDeferredDrops = context.pendingDeferredDrops;
    context.pendingDeferredDrops = [
      ...(bodyExpr.$?.deferredDropExpressions ?? []),
    ];

    // Generate the code for this segment
    // For the last segment, we need to capture the final expression's value
    const isLastSegmentWithResult =
      isLastSegment && !isUnitResult && segment.expressions.length > 0;
    generateStateSegmentCode(
      segment,
      "      ",
      context,
      isLastSegmentWithResult
    );

    // Restore pending deferred drops
    context.pendingDeferredDrops = previousPendingDeferredDrops;

    emitter.emitLine(``);

    if (segment.awaitPoint) {
      // Restore previous context before await logic
      context.inAsyncStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;

      // This segment ends with an await or join - generate the suspension logic
      const nextState = stateNumber + 1;

      if (segment.awaitPoint.isJoinPoint) {
        // === JOIN POINT: wait for multiple futures concurrently ===
        const joinIndex = segment.awaitPoint.index;
        const futureVarIds = segment.awaitPoint.joinFutureVariableIds!;
        const futureCount = segment.awaitPoint.joinFutureCount!;
        const notifyFnName = `${asyncBlockId}_join_${joinIndex}_notify`;

        emitter.emitLine(
          `      // Join point ${joinIndex} — wait for ${futureCount} futures`
        );
        emitter.emitLine(`      sm->state = ${nextState};`);
        emitter.emitLine(
          `      atomic_store_explicit(&sm->join_pending_${joinIndex}, ${futureCount}, memory_order_release);`
        );
        emitter.emitLine(``);

        // For each future being joined, generate start/register logic
        for (let fi = 0; fi < futureVarIds.length; fi++) {
          const futureFieldName = getFutureFieldNameByVariableId(
            futureVarIds[fi]!,
            analysis
          );
          const joinFutureIsIo = isIoFutureType(
            segment.awaitPoint.joinFutureTypes?.[fi]
          );
          emitter.emitLine(
            `      // Join future ${fi}: sm->${futureFieldName}`
          );
          emitter.emitLine(`      {`);
          emitter.emitLine(
            `        int fs_${fi} = atomic_load_explicit(&sm->${futureFieldName}->state, memory_order_acquire);`
          );
          emitter.emitLine(`        if (fs_${fi} == -1 || fs_${fi} == -3) {`);
          emitter.emitLine(
            `          // Already complete or aborted — decrement counter directly`
          );
          emitter.emitLine(
            `          int prev_${fi} = atomic_fetch_sub_explicit(&sm->join_pending_${joinIndex}, 1, memory_order_acq_rel);`
          );
          emitter.emitLine(`          if (prev_${fi} == 1) {`);
          emitter.emitLine(
            `            // All futures done (all were pre-completed/aborted) — resume immediately`
          );
          emitter.emitLine(`            goto state_${nextState};`);
          emitter.emitLine(`          }`);
          emitter.emitLine(`        } else {`);
          emitter.emitLine(
            `          // Not complete — take event loop refs and start/register`
          );
          emitter.emitLine(
            `          __yo_incr_rc((void*)sm);  // event loop ref for notify`
          );
          emitter.emitLine(
            `          __yo_incr_rc((void*)sm->${futureFieldName});  // event loop ref for future`
          );
          emitter.emitLine(
            `          // Set notify function as continuation BEFORE starting`
          );
          emitter.emitLine(
            `          atomic_store_explicit(&sm->${futureFieldName}->continuation_fn, (void (*)(void*))${notifyFnName}, memory_order_release);`
          );
          emitter.emitLine(
            `          atomic_store_explicit(&sm->${futureFieldName}->continuation_sm, (void*)sm, memory_order_release);`
          );
          if (!joinFutureIsIo) {
            emitter.emitLine(`          if (fs_${fi} == 0) {`);
            emitter.emitLine(`            // Cold future — start it`);
            emitter.emitLine(
              `            sm->${futureFieldName}->__yo_resume_fn((void*)sm->${futureFieldName});`
            );
            emitter.emitLine(`          }`);
          }
          emitter.emitLine(`        }`);
          emitter.emitLine(`      }`);
          emitter.emitLine(``);
        }

        emitter.emitLine(
          `      // All futures started/registered — suspend, notify will resume us`
        );
        emitter.emitLine(`      return;`);
      } else {
        // === SINGLE AWAIT POINT ===
        const futureFieldName = getFutureFieldName(
          segment.awaitPoint,
          analysis
        );

        // Determine if the future is an IO future (yo_io_future_t) which is
        // already submitted to io_uring and doesn't have __yo_resume_fn.
        const awaitExprForTypeCheck = segment.awaitPoint.expr as {
          args?: Expr[];
        };
        const futureExprForTypeCheck = awaitExprForTypeCheck.args?.[0];
        const isIoFuture = isIoFutureType(futureExprForTypeCheck?.$?.type);

        // If this await is inside a cond expression, the future may not be set
        // (the non-await branch was taken). Guard the await logic with a NULL check.
        const isInsideCond = segment.awaitPoint?.isInsideCond;
        if (isInsideCond) {
          emitter.emitLine(
            `      // Only await if the cond branch with await was taken`
          );
          emitter.emitLine(`      if (sm->${futureFieldName} != NULL) {`);
        }

        // If this await is inside a while loop, wrap the await logic in a check for loop active flag
        const isInsideWhile = segment.awaitPoint?.isInsideWhile;
        if (isInsideWhile) {
          const whileLoopIndex = segment.awaitPoint.index;
          emitter.emitLine(
            `      // Only await if while loop is still active (not broken)`
          );
          emitter.emitLine(
            `      if (sm->while_loop_${whileLoopIndex}_active) {`
          );
        }

        emitter.emitLine(`      // Transition to next state after await`);
        emitter.emitLine(`      sm->state = ${nextState};`);
        emitter.emitLine(``);
        emitter.emitLine(`      // Check if future is ready`);
        emitter.emitLine(
          `      int future_state = atomic_load_explicit(&sm->${futureFieldName}->state, memory_order_acquire);`
        );
        emitter.emitLine(
          `      if (future_state == -1 || future_state == -3) {  // -1 = completed, -3 = aborted`
        );
        emitter.emitLine(
          `        // Already complete or aborted — yield once for fairness`
        );
        emitter.emitLine(
          `        // Yield once to event loop for fairness (microtask yield)`
        );
        emitter.emitLine(
          `        yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, (void*)sm);`
        );
        emitter.emitLine(`        return;`);
        emitter.emitLine(`      }`);
        emitter.emitLine(``);
        // Cold future: start it via stored resume function pointer
        // IO futures (yo_io_future_t) are already submitted to io_uring and don't
        // have __yo_resume_fn — skip cold-start for them.
        emitter.emitLine(
          `      // Future not complete — take event loop reference${isIoFuture ? "" : " and start if cold"}`
        );
        emitter.emitLine(
          `      __yo_incr_rc((void*)sm->${futureFieldName});  // event loop reference`
        );
        if (!isIoFuture) {
          emitter.emitLine(
            `      if (future_state == 0) {  // 0 = cold (not started)`
          );
          emitter.emitLine(
            `        // Cold future — start it via stored resume function pointer`
          );
          emitter.emitLine(
            `        sm->${futureFieldName}->__yo_resume_fn((void*)sm->${futureFieldName});`
          );
          emitter.emitLine(``);
          emitter.emitLine(
            `        // Re-check: may have completed synchronously`
          );
          emitter.emitLine(
            `        future_state = atomic_load_explicit(&sm->${futureFieldName}->state, memory_order_acquire);`
          );
          emitter.emitLine(
            `        if (future_state == -1 || future_state == -3) {`
          );
          emitter.emitLine(
            `          // Completed or aborted synchronously — yield for fairness`
          );
          emitter.emitLine(
            `          yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, (void*)sm);`
          );
          emitter.emitLine(`          return;`);
          emitter.emitLine(`        }`);
          emitter.emitLine(`      }`);
        }
        emitter.emitLine(``);
        // Register continuation directly on the future (type-specific access)
        emitter.emitLine(
          `      // Still pending — register continuation and suspend`
        );
        emitter.emitLine(
          `      atomic_store_explicit(&sm->${futureFieldName}->continuation_fn, (void (*)(void*))${resumeFunctionName}, memory_order_release);`
        );
        emitter.emitLine(
          `      atomic_store_explicit(&sm->${futureFieldName}->continuation_sm, (void*)sm, memory_order_release);`
        );
        emitter.emitLine(`      return;`);

        if (isInsideWhile) {
          const whileLoopIndex = segment.awaitPoint.index;
          // Add else branch to jump to code after while loop when broken
          emitter.emitLine(`      } else {`);
          emitter.emitLine(
            `        // While loop was broken, jump to code after loop`
          );
          emitter.emitLine(`        goto after_while_loop_${whileLoopIndex};`);
          emitter.emitLine(`      }`);
        }

        if (isInsideCond) {
          emitter.emitLine(`      } else {`);
          emitter.emitLine(
            `        // Non-await cond branch was taken, skip directly to next state`
          );
          emitter.emitLine(`        sm->state = ${nextState};`);
          emitter.emitLine(`        goto state_${nextState};`);
          emitter.emitLine(`      }`);
        }
      } // end of else (single await) branch
    } else if (isLastSegment) {
      // Last segment - complete the Future
      const hasReturnStatement = segment.expressions.some((expr: Expr) =>
        exprContainsReturn(expr)
      );

      if (!hasReturnStatement) {
        // Generate deferred drops for the body expression before completing the Future
        // Keep state machine context active for this
        if (bodyExpr.$?.deferredDropExpressions) {
          emitter.emitLine(`      // Drop local variables before completion`);
          for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
            const dropCode = generateExpr(dropExpr, "      ", context);
            if (dropCode) {
              emitter.emitLine(`      ${dropCode};`);
            }
          }
          emitter.emitLine(``);
        }

        emitter.emitLine(`      // Final state - complete the Future`);

        emitAsyncFutureCompletion({
          emitter,
          indent: "      ",
          debugLabel: `Future %p completed`,
        });
      }

      // Restore previous context after final state
      context.inAsyncStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;
    } else {
      // Restore previous context for non-await, non-final segments
      context.inAsyncStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;
    }

    emitter.emitLine(`    }`);
  }

  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);
}

/**
 * Generates code to store the future from an await expression found in cond branch remaining expressions.
 * This handles the case where a cond branch has multiple sequential awaits.
 */
function generateRemainingExprFuture(
  expr: Expr,
  awaitPoint: AwaitPoint,
  analysis: AwaitAnalysisResult,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const futureFieldName = getFutureFieldName(awaitPoint, analysis);

  // Handle: varName := await(futureExpr)
  if (expr.tag === ExprTag.FnCall && exprIsFunctionCallOf(expr, ":=")) {
    const valueExpr = expr.args[1];
    if (
      valueExpr &&
      valueExpr.tag === ExprTag.FnCall &&
      isIoAwaitCall(valueExpr)
    ) {
      const futureExpr = valueExpr.args[0];
      if (futureExpr) {
        const futureCode = generateExpr(futureExpr, indent, context);
        emitter.emitLine(
          `${indent}// Store Future for additional await in cond branch`
        );
        emitter.emitLine(`${indent}sm->${futureFieldName} = ${futureCode};`);
      }
    }
    return;
  }

  // Handle: io.await(futureExpr)
  if (expr.tag === ExprTag.FnCall && isIoAwaitCall(expr)) {
    const futureExpr = expr.args[0];
    if (futureExpr) {
      const futureCode = generateExpr(futureExpr, indent, context);
      emitter.emitLine(
        `${indent}// Store Future for additional await in cond branch`
      );
      emitter.emitLine(`${indent}sm->${futureFieldName} = ${futureCode};`);
    }
    return;
  }

  // Handle: cond(... => { await ... }, ...) - nested cond with await in branches
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.cond)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  // Handle: match(... => { await ... }, ...) - nested match with await in branches
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.match)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  // Handle: while ... { await ... } - while loop with await in body
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.while)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  // Handle: begin block that contains an await somewhere inside
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  emitter.emitLine(
    `${indent}// Warning: unhandled await pattern in remaining expressions`
  );
}

/**
 * Recursively checks if an expression contains a return statement.
 * Handles both bare `return` atoms and `return(value)` function calls,
 * and recurses into begin blocks, cond branches, etc.
 */
function exprContainsReturn(expr: Expr): boolean {
  // Bare `return` atom (no return value)
  if (exprIsAtomOf(expr, "return")) {
    return true;
  }
  // `return(value)` function call
  if (exprIsFunctionCallOf(expr, "return")) {
    return true;
  }
  // Recurse into begin blocks, cond branches, etc.
  if (expr.tag === ExprTag.FnCall) {
    for (const arg of expr.args) {
      if (exprContainsReturn(arg)) {
        return true;
      }
    }
  }
  return false;
}
