/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import { Expr, exprIsFunctionCallOf } from "../../expr";
import {
  DynType,
  extractFutureModuleFromType,
  isUnitType,
  SomeType,
  StructType,
} from "../../types";
import { isTempVariableName } from "../../utils";
import { generateExpr } from "../expressions";
import { FunctionGenerationContext } from "../functions/context";
import { sanitizeForCIdentifier } from "../utils";
import {
  AwaitAnalysisResult,
  AwaitPoint,
  CapturedVariable,
} from "./await-analysis";
import {
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

  const futureModuleType = extractFutureModuleFromType(futureType)!;
  const childType = futureModuleType.isFuture.outputType;
  const isUnitResult = isUnitType(childType);

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
      const prevAwait = analysis.awaitPoints[stateNumber - 1];
      if (prevAwait && !isUnitType(prevAwait.resultType)) {
        const prevFutureFieldName = getFutureFieldName(prevAwait, analysis);
        emitter.emitLine(
          `      // Extract result from await ${stateNumber - 1}`
        );
        emitter.emitLine(
          `      yo_future_state_t state_before_read = atomic_load_explicit(&sm->${prevFutureFieldName}->state, memory_order_acquire);`
        );
        emitter.emitLine(
          `      ASYNC_DEBUG("${asyncBlockId}: Reading result from await ${stateNumber - 1}, state=%d\\n", state_before_read);`
        );
        emitter.emitLine(
          `      sm->await_result_${stateNumber - 1} = sm->${prevFutureFieldName}->result;`
        );

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

      // Check if this await was part of a cond expression
      // If so, we need to execute the remaining code from the chosen branch
      const functionContext = context as FunctionGenerationContext;
      if (prevAwait) {
        const condBranchData = functionContext.condBranchInfo?.get(
          prevAwait.index
        );
        if (condBranchData && condBranchData.branches.some((b) => b.hasAwait)) {
          emitter.emitLine(
            `      // Execute remaining code from chosen cond branch`
          );
          emitter.emitLine(
            `      switch (sm->cond_branch_${prevAwait.index}) {`
          );

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

                context.inStateMachine = { futureType };

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
                      isOwningTheSameGcValueAs: undefined, // FIXME
                    });
                  }
                }
                context.stateMachineVariables = combinedVariables;

                // Generate the remaining expressions
                for (const expr of branch.remainingExprs) {
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

                // Restore context
                context.inStateMachine = previousInStateMachineForBranch;
                context.stateMachineVariables =
                  previousStateMachineVariablesForBranch;
              }

              emitter.emitLine(`          break;`);
              emitter.emitLine(`        }`);
            }
          }

          emitter.emitLine(`      }`);

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

            context.inStateMachine = { futureType };

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
                  isOwningTheSameGcValueAs: undefined, // FIXME
                });
              }
            }
            context.stateMachineVariables = combinedVariables;

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
            context.inStateMachine = previousInStateMachineForLoop;
            context.stateMachineVariables =
              previousStateMachineVariablesForLoop;
          }

          // Re-evaluate the loop condition
          emitter.emitLine(
            `        ASYNC_DEBUG("${asyncBlockId}: Re-evaluating while loop condition\\n");`
          );

          // Set up state machine context for condition evaluation
          const previousInStateMachineForCond = context.inStateMachine;
          const previousStateMachineVariablesForCond =
            context.stateMachineVariables;

          context.inStateMachine = { futureType };

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
                isOwningTheSameGcValueAs: undefined, // FIXME
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

    context.inStateMachine = { futureType };

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
          isOwningTheSameGcValueAs: undefined,
        });
      }
    }

    context.stateMachineVariables = combinedVariables;

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

    emitter.emitLine(``);

    if (segment.awaitPoint) {
      // Restore previous context before await logic
      context.inStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;

      // This segment ends with an await - generate the await logic
      const nextState = stateNumber + 1;
      const futureFieldName = getFutureFieldName(segment.awaitPoint, analysis);

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
        `      yo_future_state_t future_state = atomic_load_explicit(&sm->${futureFieldName}->state, memory_order_acquire);`
      );
      emitter.emitLine(`      if (future_state == YO_FUTURE_COMPLETED) {`);
      emitter.emitLine(
        `        goto state_${nextState};  // Continue immediately`
      );
      emitter.emitLine(`      } else {`);
      emitter.emitLine(
        `        yo_async_register_continuation((void*)sm->${futureFieldName}, (void (*)(void*))${resumeFunctionName}, (void*)sm);`
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

        emitter.emitLine(`      // Final state - complete the result Future`);
        emitter.emitLine(
          `      atomic_store_explicit(&sm->result->state, YO_FUTURE_COMPLETED, memory_order_release);`
        );

        emitter.emitLine(``);
        emitter.emitLine(`      // Check if there's a continuation to invoke`);
        emitter.emitLine(
          `      void (*continuation_fn)(void*) = (void (*)(void*))atomic_load_explicit(&sm->result->continuation_fn, memory_order_acquire);`
        );
        emitter.emitLine(
          `      void* continuation_sm = atomic_load_explicit(&sm->result->continuation_sm, memory_order_acquire);`
        );
        emitter.emitLine(``);
        emitter.emitLine(`      if (continuation_fn != NULL) {`);
        emitter.emitLine(
          `        ASYNC_DEBUG("Future %p completed, spawning continuation: resume_fn=%p, sm=%p\\n", (void*)sm->result, (void*)continuation_fn, continuation_sm);`
        );
        emitter.emitLine(``);
        emitter.emitLine(
          `        // Clear the continuation (prevent double-spawn)`
        );
        emitter.emitLine(
          `        atomic_store_explicit(&sm->result->continuation_fn, NULL, memory_order_relaxed);`
        );
        emitter.emitLine(
          `        atomic_store_explicit(&sm->result->continuation_sm, NULL, memory_order_relaxed);`
        );
        emitter.emitLine(``);
        emitter.emitLine(`        // Spawn the continuation as a new task`);
        emitter.emitLine(
          `        yo_async_spawn_task(continuation_fn, continuation_sm);`
        );
        emitter.emitLine(`      }`);
        emitter.emitLine(``);

        emitter.emitLine(
          `      // Check if Future was detached (dropped while RUNNING)`
        );
        emitter.emitLine(
          `      bool was_detached = atomic_load_explicit(&sm->result->detached, memory_order_acquire);`
        );
        emitter.emitLine(`      if (was_detached) {`);
        emitter.emitLine(
          `        ASYNC_DEBUG("Future %p was detached, dropping now that it's completed\\n", (void*)sm->result);`
        );
        emitter.emitLine(
          `        // Drop the Future - this will decrement RC from 1->0 and free it`
        );
        emitter.emitLine(
          `        // The async runtime "owned" the last reference while it was RUNNING`
        );
        emitter.emitLine(`        __yo_future_drop((void*)sm->result);`);
        emitter.emitLine(`      }`);
        emitter.emitLine(``);

        emitter.emitLine(
          `      sm->state = ${stateNumber + 1};  // Terminal state`
        );
        emitter.emitLine(`      return;`);
      }

      // Restore previous context after final state
      context.inStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
    } else {
      // Restore previous context for non-await, non-final segments
      context.inStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
    }

    emitter.emitLine(`    }`);
  }

  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);
}
