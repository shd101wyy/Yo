import { Borrowing } from "../borrow";
import { Environment } from "../env";
import { MoParserError } from "../error";
import { Expr, PathCollection } from "../expr";
import { FunctionValue } from "../function-value";
import { FunctionType, ModuleType, Type } from "../types";
import { ModuleValue, Value } from "../value";

export interface EvaluatorContext {
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
  isEvaluatingFunctionBody?: {
    type: FunctionType;
    value?: FunctionValue;
  };

  /**
   * Whether we are currently evaluating a while loop.
   * This record the env that is used for the while loop body.
   */
  isEvaluatingWhileLoopBody?: Environment;

  /**
   * Whether we are in a terminating branch (e.g., inside a return statement or break statement).
   * This is used to allow consumption of linear values defined outside while loops
   * when the consumption happens in a branch that will definitely exit.
   */
  isInTerminatingBranch?: boolean;

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
