/**
 * CTFE (Compile-Time Function Evaluation) Analysis
 *
 * This module provides functionality to analyze whether a function can be
 * evaluated at compile time, similar to Zig's comptime.
 *
 * The approach is to create a compile-time version of the function
 * (where all parameters and return type are marked as isCompileTimeOnly)
 * and try to evaluate the function body with that type. If successful,
 * the compile-time function is stored in `functionValueAtCompileTime` and
 * will be used as a candidate during function call resolution.
 */

import {
  addVariableToEnv,
  Environment,
  popEnvFrame,
  pushEnvFrame,
} from "../../env";
import { cloneExpr } from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import { FunctionType, typeProhibitsComptModifier } from "../../types";
import { createUnknownValue } from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";

/**
 * Create a compile-time version of a function type.
 * All parameters and the return type are marked as isCompileTimeOnly.
 */
export function createComptFunctionType(
  functionType: FunctionType
): FunctionType {
  return {
    ...functionType,
    forallParameters: functionType.forallParameters.map((param) => ({
      ...param,
      isCompileTimeOnly: true,
    })),
    parameters: functionType.parameters.map((param) => ({
      ...param,
      isCompileTimeOnly: true,
    })),
    return: {
      ...functionType.return,
      isCompileTimeOnly: true,
    },
  };
}

/**
 * Analyze whether a function can be evaluated at compile time.
 *
 * This works by:
 * 1. Creating a compile-time version of the function type
 * 2. Trying to evaluate the function body with all parameters as compile-time values
 * 3. If evaluation succeeds (produces a compile-time value), a compile-time FunctionValue is created
 *
 * If successful, `functionValue.functionValueAtCompileTime` is set to the compile-time version.
 * This compile-time function will be added as a candidate during function call resolution.
 *
 * @param functionValue The function to analyze
 * @param env The environment in which the function was defined
 * @param context The evaluator context
 */
export function analyzeCtfeCapability(
  functionValue: FunctionValue,
  env: Environment,
  context: EvaluatorContext
): void {
  // Skip if already analyzed
  if (functionValue.functionValueAtCompileTime !== undefined) {
    return;
  }

  // Skip if the function is already a compile-time function
  if (functionValue.type.return.isCompileTimeOnly) {
    return;
  }

  // Skip external functions - they can't be evaluated at compile time
  if (functionValue.type.isExtern) {
    return;
  }

  // Skip functions with forall parameters - they need specialization first
  if (functionValue.type.forallParameters.length > 0) {
    return;
  }

  // Check if any parameter type prohibits compt modifier (runtime-only types like Ptr, Slice, Void)
  for (const param of functionValue.type.parameters) {
    if (typeProhibitsComptModifier(param.type)) {
      return;
    }
  }

  // Check if return type prohibits compt modifier
  if (typeProhibitsComptModifier(functionValue.type.return.type)) {
    return;
  }

  // Create the compile-time version of the function type
  const comptFunctionType = createComptFunctionType(functionValue.type);

  // Try to evaluate the function body in CTFE mode
  try {
    // Clone the body so we don't modify the original
    const clonedBody = cloneExpr(functionValue.body);

    // Create environment with compile-time parameters
    let ctfeEnv = pushEnvFrame(comptFunctionType.env);

    // Add all parameters as compile-time known UnknownValues
    for (const param of comptFunctionType.parameters) {
      const { env: nextEnv } = addVariableToEnv({
        env: ctfeEnv,
        variable: {
          name: param.label,
          type: param.type,
          isCompileTimeOnly: true,
          value: [createUnknownValue(param.type, param.label)],
          token: PlaceholderToken,
          initializedAtToken: PlaceholderToken,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      ctfeEnv = nextEnv;
    }

    // Create the compile-time FunctionValue BEFORE evaluating the body
    // This is necessary so that `recur` calls inside the body can reference
    // the compile-time version (which has compile-time return type)
    const comptFunctionValue: FunctionValue = {
      tag: ValueTag.Function,
      type: comptFunctionType,
      body: clonedBody, // Will be updated after evaluation
      frameLevel: functionValue.frameLevel,
      funcName: functionValue.funcName
        ? `${functionValue.funcName}_compt`
        : undefined,
      funcId: `${functionValue.funcId}_compt`,
      calledComptFunctionCaches: [],
      specializedFunctionCaches: [],
    };

    // Try to evaluate the body
    const evaluatedBody = evaluateBeginExpression({
      expr: clonedBody,
      env: ctfeEnv,
      context: {
        ...context,
        isExecuting: true, // Mark as executing for CTFE
        forceCompileTimeBindings: true, // Force `:=` to behave like `::` during CTFE
        isEvaluatingFunctionBodyOrAsyncBlock: {
          kind: "function-body",
          type: comptFunctionType,
          value: comptFunctionValue, // Use the compile-time function value for recur
          evaluationEnv: ctfeEnv,
        },
        expectedType: {
          type: comptFunctionType.return.type,
          env: ctfeEnv,
        },
      },
      variablesToAdd: [],
      isEvaluatingFunctionBodyBeginBlock: true,
    });

    // Check if the result is a compile-time value
    if (evaluatedBody.$?.value !== undefined) {
      // CTFE succeeded - update the body and store it
      comptFunctionValue.body = evaluatedBody;
      functionValue.functionValueAtCompileTime = comptFunctionValue;
    }

    // Clean up
    popEnvFrame(ctfeEnv, true);
  } catch (e) {
    // CTFE failed - the function cannot be evaluated at compile time
    // functionValueAtCompileTime remains undefined
  }
}
