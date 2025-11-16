/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import { Expr, exprIsFunctionCallOf } from "../../expr";
import {
  FutureType,
  isStructType,
  isUnitType,
  StructType,
  typeContainsGcType,
} from "../../types";
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
 * Generates shadow frame teardown code if needed.
 */
function generateAsyncShadowFrameTeardown(
  indent: string,
  needsShadowFrame: boolean,
  emitter: any
): void {
  if (needsShadowFrame) {
    emitter.emitLine(`${indent}// Shadow frame teardown`);
    emitter.emitLine(`${indent}yo_shadow_stack_top = __yo_shadow_frame.prev;`);
  }
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

  const childType = futureType.childType;
  const isUnitResult = isUnitType(childType);

  // Split the body into state segments
  const segments = splitIntoStateSegments(bodyExpr, analysis.awaitPoints);

  // Calculate which state machine fields need to be in the shadow frame
  // Fields that contain GC pointers (either direct pointers or value types containing pointers)
  const gcRootFields: { fieldName: string; variable: CapturedVariable }[] = [];

  // Check captured variables for GC pointers
  for (const v of analysis.capturedVariables) {
    if (typeContainsGcType(v.type)) {
      const fieldName =
        v.kind === "outer"
          ? `__capture.${sanitizeForCIdentifier(v.name)}`
          : sanitizeForCIdentifier(`var_${v.id}`);
      gcRootFields.push({ fieldName, variable: v });
    }
  }

  // Also check outer captured variables from capture struct
  if (captureType) {
    for (const field of captureType.fields) {
      if (typeContainsGcType(field.type)) {
        // Check if not already processed
        const fieldName = `__capture.${sanitizeForCIdentifier(field.label)}`;
        const alreadyProcessed = analysis.capturedVariables.some(
          (v) => v.kind === "outer" && v.name === field.label
        );
        if (!alreadyProcessed) {
          gcRootFields.push({
            fieldName,
            variable: {
              id: field.label,
              name: field.label,
              type: field.type,
              kind: "outer",
            },
          });
        }
      }
    }
  }

  // Always include sm->result (the Future itself)
  gcRootFields.push({
    fieldName: "result",
    variable: {
      id: "result",
      name: "result",
      type: futureType,
      kind: "local",
    },
  });

  const totalGcRoots = gcRootFields.length;
  const needsShadowFrame = totalGcRoots > 0;

  emitter.emitLine(`// Resume function for async block ${asyncBlockId}`);
  emitter.emitLine(`void ${resumeFunctionName}(${structName}* sm) {`);

  // Set up shadow frame if needed
  if (needsShadowFrame) {
    emitter.emitLine(`  // Shadow frame setup for state machine GC roots`);
    emitter.emitLine(`  YoShadowFrame __yo_shadow_frame;`);
    emitter.emitLine(`  void* __yo_roots[${totalGcRoots}];`);
    emitter.emitLine(`  YoTypeDescriptor* __yo_root_types[${totalGcRoots}];`);

    // Initialize roots array with pointers to state machine fields
    // and type descriptors for value types
    for (let i = 0; i < gcRootFields.length; i++) {
      const { fieldName, variable } = gcRootFields[i]!;
      const varType = variable.type;

      emitter.emitLine(`  __yo_roots[${i}] = &sm->${fieldName};`);

      // Check if this is a value type that needs traverse function
      if (
        isStructType(varType) &&
        !varType.isReferenceSemantics &&
        typeContainsGcType(varType)
      ) {
        // Value type containing GC pointers - need type descriptor for traverse function
        const typeEntry = context.types[varType.id];
        if (typeEntry) {
          emitter.emitLine(
            `  __yo_root_types[${i}] = &${typeEntry.cName}_type_descriptor;`
          );
        } else {
          emitter.emitLine(
            `  __yo_root_types[${i}] = NULL; // Type descriptor not found`
          );
        }
      } else {
        // Direct GC pointer or reference type - no type descriptor needed
        emitter.emitLine(`  __yo_root_types[${i}] = NULL;`);
      }
    }

    emitter.emitLine(`  __yo_shadow_frame.prev = yo_shadow_stack_top;`);
    emitter.emitLine(`  __yo_shadow_frame.roots = __yo_roots;`);
    emitter.emitLine(`  __yo_shadow_frame.root_types = __yo_root_types;`);
    emitter.emitLine(`  __yo_shadow_frame.num_roots = ${totalGcRoots};`);
    emitter.emitLine(
      `  __yo_shadow_frame.function_name = "${resumeFunctionName}";`
    );
    emitter.emitLine(`  yo_shadow_stack_top = &__yo_shadow_frame;`);
    emitter.emitLine(``);
  }

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
      for (const field of captureType.fields) {
        combinedVariables.set(field.label, {
          id: field.label, // Use label as ID
          name: field.label,
          type: field.type,
          kind: "outer",
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
      generateAsyncShadowFrameTeardown("        ", needsShadowFrame, emitter);
      emitter.emitLine(`        return;`);
      emitter.emitLine(`      }`);
    } else if (isLastSegment) {
      // Last segment - complete the Future
      const hasReturnStatement = segment.expressions.some((expr: Expr) =>
        exprIsFunctionCallOf(expr, "return")
      );

      if (!hasReturnStatement) {
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
        generateAsyncShadowFrameTeardown("      ", needsShadowFrame, emitter);
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
