/**
 * State Machine Transformation for Stackless Coroutines
 *
 * This module transforms functions with suspension points into state machines.
 *
 * TRANSFORMATION STRATEGY:
 *
 * Given a function like:
 * ```yo
 * main :: (fn() -> unit) {
 *   ch := chan(i32);
 *   async { ch <- 42; };
 *   value := <-(ch).unwrap();  // suspension point
 *   printf("value=%d\n", value);
 * }
 * ```
 *
 * Transform into:
 *
 * 1. Task data struct (holds all locals):
 * ```c
 * typedef struct {
 *   yo_chan_i32* ch;
 *   yo_option_i32 value;
 * } yo_user_main_task_data_t;
 * ```
 *
 * 2. Continuation function (state machine):
 * ```c
 * void yo_user_main_continuation(yo_task_t* task) {
 *   yo_user_main_task_data_t* data = (yo_user_main_task_data_t*)task->data;
 *
 *   switch (task->state_id) {
 *     case 0: // Initial state
 *       data->ch = yo_chan_create_i32(0);
 *       // spawn async closure
 *       __yo_task_spawn_closure_...(closure);
 *
 *       // Try to receive - this might suspend
 *       data->value = __yo_chan_recv_i32(data->ch);
 *       if (task->state == YO_TASK_SUSPENDED) {
 *         task->state_id = 1; // Set next resume state
 *         return; // Yield back to worker
 *       }
 *       // If not suspended, fall through
 *
 *     case 1: // Resume after receive
 *       // value is in data->value
 *       printf("value=%d\n", data->value.value);
 *       task->state = YO_TASK_COMPLETED;
 *       return;
 *   }
 * }
 * ```
 *
 * 3. Wrapper function (for direct calls from non-task code):
 * ```c
 * void yo_user_main(void) {
 *   // Allocate task data
 *   yo_user_main_task_data_t* data = __yo_malloc(sizeof(yo_user_main_task_data_t));
 *
 *   // Create task
 *   yo_task_t* task = __yo_malloc(sizeof(yo_task_t));
 *   task->continuation = yo_user_main_continuation;
 *   task->data = data;
 *   task->state_id = 0;
 *   task->state = YO_TASK_READY;
 *   // ... initialize other fields ...
 *
 *   // Spawn as task
 *   __yo_task_spawn_unit_function((void(*)(void))yo_user_main_continuation);
 * }
 * ```
 *
 * IMPLEMENTATION STEPS:
 * 1. Detect suspension points in function body
 * 2. Extract all local variables
 * 3. Generate task data struct
 * 4. Generate continuation with switch/case state machine
 * 5. Generate wrapper function for direct calls
 *
 * CHALLENGES:
 * - Need to identify all local variables (bindings)
 * - Need to split function body at suspension points
 * - Need to handle control flow (if/while/etc) across suspension points
 * - Need to handle nested blocks and scoping
 *
 * SIMPLIFICATION FOR MVP:
 * - Start with linear code (no complex control flow)
 * - Only handle channel receive/send suspension points
 * - Defer select statement support
 */

import { Variable } from "../env";
import { Expr } from "../expr";
import { FunctionType } from "../types/definitions";
import { typeToString } from "../types/utils";
import { FunctionGenerationContext } from "./functions/context";
import { extractSuspensionPoints } from "./stackless-transform";

/**
 * Extract local variables that need to be stored in task data struct.
 *
 * Rules:
 * 1. Include runtime variables (not compile-time only)
 * 2. Include owning variables (isOwningTheARCValue = true)
 * 3. Exclude variables that are only borrowing from others (they're just aliases)
 * 4. Get variables from the function body's environment after evaluation
 */
export function extractLocalVariables(functionBody: Expr): Variable[] {
  // Get the environment from the evaluated expression
  const env = functionBody.$?.env;
  if (!env) {
    // No environment available - function body not evaluated yet
    return [];
  }

  const localVariables: Variable[] = [];
  const seenVariableIds = new Set<string>();

  // Iterate through all frames in the environment
  // Skip frame 0 (global/module level), focus on function-local frames
  for (let frameIndex = 1; frameIndex < env.frames.length; frameIndex++) {
    const frame = env.frames[frameIndex]!;

    for (const variable of frame.variables) {
      // Skip if already seen (avoid duplicates from shadowing)
      if (seenVariableIds.has(variable.id)) {
        continue;
      }

      // Skip compile-time only variables (they don't exist at runtime)
      if (variable.isCompileTimeOnly) {
        continue;
      }

      // Skip implicit variables (compiler-generated temporaries that are handled elsewhere)
      if (variable.isImplicit) {
        continue;
      }

      // Skip variables that are only borrowing (they're aliases to other variables)
      // We only need to store the owning variable
      if (
        variable.isBorrowingTheARCValueOfVariable &&
        !variable.isOwningTheARCValue
      ) {
        continue;
      }

      // This is a local variable that needs to be stored
      localVariables.push(variable);
      seenVariableIds.add(variable.id);
    }
  }

  return localVariables;
}

/**
 * Generate a state machine version of a function with suspension points
 */
export function generateStateMachineFunction(
  functionBody: Expr,
  functionType: FunctionType,
  cFunctionName: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Extract suspension points
  const suspensionPoints = extractSuspensionPoints(functionBody);

  if (suspensionPoints.length === 0) {
    // No suspension points - shouldn't happen if we checked needsStateMachineTransformation
    throw new Error(
      `generateStateMachineFunction called on function without suspension points: ${cFunctionName}`
    );
  }

  // Extract local variables that need to be stored in task data
  const localVariables = extractLocalVariables(functionBody);

  emitter.emitLine(`// State machine for ${cFunctionName}`);
  emitter.emitLine(`// Suspension points: ${suspensionPoints.length}`);
  emitter.emitLine(`// Local variables to store: ${localVariables.length}`);

  for (const variable of localVariables) {
    const typeStr = typeToString(variable.type);
    emitter.emitLine(`//   ${variable.name}: ${typeStr}`);
  }

  // For now, just generate a placeholder
  emitter.emitLine(`  // PLACEHOLDER: State machine not yet implemented`);
  emitter.emitLine(`  (void)0; // Avoid empty function warning`);
}
