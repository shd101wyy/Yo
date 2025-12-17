import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { attachTempVariableToExpr, FuncCallExpr } from "../../expr";
import {
  convertComptTypeToRuntimeType,
  createFutureModuleType,
  createSomeType,
  createType0,
  extractFutureModuleFromType,
  isSomeType,
  SomeType,
  Type,
} from "../../types";
import { analyzeAwaitPoints } from "../async/await-analysis";
import { CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import {
  createCaptureTypeAndValue,
  enrichCapturedVariables,
  generateCapturedVariableDupExpressions,
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
  // If context expects Impl(Future(T)), extract T for the body
  let unwrappedFutureExpectedType: Type | undefined = undefined;
  let wrapperType: SomeType | undefined;

  if (context.expectedType) {
    const expectedType = context.expectedType.type;
    const futureModuleFromExpected = extractFutureModuleFromType(expectedType);
    if (futureModuleFromExpected) {
      unwrappedFutureExpectedType =
        futureModuleFromExpected.isFuture.outputType;
      if (isSomeType(expectedType)) {
        wrapperType = expectedType;
      }
    }
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
  });

  // Create FutureModuleType for the inferred return type
  const futureModuleType = createFutureModuleType(returnType, env);

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

  // Generate dup expressions for captured ARC variables
  const { capturedVariableDupExpressions, env: updatedEnv } =
    generateCapturedVariableDupExpressions({
      capturedVariablesWithValues: capturedVariables,
      env,
      context: { ...context },
    });
  env = updatedEnv;

  // Analyze the body for await points and captured variables
  // This is done in the evaluator to avoid redundant analysis during codegen
  const awaitAnalysis = analyzeAwaitPoints(evaluatedBody);

  // Determine the final type - always SomeType (Impl(Future(T))) for static dispatch
  // Use `dyn async { ... }` to get Dyn(Future(T)) for dynamic dispatch
  let finalType: SomeType;

  if (wrapperType) {
    // Use the expected SomeType wrapper with resolved concrete type
    finalType = {
      ...wrapperType,
      resolvedConcreteType: captureType,
    };
  } else {
    // Create a new SomeType (Impl(Future(T)))
    finalType = createSomeType(
      createType0(),
      "", // Name for the SomeType
      undefined,
      [futureModuleType], // requiredModules
      undefined // negativeModules
    );
    finalType.resolvedConcreteType = captureType;
  }

  // Store the captured variables for codegen (bodyExpr already has evaluated data)
  expr.$ = {
    env,
    type: finalType,
    value: undefined, // Runtime value (the Future handle)
    pathCollection: [],
    // Store metadata for async codegen
    captureType: captureType, // Store the capture struct type for codegen (used for both closures and async blocks)
    deferredDupExpressions:
      capturedVariableDupExpressions &&
      capturedVariableDupExpressions.length > 0
        ? capturedVariableDupExpressions
        : undefined,
    awaitAnalysis, // Store the await analysis result for codegen
  };

  attachTempVariableToExpr(expr, true);
  return expr;
}
