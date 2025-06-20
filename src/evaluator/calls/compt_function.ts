import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { cloneExpr, Expr } from "../../expr";
import { CalledComptFunctionCache, FunctionValue } from "../../function-value";
import {
  FunctionType,
  isEnumType,
  isModuleType,
  isSomeType,
  isStructType,
  isUnionType,
} from "../../type-checker";
import {
  areValuesEqual,
  createUnknownValue,
  isTypeValue,
  Value,
  valueToString,
} from "../../value";
import { ArgValues, EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "../exprs/begin";

/**
 * Calling function that returns compile-time known value.
 * The return value will be cached.
 */
export function evaluateComptFunctionCall({
  functionCallExpr,
  functionType,
  functionValue,
  argValues: argValues_,
  callerEnv,
  calleeEnv,
  context,
}: {
  functionCallExpr: Expr;
  functionType: FunctionType;
  functionValue: FunctionValue;
  argValues: ArgValues;
  callerEnv: Environment;
  calleeEnv: Environment;
  context: EvaluatorContext;
}): { value: Value; callerEnv: Environment } {
  const unfilteredArgValues: (Value | undefined)[] = [
    ...argValues_.forallArgs,
    ...argValues_.args,
    ...argValues_.implicitArgs,
  ];
  if (unfilteredArgValues.some((val) => !val)) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Failed to call the type function. Some arguments are not compile-time evaluated correctly.`,
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
          if (isSomeType(argValue.value) && !isSomeType(givenArgValue.value)) {
            return false;
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
    // Find the cache
    return {
      callerEnv: callerEnv,
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
    value: createUnknownValue(functionType.return.type),
    env: calleeEnv,
  };
  const caches = [...calledComptFunctions, tempCache];
  const tempCacheIndex = caches.length - 1;
  functionValue.calledComptFunctionCaches = caches;

  // NOTE: We should use the env from the function, not the current env.
  const evaluatedFunctionBody = evaluateBeginExpression({
    expr: cloneExpr(functionBodyExpr), // NOTE: Clone here is necessary
    env: calleeEnv,
    context: {
      ...context,
      isEvaluatingFunctionBody: {
        type: functionType,
        value: functionValue,
      },
    },
  });
  if (!evaluatedFunctionBody.$) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Function body is not evaluated correctly`,
    });
  }

  // Get the return type value
  const returnValue = evaluatedFunctionBody.$.value;
  if (!returnValue) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Function body is not evaluated correctly. Expected to return a compile-time known value.`,
    });
  }
  if (isTypeValue(returnValue)) {
    const returnType = returnValue.value;
    if (
      isStructType(returnType) ||
      isEnumType(returnType) ||
      isUnionType(returnType) ||
      isModuleType(returnType)
    ) {
      if (!returnType.typeName && functionValue.funcName) {
        returnType.typeName =
          functionValue.funcName +
          `(${argValues.map((v) => valueToString(v)).join(", ")})`;
      }

      if (!returnType.functionValue) {
        returnType.functionValue = functionValue;
      }
    }
  }

  // Update the cache
  caches[tempCacheIndex] = {
    funcId,
    argValues,
    value: returnValue,
    env: evaluatedFunctionBody.$.env,
  };

  return {
    value: returnValue,
    callerEnv: callerEnv,
  };
}
