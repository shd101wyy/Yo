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
import { extractFutureTraitFromType } from "../../evaluator/trait-checking";
import {
  type Expr,
  BuiltinFunctions,
  BuiltinKeywords,
  exprIsFunctionCallOf,
  ExprTag,
} from "../../expr";
import type { DynType, SomeType, StructType } from "../../types/definitions";
import { isDynType, isSomeType, isUnitType } from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { emitAsyncFutureCompletion } from "../exprs/async-completion";
import { getDupFunctionForType } from "../exprs/drop-dup";
import { generateExpr } from "../exprs/expr";
import type { FunctionGenerationContext } from "../functions/context";
import { sanitizeForCIdentifier } from "../utils";
import {
  exprContainsAwait,
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

  // Clear condBranchInfo for this async block to prevent branch info
  // from other async blocks (or outer scopes) from leaking in.
  // Each async block should only see its own branch information.
  context.condBranchInfo = new Map();

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

      if (prevAwait && !isUnitType(prevAwait.resultType)) {
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
      if (!prevAwait.futureVariableId) {
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
        const condBranchData = functionContext.condBranchInfo?.get(
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
                const previousInStateMachineForBranch = context.inStateMachine;
                const previousStateMachineVariablesForBranch =
                  context.stateMachineVariables;
                const previousVariableIdRemappingForBranch =
                  context.variableIdRemapping;
                const previousPendingDeferredDropsForBranch =
                  context.pendingDeferredDrops;

                context.inStateMachine = { futureType };
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

                for (const expr of branch.remainingExprs) {
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
                  } else {
                    emitter.emitLine(`          ${code};`);
                  }
                }

                if (foundAdditionalAwait && segment.awaitPoint) {
                  // Store continuation info for the next state
                  const nextIndex = segment.awaitPoint.index;
                  if (!functionContext.condBranchInfo) {
                    functionContext.condBranchInfo = new Map();
                  }
                  const existing =
                    functionContext.condBranchInfo.get(nextIndex);
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
                    functionContext.condBranchInfo.set(nextIndex, newEntry);
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
                context.inStateMachine = previousInStateMachineForBranch;
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
                    context.inStateMachine;
                  const previousStateMachineVariablesForChained =
                    context.stateMachineVariables;
                  const previousVariableIdRemappingForChained =
                    context.variableIdRemapping;
                  const previousPendingDeferredDropsForChained =
                    context.pendingDeferredDrops;

                  context.inStateMachine = { futureType };
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
                    if (!functionContext.condBranchInfo) {
                      functionContext.condBranchInfo = new Map();
                    }
                    const existingChained =
                      functionContext.condBranchInfo.get(nextIndex);
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
                      functionContext.condBranchInfo.set(nextIndex, {
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

                  context.inStateMachine = previousInStateMachineForChained;
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

          emitter.emitLine(``);
        }

        // Close the isInsideCond NULL guard
        if (prevAwait.isInsideCond) {
          emitter.emitLine(`      }`);
        }

        // Check if this await was part of a while loop
        // If so, we need to execute remaining body expressions, then re-evaluate the loop condition
        const whileLoopData = functionContext.whileLoopInfo?.get(
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
            const previousInStateMachineForLoop = context.inStateMachine;
            const previousStateMachineVariablesForLoop =
              context.stateMachineVariables;
            const previousVariableIdRemappingForLoop =
              context.variableIdRemapping;

            context.inStateMachine = { futureType };
            context.variableIdRemapping = analysis.variableIdRemapping;

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

            // Set up break handling: in the state machine switch, plain "break" exits
            // the switch, not the conceptual while loop. We need goto instead.
            const previousAsyncWhileBreakInfo = context.asyncWhileBreakInfo;
            context.asyncWhileBreakInfo = {
              label: `after_while_loop_${prevAwait.index}`,
              index: prevAwait.index,
            };

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
            context.asyncWhileBreakInfo = previousAsyncWhileBreakInfo;
            context.inStateMachine = previousInStateMachineForLoop;
            context.stateMachineVariables =
              previousStateMachineVariablesForLoop;
            context.variableIdRemapping = previousVariableIdRemappingForLoop;
          }

          // Re-evaluate the loop condition
          emitter.emitLine(
            `        ASYNC_DEBUG("${asyncBlockId}: Re-evaluating while loop condition\\n");`
          );

          // Set up state machine context for condition evaluation
          const previousInStateMachineForCond = context.inStateMachine;
          const previousStateMachineVariablesForCond =
            context.stateMachineVariables;
          const previousVariableIdRemappingForCond =
            context.variableIdRemapping;

          context.inStateMachine = { futureType };
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
          context.inStateMachine = previousInStateMachineForCond;
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
        }
      }
    }

    // Set up state machine context
    const previousInStateMachine = context.inStateMachine;
    const previousStateMachineVariables = context.stateMachineVariables;
    const previousVariableIdRemapping = context.variableIdRemapping;

    context.inStateMachine = { futureType };
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
      context.inStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;

      // This segment ends with an await - generate the await logic
      const nextState = stateNumber + 1;
      const futureFieldName = getFutureFieldName(segment.awaitPoint, analysis);

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
      emitter.emitLine(`      if (future_state == -1) {  // -1 = completed`);
      emitter.emitLine(
        `        // Yield once even when ready (microtask semantics), then resume in next tick`
      );
      emitter.emitLine(
        `        yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, (void*)sm);`
      );
      emitter.emitLine(`        return;`);
      emitter.emitLine(`      } else {`);
      // Register continuation directly on the future (type-specific access)
      emitter.emitLine(
        `        // Register continuation to be called when future completes`
      );
      emitter.emitLine(
        `        atomic_store_explicit(&sm->${futureFieldName}->continuation_fn, (void (*)(void*))${resumeFunctionName}, memory_order_release);`
      );
      emitter.emitLine(
        `        atomic_store_explicit(&sm->${futureFieldName}->continuation_sm, (void*)sm, memory_order_release);`
      );
      emitter.emitLine(`        return;`);
      emitter.emitLine(`      }`);

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
    } else if (isLastSegment) {
      // Last segment - complete the Future
      const hasReturnStatement = segment.expressions.some((expr: Expr) =>
        exprIsFunctionCallOf(expr, "return")
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
      context.inStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;
    } else {
      // Restore previous context for non-await, non-final segments
      context.inStateMachine = previousInStateMachine;
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
      exprIsFunctionCallOf(valueExpr, BuiltinFunctions.await)
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

  // Handle: await(futureExpr)
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.await)
  ) {
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
