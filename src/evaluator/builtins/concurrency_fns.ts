import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import {
  convertComptTypeToRuntimeType,
  createFutureType,
  isFutureType,
  Type,
} from "../../types";
import { VUnit } from "../../unit-value";
import { CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import {
  createCaptureTypeAndValue,
  enrichCapturedVariables,
} from "../utils/closure";

/**
 * Evaluates the async builtin function (stackless coroutine spawning).
 *
 * async { expr } creates a Future(T) that represents a lazy async computation.
 * The computation does NOT start until the Future is awaited.
 *
 * Unlike evaluateGo, we don't wrap in a closure here - instead we:
 * 1. Evaluate the body to infer return type T
 * 2. Collect captured variables from outer scope
 * 3. Store metadata for codegen to create state machine
 *
 * Codegen will create:
 * - State machine struct with captured variables
 * - Future(T) object
 * - Resume function for state transitions
 *
 * Examples:
 * - async { printf("hello"); }  => Future(unit)
 * - async { compute(42) }       => Future(i32)
 *
 * @param params - The evaluation parameters
 * @returns The expression with Future(T) type, containing captured variables metadata
 */
export function evaluateAsync({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `async expects exactly 1 argument, got ${expr.args.length}.`,
    });
  }

  if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `async block must be evaluated within a function or another async block.`,
    });
  }

  const bodyExpr = expr.args[0]!;

  // Determine the expected return type for the body
  // If context expects Future(T), we should expect T inside the async block
  let unwrappedFutureExpectedType: Type | undefined = undefined;
  if (context.expectedType && isFutureType(context.expectedType.type)) {
    unwrappedFutureExpectedType = context.expectedType.type.childType;
  }

  // Create a map to track captured variables (similar to closures)
  const capturedVariablesMap = new Map<string, CapturedVariableInfo>();

  // Evaluate the body in async context to:
  // 1. Allow `await` expressions
  // 2. Infer the return type T
  // 3. Collect captured variables (via context.capturedVariables)
  const evaluatedBody = evaluateExpression({
    expr: bodyExpr,
    env,
    context: {
      ...context,
      isEvaluatingFunctionBodyOrAsyncBlock: {
        kind: "async-block",
        evaluationEnv: env,
      },
      isEvaluatingFunctionType: undefined, // Clear function type context for async block
      isEvaluatingLoopBody: undefined, // Clear loop body context for async block
      capturedVariables: capturedVariablesMap, // Set the async block's own captured variables map
      expectedType: unwrappedFutureExpectedType
        ? { type: unwrappedFutureExpectedType, env }
        : undefined,
    },
  });

  if (!evaluatedBody.$) {
    throw formatErrorMessage({
      token: bodyExpr.token,
      errorMessage: `Failed to evaluate async block body.`,
    });
  }

  env = evaluatedBody.$.env;

  // Infer the return type from the evaluated expression
  const returnType = convertComptTypeToRuntimeType({
    type: evaluatedBody.$.type,
    expectedType: undefined,
    expr: evaluatedBody,
    env,
    context: { ...context },
  });

  // Create Future(returnType)
  const futureType = createFutureType(returnType, env);

  // Enrich captured variables with values and types (convert to FunctionCapturedVariableInfo)
  const capturedVariables =
    capturedVariablesMap.size > 0
      ? enrichCapturedVariables({
          capturedVariables: capturedVariablesMap,
          env,
        })
      : undefined;

  // Create capture struct type and value (same approach as closures)
  const { captureType, captureValue: _captureValue } =
    createCaptureTypeAndValue({
      expectedCaptureType: undefined, // Let it infer from captured variables
      capturedVariablesWithValues: capturedVariables,
      env,
      closureToken: expr.token,
      context: { ...context },
    });

  // Store the captured variables for codegen (bodyExpr already has evaluated data)
  expr.$ = {
    env,
    type: futureType,
    value: undefined, // Runtime value (the Future handle)
    pathCollection: [],
    // Store metadata for async codegen
    captureType: captureType, // Store the capture struct type for codegen (used for both closures and async blocks)
  };

  attachTempVariableToExpr(expr);
  return expr;
}

/**
 * Evaluates the __yo_concurrency_set_maximum_threads builtin function.
 *
 * __yo_concurrency_set_maximum_threads takes a usize argument specifying the maximum
 * number of threads that should be used to run tasks.
 *
 * Examples:
 * - __yo_concurrency_set_maximum_threads(1) -> unit
 * - __yo_concurrency_set_maximum_threads(4) -> unit
 *
 * @param params - The evaluation parameters
 * @returns The expression with unit type
 */
export function evaluateTaskSetMaximumThreads({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_concurrency_set_maximum_threads,
    1
  );

  const argExpr = expr.args[0]!;

  // Evaluate the argument expression
  const evaluatedExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }

  env = evaluatedExpr.$.env;

  // Return unit type
  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  return expr;
}
