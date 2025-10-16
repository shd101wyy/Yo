/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import { Expr, exprIsFunctionCallOf } from "../../expr";
import {
  FunctionCapturedVariableInfo,
  FunctionValue,
} from "../../function-value";
import { FutureType, isFutureType, isUnitType } from "../../types";
import { generateExpr } from "../expressions";
import { FunctionGenerationContext } from "../functions/context";
import { getTypeString, sanitizeForCIdentifier } from "../utils";
import {
  analyzeAwaitPoints,
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
  console.log(
    `[getFutureFieldName] awaitPoint.index=${awaitPoint.index}, futureVariableId=${awaitPoint.futureVariableId}`
  );
  console.log(
    `[getFutureFieldName] analysis.capturedVariables count=${analysis.capturedVariables.length}`
  );
  analysis.capturedVariables.forEach((v, idx) => {
    console.log(`  [${idx}] id=${v.id}, name=${v.name}, kind=${v.kind}`);
  });

  if (awaitPoint.futureVariableId) {
    // Find the captured variable
    const capturedVar = analysis.capturedVariables.find(
      (v) => v.id === awaitPoint.futureVariableId
    );
    console.log(`[getFutureFieldName] Found capturedVar: ${!!capturedVar}`);
    if (capturedVar) {
      // Use the captured variable's field name
      const fieldName =
        capturedVar.kind === "outer"
          ? capturedVar.name
          : `var_${capturedVar.id}`;
      console.log(`[getFutureFieldName] Returning field name: ${fieldName}`);
      return fieldName;
    }
  }
  // Fallback to old behavior (shouldn't happen)
  console.log(
    `[getFutureFieldName] FALLBACK! Returning await_future_${awaitPoint.index}`
  );
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
 * Generates the state machine struct type declaration for an async function.
 *
 * @param functionValue The async function value
 * @param functionCName The C name of the function
 * @param context Code generation context
 * @returns State machine information
 */
export function generateStateMachineStruct(
  functionValue: FunctionValue,
  functionCName: string,
  context: FunctionGenerationContext
): StateMachineInfo {
  const emitter = context.emitter;
  const functionType = functionValue.type;

  // Analyze the function body for await points
  const analysis = analyzeAwaitPoints(functionValue.body);

  // Note: Even if there are no awaits, we still generate a state machine
  // This ensures all async functions spawn to worker threads consistently

  // Generate struct name and resume function name
  const structName = `${functionCName}_state_t`;
  const resumeFunctionName = `${functionCName}_resume`;

  // Get the return type (should be Future(T))
  if (!isFutureType(functionType.return.type)) {
    throw new Error(
      `Async function ${functionCName} does not return Future type`
    );
  }

  const futureType = functionType.return.type as FutureType;
  const futureTypeCName = context.types[futureType.id]?.cName;
  if (!futureTypeCName) {
    throw new Error(`Future type not found in context for ${functionCName}`);
  }

  // Generate the state machine struct
  emitter.emitDeclarationLine(`// State machine for ${functionCName}`);
  emitter.emitDeclarationLine(`typedef struct {`);
  emitter.emitDeclarationLine(
    `  int state;  // Current state (0 = initial, ${analysis.awaitPoints.length + 1} = done)`
  );
  emitter.emitDeclarationLine(
    `  ${futureTypeCName}* result;  // The Future this async function returns`
  );
  emitter.emitDeclarationLine(``);

  // Add function parameters as fields
  emitter.emitDeclarationLine(`  // Function parameters`);
  for (const param of functionType.parameters) {
    const paramTypeCName = getTypeString(param.type, context);
    emitter.emitDeclarationLine(`  ${paramTypeCName} ${param.label};`);
  }
  emitter.emitDeclarationLine(``);

  // Add local variables as fields
  if (analysis.capturedVariables.length > 0) {
    emitter.emitDeclarationLine(`  // Local variables`);
    for (const variable of analysis.capturedVariables) {
      const varTypeCName = getTypeString(variable.type, context);
      const fieldName = getStateMachineFieldName(variable.id);
      emitter.emitDeclarationLine(
        `  ${varTypeCName} ${fieldName};  // ${variable.name}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // Add await result temporaries
  if (analysis.awaitPoints.length > 0) {
    emitter.emitDeclarationLine(`  // Await result temporaries`);
    for (const awaitPoint of analysis.awaitPoints) {
      if (!isUnitType(awaitPoint.resultType)) {
        const resultTypeCName = getTypeString(awaitPoint.resultType, context);
        emitter.emitDeclarationLine(
          `  ${resultTypeCName} await_result_${awaitPoint.index};`
        );
      }
    }
    emitter.emitDeclarationLine(``);
  }

  // Note: We don't need separate await_future_X fields because we use the captured Future variables directly
  emitter.emitDeclarationLine(`} ${structName};`);
  emitter.emitDeclarationLine(``);

  return {
    structName,
    resumeFunctionName,
    analysis,
  };
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
export function getStateMachineFieldName(variableId: string): string {
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
  capturedVariables: Map<string, FunctionCapturedVariableInfo> | undefined,
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
            prevAwait.targetVariableId
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

    // Add local variables (with their IDs for var_{id} naming)
    for (const v of analysis.capturedVariables) {
      combinedVariables.set(v.id, v);
    }

    // Add outer captured variables (they use their actual names, not var_{id})
    // We create synthetic entries with the variable name as the ID
    if (capturedVariables) {
      for (const [varName, varInfo] of capturedVariables.entries()) {
        combinedVariables.set(varName, {
          id: varName, // Use varName as ID so getStateMachineFieldName returns varName
          name: varName,
          type: varInfo.type,
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
