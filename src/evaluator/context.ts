import { Environment } from "../env";
import { YoError } from "../error";
import { Expr, PathCollection } from "../expr";
import { FunctionValue } from "../function-value";
import { Token } from "../token";
import { FunctionType, Type } from "../types";
import { ModuleValue, Value } from "../value";

export interface FunctionEvaluationContext {
  kind: "function-body";
  type: FunctionType;
  value?: FunctionValue;
  /**
   * The environment at the time the function body is being evaluated.
   * This is used to determine the frame level for closure variable capture.
   * The evaluationEnv should contain the frame of parameters/arguments
   */
  evaluationEnv: Environment;
}

export type LoadModuleFn = (modulePath: string) => {
  moduleValue: ModuleValue;
  moduleError: Error | undefined;
};

export type EvaluateExpressionFn = ({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}) => Expr;

export interface AsyncBlockEvaluationContext {
  kind: "async-block";
  evaluationEnv: Environment;
}

export interface EvaluatorContext {
  /**
   * Whether we are currently executing code (true) or just analyzing/type-checking it (false).
   * This flag prevents side effects like compt_print from executing during function definition.
   */
  isExecuting?: boolean;

  /**
   * Whether we are currently validating a function definition (type checking the function body).
   * This prevents certain side effects from occurring during function definition validation.
   */
  isValidatingFunctionDefinition?: boolean;

  /**
   *
   */
  expectedType?: {
    type: Type;
    env: Environment;
  };

  /**
   * Record the function that is currently being evaluated.
   * This is used for calling the `recur` function.
   *
   * Whether we are currently evaluating an async block.
   * This affects how we evaluate expressions within the async block.
   * For example, `await` expressions are only valid within async blocks.
   * Contains the environment at the time the async block started evaluation,
   * used to determine which variables are captured from outer scopes.
   *
   */
  isEvaluatingFunctionBodyOrAsyncBlock?:
    | FunctionEvaluationContext
    | AsyncBlockEvaluationContext;

  /**
   * For closures and async blocks, track variables captured from outer scopes.
   * Maps variable name to usage information (frame level, usage type, token).
   * This is populated during evaluation when isEvaluatingFunctionBodyOrAsyncBlock is set.
   */
  capturedVariables?: Map<string, CapturedVariableInfo>;

  /**
   * Whether we are currently evaluating a while/for loop.
   * This record the env that is used for the while/for loop body.
   */
  isEvaluatingLoopBody?: {
    kind: "while" | "for";
    env: Environment;
  };

  /**
   * The innermost struct, enum, or union that this function call is inside.
   * This can be useful for an anonymous struct that needs to refer to itself
   */
  SelfType?: Type;

  /**
   * The receiverType for implementing the module value.
   * Like:
   *
   * impl Point, Add(Point)(
   *   (+) : ((lhs, rhs) -> Point(lhs.x + rhs.x, lhs.y + rhs.y))
   * );
   *
   * here Point is the ReceiverType.
   */
  ReceiverType?: Type;

  /**
   * Whether we are currently evaluating a function type definition.
   * When true, implicit parameters dependencies are deferred and assumed to be satisfied.
   * This allows clean type declarations like `M3 :: (fn(using(M2Instance : M2())) -> Module)`
   * without requiring all transitive dependencies to be resolved at type definition time.
   */
  isEvaluatingFunctionType?: boolean;

  /**
   * The function to load modules.
   * @param modulePath
   * @returns
   */
  loadModule?: (modulePath: string) => {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  };

  /**
   * The path of the standard library modules.
   */
  stdPath: string;

  /**
   * Whether the function type being evaluated is marked as unsafe.
   */
  isUnsafeFunctionType?: boolean;
}

/**
 * Record the function call arguments and their values after function call.
 */
export interface ArgValues {
  forallArgs: { value: Value; parameterType: Type; argType: Type }[];
  args: { value: Value | undefined; parameterType: Type; argType: Type }[];
  implicitArgs: {
    value: Value | undefined;
    parameterType: Type;
    argType: Type;
  }[];
  variadicArgs: {
    value: Value | undefined;
    argType: Type;
  }[];
}

export interface FunctionCallResult {
  calleeEnv: Environment;
  callerEnv: Environment;
  pathCollection: PathCollection;
  returnType: Type;
  returnValue: Value | undefined;
  argValues: ArgValues;
  runtimeArgExprsInOrder: Expr[];
  /**
   * If the function has compile-time parameters and was specialized,
   * this contains the specialized function value with the evaluated body.
   * Otherwise, this is undefined.
   */
  specializedFunctionValue?: FunctionValue;
  /**
   * Drop expressions that need to be executed to clean up temporary variables
   * created during the function call (e.g., for function arguments that own ARC values).
   */
  deferredDropExpressions?: Expr[];
}

export interface TypeCallResult {
  values: (Value | undefined)[];
  pathCollection: PathCollection;
  runtimeArgExprsInOrder: Expr[];
  callerEnv: Environment;
}

export interface ModuleTypeCallResult {
  moduleValue: ModuleValue;
  callerEnv: Environment;
}

export interface ArrayCallResult {
  /**
   * The value by index from the array value.
   */
  value: Value | undefined;

  /**
   * The index used to access the array, if it's compile-time known.
   */
  index?: number;

  /**
   * Type of the return value.
   * It might be the childType of the array or slice:
   * - arr(3)
   *
   * Or it might be a slice type if the user calls a slice method:
   * - arr(3:5)
   */
  type: Type;

  /**
   * The caller environment.
   */
  callerEnv: Environment;
}

export interface MacroFunctionCallResult {
  calleeEnv: Environment;
  callerEnv: Environment;
  returnExpr: Expr;
}

export interface FunctionToCall {
  type: Type;
  value?: Value;
  result:
    | {
        /**
         * This is the result from calling:
         *
         *   tryToCallFunctionWithArguments
         */
        kind: "function";
        result: FunctionCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToCallTypeWithArguments
         */
        kind: "type";
        result: TypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementFunctionByFunctionType
         */
        kind: "function-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementArrayByArrayType
         */
        kind: "array-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementClosureByClosureType
         */
        kind: "closure-type";
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToImplementModuleWithArguments
         */
        kind: "module-type";
        result: ModuleTypeCallResult;
      }
    | {
        /**
         * This is the result from calling:
         *
         *   tryToCallArrayWithArguments
         */
        kind: "array";
        result: ArrayCallResult;
      }
    | {
        kind: "error";
        error: Error | YoError;
      };
}

export function getFunctionCallResult(
  functionToCall: FunctionToCall
): FunctionCallResult {
  if (functionToCall.result.kind !== "function") {
    throw new Error("Expected function call result");
  }
  return functionToCall.result.result;
}

export function getTypeCallResult(
  functionToCall: FunctionToCall
): TypeCallResult {
  if (functionToCall.result.kind !== "type") {
    throw new Error("Expected type call result");
  }
  return functionToCall.result.result;
}

export function getModuleTypeCallResult(
  functionToCall: FunctionToCall
): ModuleTypeCallResult {
  if (functionToCall.result.kind !== "module-type") {
    throw new Error("Expected module type call result");
  }
  return functionToCall.result.result;
}

export function getArrayCallResult(
  functionToCall: FunctionToCall
): ArrayCallResult {
  if (functionToCall.result.kind !== "array") {
    throw new Error("Expected array call result");
  }
  return functionToCall.result.result;
}

export type EvaluateExpression = ({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}) => Expr;

/**
 * Track usage of variables in closure contexts.
 * This enforces the borrowing rules for different closure types.
 */
export function trackVariableUsage(
  variableName: string,
  frameLevel: number,
  usageType: "read" | "write" | "own",
  token: Token,
  context: EvaluatorContext
): void {
  // Only track for closures or async blocks
  if (!context.isEvaluatingFunctionBodyOrAsyncBlock) {
    return;
  }

  // Determine the evaluation environment
  // Note: Check async block first since we can be inside both a function and an async block
  let evaluationEnv: Environment | undefined;
  if (context.isEvaluatingFunctionBodyOrAsyncBlock) {
    evaluationEnv = context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv;
  }

  // Only track variables from outer scopes (not local variables)
  if (!evaluationEnv || frameLevel >= evaluationEnv.frames.length) {
    return;
  }

  // Get the variable from the specified frame level
  const variable = evaluationEnv.frames[frameLevel]?.variables.find(
    (v) => v.name === variableName
  );
  if (!variable) {
    return;
  }

  if (variable.isCompileTimeOnly) {
    // Don't track compile-time only variables
    return;
  }

  // Track the variable usage
  if (!context.capturedVariables) {
    context.capturedVariables = new Map();
  }

  const existing = context.capturedVariables.get(variableName);

  // Update with the highest privilege usage type (own > write > read)
  const newUsageType =
    existing &&
    (existing.usageType === "own" ||
      (existing.usageType === "write" && usageType === "read"))
      ? existing.usageType
      : usageType;

  context.capturedVariables.set(variableName, {
    frameLevel,
    usageType: newUsageType,
    token,
  });
}

export interface CapturedVariableInfo {
  frameLevel: number;
  usageType: "read" | "write" | "own"; // How the variable is used
  token: Token; // Token where the usage occurs
}
