import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { cloneExpr, Expr } from "../../expr";
import { CalledComptFunctionCache, FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import {
  FunctionType,
  isEnumType,
  isModuleType,
  isSomeType,
  isStructType,
  isUnionType,
} from "../../types";
import {
  areValuesEqual,
  createUnknownValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import { ArgValues, CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";

/**
 * Calling function that returns compile-time known value.
 * The return value will be cached.
 */
export function evaluateComptFunctionCall({
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
}): { value: Value; callerEnv: Environment; calleeEnv: Environment } {
  const unfilteredArgValues: (Value | undefined)[] = [
    ...argValues_.forallArgs.map((v) => v.value),
    ...argValues_.args.map((v) => v.value),
    ...argValues_.implicitArgs.map((v) => v.value),
  ];
  if (unfilteredArgValues.some((val) => !val)) {
    throw formatErrorMessage({
      token: functionCalleeExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to call the function for compile-time. Some arguments are not compile-time evaluated correctly.`,
    });
  }
  const argValues: Value[] = unfilteredArgValues as Value[];

  // Check if it's in the cache
  const funcId = functionValue.funcId;
  const calledComptFunctions = functionValue.calledComptFunctionCaches;

  // Check if the function is already called.
  const calledComptFunction = calledComptFunctions.find((cache) => {
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
        if (isTypeValue(argValue) && isTypeValue(givenArgValue)) {
          if (isSomeType(argValue.value)) {
            if (!isSomeType(givenArgValue.value)) {
              return false;
            }
          }
        }

        return areValuesEqual(
          { value: argValue, env: cache.env },
          { value: givenArgValue, env: callerEnv }
        );
      })
    ); // Check if the values are equal
  });
  if (calledComptFunction) {
    return {
      callerEnv,
      calleeEnv,
      value: calledComptFunction.value,
    };
  }

  // Evaluate functionValue.body with the function env
  const functionBodyExpr = functionValue.body;

  // Create a temporary environment for the function call
  // This is to prevent the infinite loop of calling the same function
  const tempCache: CalledComptFunctionCache = {
    funcId,
    argValues,
    value: createUnknownValue(
      functionType.return.type,
      functionType.return.label
    ),
    env: calleeEnv,
    body: cloneExpr(functionBodyExpr), // NOTE: Clone here is necessary
  };
  // Add the temp cache directly to the function's cache array
  functionValue.calledComptFunctionCaches.push(tempCache);
  const tempCacheIndex = functionValue.calledComptFunctionCaches.length - 1;

  // NOTE: We should use the env from the function, not the current env.
  const evaluatedFunctionBody = evaluateBeginExpression({
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
      capturedVariables: functionType.isClosure
        ? new Map<string, CapturedVariableInfo>()
        : undefined,
      // Only set isExecuting=true if we're not in validation mode
      isExecuting: context.isValidatingFunctionDefinition ? false : true,
    },
    variablesToAdd: [],
  });
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
    const returnType = returnValue.value;
    if (!returnType.typeName && functionValue.funcName) {
      returnType.typeName =
        functionValue.funcName +
        `(${argValues.map((v) => valueToString(v)).join(", ")})`;
    }
    if (
      isStructType(returnType) ||
      isEnumType(returnType) ||
      isUnionType(returnType) ||
      isModuleType(returnType)
    ) {
      if (!returnType.functionValue) {
        returnType.functionValue = functionValue;
      }
    }
  }

  // Update the temp cache with the actual result
  functionValue.calledComptFunctionCaches[tempCacheIndex] = {
    funcId,
    argValues,
    value: returnValue,
    env: evaluatedFunctionBody.$.env,
    body: evaluatedFunctionBody,
  };

  return {
    value: returnValue,
    callerEnv,
    calleeEnv,
  };
}
