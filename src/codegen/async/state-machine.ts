/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import { exprIsFunctionCallOf } from "../../expr";
import { FunctionValue } from "../../function-value";
import { FutureType, isFutureType, isUnitType } from "../../types";
import { FunctionGenerationContext } from "../functions/context";
import { getTypeString, sanitizeForCIdentifier } from "../utils";
import { analyzeAwaitPoints, AwaitAnalysisResult } from "./await-analysis";
import {
  generateStateSegmentCode,
  splitIntoStateSegments,
} from "./state-code-gen";

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

  // Add Future pointers for async calls
  emitter.emitDeclarationLine(`  // Future pointers for async calls`);
  for (const awaitPoint of analysis.awaitPoints) {
    // Get the await argument (the Future being awaited)
    if (awaitPoint.expr.tag === "FuncCall" && awaitPoint.expr.args.length > 0) {
      const awaitArg = awaitPoint.expr.args[0];
      const awaitFutureType = awaitArg?.$?.type;
      if (awaitFutureType && isFutureType(awaitFutureType)) {
        const awaitFutureTypeCName =
          context.types[(awaitFutureType as FutureType).id]?.cName;
        if (awaitFutureTypeCName) {
          emitter.emitDeclarationLine(
            `  ${awaitFutureTypeCName}* await_future_${awaitPoint.index};`
          );
        }
      }
    }
  }

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
 * Generates the resume function implementation for a state machine.
 * The resume function contains a switch statement that dispatches on the state field.
 * Each state executes code until the next await point or return.
 */
export function generateResumeFunctionImplementation(
  functionValue: FunctionValue,
  functionCName: string,
  info: StateMachineInfo,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const functionType = functionValue.type;
  const futureType = functionType.return.type as FutureType;
  const elementType = futureType.elementType;
  const isUnitResult = isUnitType(elementType);
  // const futureTypeCName = context.types[futureType.id]?.cName;

  // Split the function body into state segments
  const segments = splitIntoStateSegments(
    functionValue.body,
    info.analysis.awaitPoints
  );

  // Set current function context so return statements know we're in an async function
  const previousFunctionName = context.currentFunctionName;
  const previousFunctionType = context.currentFunctionType;
  context.currentFunctionName = functionCName;
  context.currentFunctionType = functionType;

  emitter.emitLine(`// Resume function for ${functionCName}`);
  emitter.emitLine(`void ${info.resumeFunctionName}(${info.structName}* sm) {`);
  emitter.emitLine(
    `  ASYNC_DEBUG("${functionCName}_resume: state=%d\\n", sm->state);`
  );
  emitter.emitLine(`  switch (sm->state) {`);

  // Generate code for each state segment
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!;
    const stateNumber = segment.stateNumber;
    const isLastSegment = segmentIndex === segments.length - 1;

    // State case label
    if (stateNumber > 0) {
      emitter.emitLine(`
    state_${stateNumber}:`);
    }

    emitter.emitLine(`    case ${stateNumber}: { // State ${stateNumber}`);
    emitter.emitLine(
      `      ASYNC_DEBUG("${functionCName}: Entering state ${stateNumber}\\n");`
    );

    // If this is not the first state, extract the result from the previous await
    if (stateNumber > 0 && info.analysis.awaitPoints[stateNumber - 1]) {
      const prevAwait = info.analysis.awaitPoints[stateNumber - 1]!;
      if (!isUnitType(prevAwait.resultType)) {
        emitter.emitLine(
          `      // Extract result from await ${stateNumber - 1}`
        );
        emitter.emitLine(
          `      // Ensure we see all writes that happened before state was set to COMPLETED`
        );
        emitter.emitLine(
          `      yo_future_state_t state_before_read = atomic_load_explicit(&sm->await_future_${stateNumber - 1}->state, memory_order_acquire);`
        );
        emitter.emitLine(
          `      ASYNC_DEBUG("${functionCName}: Reading result from await ${stateNumber - 1}, state=%d\\n", state_before_read);`
        );
        emitter.emitLine(
          `      sm->await_result_${stateNumber - 1} = sm->await_future_${stateNumber - 1}->result;`
        );
        emitter.emitLine(
          `      ASYNC_DEBUG("${functionCName}: Read result value = %d\\n", (int)sm->await_result_${stateNumber - 1});`
        );

        // If this await has a target variable, assign the result to it
        if (prevAwait.targetVariableId) {
          const fieldName = getStateMachineFieldName(
            prevAwait.targetVariableId
          );
          emitter.emitLine(
            `      sm->${fieldName} = sm->await_result_${stateNumber - 1};  // Assign to variable`
          );
        }

        emitter.emitLine(``);
      }
    }

    // Set up state machine context for expression generation
    const previousInStateMachine = context.inStateMachine;
    const previousStateMachineVariables = context.stateMachineVariables;

    context.inStateMachine = true;
    context.stateMachineVariables = new Map(
      info.analysis.capturedVariables.map((v) => [v.id, v])
    );

    // Generate the code for this segment
    generateStateSegmentCode(segment, "      ", context);

    // Restore previous context
    context.inStateMachine = previousInStateMachine;
    context.stateMachineVariables = previousStateMachineVariables;

    emitter.emitLine(``);

    if (segment.awaitPoint) {
      // This segment ends with an await - generate the await logic
      const awaitIndex = segment.awaitPoint.index;
      const nextState = stateNumber + 1;

      emitter.emitLine(`      // Transition to next state after await`);
      emitter.emitLine(`      sm->state = ${nextState};`);
      emitter.emitLine(``);
      emitter.emitLine(`      // Check if future is ready`);
      emitter.emitLine(
        `      yo_future_state_t future_state = atomic_load_explicit(&sm->await_future_${awaitIndex}->state, memory_order_acquire);`
      );
      emitter.emitLine(
        `      ASYNC_DEBUG("${functionCName}: Checking Future ${awaitIndex}, state=%d\\n", future_state);`
      );
      emitter.emitLine(`      if (future_state == YO_FUTURE_COMPLETED) {`);
      emitter.emitLine(
        `        ASYNC_DEBUG("${functionCName}: Future ${awaitIndex} already completed, continuing immediately\\n");`
      );
      emitter.emitLine(
        `        goto state_${nextState};  // Continue immediately`
      );
      emitter.emitLine(`      } else {`);
      emitter.emitLine(
        `        ASYNC_DEBUG("${functionCName}: Future ${awaitIndex} not ready, yielding\\n");`
      );
      emitter.emitLine(
        `        // Register continuation to resume when Future completes`
      );
      emitter.emitLine(
        `        yo_async_register_continuation((void*)sm->await_future_${awaitIndex}, (void (*)(void*))${info.resumeFunctionName}, (void*)sm);`
      );
      emitter.emitLine(`        return;`);
      emitter.emitLine(`      }`);
    } else if (isLastSegment) {
      // Last segment - complete the Future
      // But only if the segment doesn't already contain a return statement
      const hasReturnStatement = segment.expressions.some((expr) =>
        exprIsFunctionCallOf(expr, "return")
      );

      if (!hasReturnStatement) {
        emitter.emitLine(`      // Final state - complete the result Future`);
        emitter.emitLine(
          `      ASYNC_DEBUG("${functionCName}: Completing async function\\n");`
        );
        emitter.emitLine(
          `      atomic_store_explicit(&sm->result->state, YO_FUTURE_COMPLETED, memory_order_release);`
        );

        if (!isUnitResult) {
          emitter.emitLine(`      // TODO: Set result value`);
          emitter.emitLine(`      // sm->result->result = <final_result>;`);
        }

        emitter.emitLine(
          `      sm->state = ${stateNumber + 1};  // Terminal state`
        );
        emitter.emitLine(``);

        // State machine will be freed when Future is disposed
        emitter.emitLine(
          `      // State machine will be freed when Future is disposed (RC reaches 0)`
        );
        emitter.emitLine(`      return;`);
      }
    }

    emitter.emitLine(`    }`);
  }

  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);

  // Restore previous function context
  context.currentFunctionName = previousFunctionName;
  context.currentFunctionType = previousFunctionType;
}
