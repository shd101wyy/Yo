import { Borrowing } from "../borrow";
import { Environment } from "../env";
import { formatErrorMessages, MoParserError } from "../error";
import { Expr, PathCollection } from "../expr";
import { FunctionValue } from "../function-value";
import { Token } from "../token";
import { FunctionType, ModuleType, Type } from "../types";
import { ModuleValue, Value } from "../value";

export interface FunctionEvaluationContext {
  type: FunctionType;
  value?: FunctionValue;
  /**
   * For closures, track variables captured from outer scopes.
   * Maps variable name to usage information.
   */
  capturedVariables?: Map<string, CapturedVariableInfo>;
  /**
   * The environment at the time the function body is being evaluated.
   * This is used to determine the frame level for closure variable capture.
   * The evaluationEnv should contain the frame of parameters/arguments
   */
  evaluationEnv: Environment;
  /**
   * Track `do` expressions encountered during function body evaluation.
   * This indicates the function needs CPS transformation.
   */
  usedDo?: Expr[];
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
   */
  isEvaluatingFunctionBody?: FunctionEvaluationContext;

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
   * The innermost module that this function call is inside.
   */
  ModuleType?: ModuleType;

  /**
   * The borrowings.
   */
  borrowings: Borrowing[];

  /**
   * Whether we are currently evaluating a closure call type.
   * This is used to restrict FnOnce/FnMut/Fn usage to only within Closure types.
   */
  isEvaluatingClosureCallType?: boolean;

  evaluateExpression: EvaluateExpression;

  loadModule: (modulePath: string) => {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  };
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
   * The value accessing the array element.
   */
  value: Value | undefined;

  /**
   * Type of the return value.
   * It might be the elementType of the array or slice:
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
        error: Error | MoParserError;
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
  if (!context.isEvaluatingFunctionBody) {
    return;
  }

  const functionType = context.isEvaluatingFunctionBody.type;
  const evaluationEnv = context.isEvaluatingFunctionBody.evaluationEnv;

  // Only track variables from outer scopes (not local variables)
  if (!evaluationEnv || frameLevel >= evaluationEnv.frames.length) {
    return;
  }

  // For Fn closures, only allow read access to outer scope variables
  if (functionType.closureKind === "Fn" && usageType !== "read") {
    throw formatErrorMessages([
      {
        token,
        errorMessage: `Cannot ${usageType === "write" ? "modify" : "consume"} outer scope variable "${variableName}" in Fn closure. Fn closures can only read (borrow immutably) from outer scope.`,
      },
    ]);
  }

  // For FnMut closures, allow read and write but not ownership transfer
  if (functionType.closureKind === "FnMut" && usageType === "own") {
    throw formatErrorMessages([
      {
        token,
        errorMessage: `Cannot consume outer scope variable "${variableName}" in FnMut closure. FnMut closures can only borrow (read/write) from outer scope.`,
      },
    ]);
  }

  // Track the variable usage
  if (!context.isEvaluatingFunctionBody.capturedVariables) {
    context.isEvaluatingFunctionBody.capturedVariables = new Map();
  }

  const existing =
    context.isEvaluatingFunctionBody.capturedVariables.get(variableName);

  // Update with the highest privilege usage type (own > write > read)
  const newUsageType =
    existing &&
    (existing.usageType === "own" ||
      (existing.usageType === "write" && usageType === "read"))
      ? existing.usageType
      : usageType;

  context.isEvaluatingFunctionBody.capturedVariables.set(variableName, {
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
