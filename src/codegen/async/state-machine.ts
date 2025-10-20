/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import { Expr, exprIsFunctionCallOf } from "../../expr";
import { FutureType, isUnitType, StructType } from "../../types";
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

  // This should never happen - if we have an await, we must have captured the Future variable
  throw new Error(
    `getFutureFieldName: Could not find captured variable for await point ${awaitPoint.index} ` +
      `(futureVariableId=${awaitPoint.futureVariableId}). ` +
      `Captured variables: ${analysis.capturedVariables.map((v) => `${v.id}/${v.name}`).join(", ")}`
  );
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
  futureType: FutureType,
  captureType: StructType | undefined,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  const elementType = futureType.elementType;
  const isUnitResult = isUnitType(elementType);

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
    if (stateNumber > 0) {
      emitter.emitLine(`
    state_${stateNumber}:`);
    }

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
      for (const elem of captureType.elements) {
        combinedVariables.set(elem.label, {
          id: elem.label, // Use label as ID
          name: elem.label,
          type: elem.type,
          kind: "outer",
          isBorrowingTheARCValueOfVariable: undefined,
        });
      }
    }

    context.stateMachineVariables = combinedVariables;

    // Generate the code for this segment
    generateStateSegmentCode(segment, "      ", context);

    emitter.emitLine(``);

    if (segment.awaitPoint) {
      // Restore previous context before await logic
      context.inStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;

      // This segment ends with an await - generate the await logic
      const nextState = stateNumber + 1;
      const futureFieldName = getFutureFieldName(segment.awaitPoint, analysis);

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

        if (!isUnitResult) {
          emitter.emitLine(`      // TODO: Set result value`);
        }

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
