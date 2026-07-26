import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { cloneExpr, type Expr } from "../../expr";
import {
  type CalledComptimeFunctionCache,
  type FunctionValue,
} from "../../function-value";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import { type FunctionType } from "../../types/definitions";
import {
  isEnumType,
  isSourceNamespaceType,
  isSomeType,
  isStructType,
  isTraitType,
  isTypeHierarchyType,
  isUnionType,
} from "../../types/guards";
import { typeContainsSomeType } from "../../types/utils";
import { randomId } from "../../utils";
import {
  areValuesEqual,
  createUnknownValue,
  isTypeValue,
  type Value,
  valueToString,
} from "../../value";
import type { ArgValues, EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";

/**
 * Calling function that returns compile-time known value.
 * The return value will be cached.
 */
export function evaluateComptimeFunctionCall({
  functionCalleeExpr,
  functionType,
  functionValue,
  argValues: argValues_,
  callerEnv,
  calleeEnv,
  context,
}: {
  functionCalleeExpr: Expr | undefined;
  functionType: FunctionType;
  functionValue: FunctionValue;
  argValues: ArgValues;
  callerEnv: Environment;
  calleeEnv: Environment;
  context: EvaluatorContext;
}): {
  value: Value;
  callerEnv: Environment;
  calleeEnv: Environment;
  comptimeRef?: import("../../expr").ComptimeRef;
} {
  // During CTFE capability analysis, we don't actually execute the function.
  // We just verify that the call is valid and return an UnknownValue.
  // This prevents infinite recursion and allows nested CTFE functions to work.
  if (context.isAnalyzingCtfeCapability) {
    return {
      value: createUnknownValue(functionType.return.type, {
        variableName: "ctfe_analysis_result_" + randomId(callerEnv.modulePath),
        env: functionType.env,
        context,
      }),
      callerEnv,
      calleeEnv,
    };
  }

  const unfilteredArgValues: (Value | undefined)[] = [
    ...argValues_.forallArgs.map((v) => v.value),
    ...argValues_.args.map((v) => v.value),
    ...argValues_.variadicArgs.map((v) => v.value),
  ];
  if (unfilteredArgValues.some((val) => !val)) {
    throw formatErrorMessage({
      token: functionCalleeExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to call the function for compile-time. Some arguments are not compile-time evaluated correctly.`,
    });
  }
  const argValues: Value[] = unfilteredArgValues as Value[];

  // Only cache CTFE calls that return Type (TypeHierarchyType).
  // These are pure type-constructor functions like Box(T), Vec(T), etc.
  // Functions that return regular values (i32, unit, etc.) should not be cached
  // because they might have side effects (e.g., mutation through pointers).
  const returnType = functionType.return.type;
  const shouldCache = isTypeHierarchyType(returnType);

  // Check if it's in the cache (only for type-returning functions)
  const funcId = functionValue.funcId;
  const calledComptimeFunctions = functionValue.calledComptimeFunctionCaches;

  // Check if the function is already called (only if caching is enabled).
  const calledComptimeFunction = shouldCache
    ? calledComptimeFunctions.find((cache) => {
        return (
          cache.argValues.length === argValues.length &&
          cache.argValues.every((argValue, index) => {
            const givenArgValue = argValues[index];

            // If argValue is some type, and givenArgValue is not some type,
            // we return false.
            // For example:
            // - Point(T)
            // - Point(i32)
            // given T = i32 in env, areValuesEqual returns true.
            // We don't want to use the cache there.
            // For caching purposes, we need EXACT equality, not just compatibility.
            if (isTypeValue(argValue) && isTypeValue(givenArgValue)) {
              // CRITICAL: For SomeTypes, we must compare by id, not by name or structure.
              // Two different SomeTypes (e.g., V from Box's definition and T from impl's generic)
              // should NOT be considered equal even if they have the same structure.
              // This ensures that Box(V) and Box(T) create separate cache entries.
              if (
                isSomeType(argValue.value) &&
                isSomeType(givenArgValue.value)
              ) {
                // Must be the exact same SomeType instance
                return argValue.value.id === givenArgValue.value.id;
              }

              // If either side is a bare SomeType (even Impl(Fn/Future) ones
              // which typeContainsSomeType ignores for codegen purposes),
              // require exact id match. Two SomeTypes with different ids
              // represent different type parameters and must NOT share cache.
              if (
                isSomeType(argValue.value) ||
                isSomeType(givenArgValue.value)
              ) {
                if (
                  !isSomeType(argValue.value) ||
                  !isSomeType(givenArgValue.value)
                ) {
                  return false;
                }
                return argValue.value.id === givenArgValue.value.id;
              }

              // If either side contains SomeType anywhere inside, require exact type identity.
              // This prevents cache reuse across different type parameters that happen to be
              // structurally compatible (e.g., Option(*(T)) vs Option(*(U))).
              if (
                typeContainsSomeType(argValue.value) ||
                typeContainsSomeType(givenArgValue.value)
              ) {
                return argValue.value.id === givenArgValue.value.id;
              }

              if (isSomeType(argValue.value)) {
                if (!isSomeType(givenArgValue.value)) {
                  return false;
                }
              }

              // Direct type comparison with exact matching
              return areTypesCompatible(
                { type: argValue.value, env: cache.env },
                { type: givenArgValue.value, env: callerEnv },
                true // requireExactMatch for cache comparison
              );
            }

            return areValuesEqual(
              { value: argValue, env: cache.env },
              { value: givenArgValue, env: callerEnv }
            );
          })
        ); // Check if the values are equal
      })
    : undefined;
  if (calledComptimeFunction) {
    return {
      callerEnv,
      calleeEnv,
      value: calledComptimeFunction.value,
    };
  }

  // Evaluate functionValue.body with the function env
  const functionBodyExpr = functionValue.body;

  // Create a temporary environment for the function call
  // This is to prevent the infinite loop of calling the same function
  const tempCache: CalledComptimeFunctionCache = {
    funcId,
    argValues,
    value: createUnknownValue(functionType.return.type, {
      variableName: functionType.return.label,
      // Store recursive type reference so we can resolve it later
      recursiveTypeRef: { functionValue, argValues },
      env: calleeEnv,
      context,
    }),
    env: calleeEnv,
    body: cloneExpr(functionBodyExpr), // NOTE: Clone here is necessary
  };
  // Add the temp cache directly to the function's cache array
  functionValue.calledComptimeFunctionCaches.push(tempCache);
  const tempCacheIndex = functionValue.calledComptimeFunctionCaches.length - 1;

  let evaluatedFunctionBody;
  try {
    // NOTE: We should use the env from the function, not the current env.
    evaluatedFunctionBody = evaluateBeginExpression({
      expr: tempCache.body,
      env: calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionBodyOrAsyncBlock: {
          kind: "function-body",
          type: functionType,
          value: functionValue,

          evaluationEnv: calleeEnv,
        },
        isEvaluatingLoopBody: undefined, // Clear loop body context for function body
        capturedVariables: undefined,
        // Only set isExecuting=true if we're not in validation mode
        isExecuting: context.isValidatingFunctionDefinition ? false : true,
        functionReturnImplConcreteType: [], // Fresh array for each call
        // Propagate SelfType from function type if available
        SelfType: functionType.SelfType ?? context.SelfType,

        // Force compile-time bindings for CTFE function execution.
        // This allows `:=` bindings inside the function body to produce compile-time values.
        forceCompileTimeBindings: true,
      },
      variablesToAdd: [],
    });
  } catch (error) {
    // If an error is thrown during evaluation, remove the temp cache entry
    // to ensure the error is properly re-thrown on subsequent calls with
    // the same arguments
    functionValue.calledComptimeFunctionCaches.splice(tempCacheIndex, 1);
    throw error;
  }

  if (!evaluatedFunctionBody.$) {
    throw formatErrorMessage({
      token: functionValue.body.token,
      errorMessage: `Function body is not evaluated correctly`,
    });
  }

  // Get the return type value
  const returnValue = evaluatedFunctionBody.$.value;
  if (!returnValue) {
    throw formatErrorMessage({
      token: functionValue.body.token,
      errorMessage: `Function body is not evaluated correctly. Expected to return a compile-time known value.`,
    });
  }
  calleeEnv = evaluatedFunctionBody.$.env;

  if (isTypeValue(returnValue)) {
    const returnedType = returnValue.value;
    if (!returnedType.typeName && functionValue.funcName) {
      returnedType.typeName =
        functionValue.funcName +
        `(${argValues.map((v) => valueToString(v)).join(", ")})`;
    }
    if (
      isStructType(returnedType) ||
      isEnumType(returnedType) ||
      isUnionType(returnedType) ||
      isSourceNamespaceType(returnedType) ||
      isTraitType(returnedType)
    ) {
      if (!returnedType.functionValue) {
        returnedType.functionValue = functionValue;
      }
    }
  }

  // Update the temp cache with the actual result.
  // Only keep the cache for type-returning functions; remove for others.
  if (shouldCache) {
    functionValue.calledComptimeFunctionCaches[tempCacheIndex] = {
      funcId,
      argValues,
      value: returnValue,
      env: evaluatedFunctionBody.$.env,
      body: evaluatedFunctionBody,
    };
  } else {
    functionValue.calledComptimeFunctionCaches.splice(tempCacheIndex, 1);
  }

  return {
    value: returnValue,
    callerEnv,
    calleeEnv,
    comptimeRef: evaluatedFunctionBody.$.comptimeRef,
  };
}
