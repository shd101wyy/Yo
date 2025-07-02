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
   * This is used for calling the `recur` function.
   */
  isEvaluatingFunctionBody?: {
    type: FunctionType;
    value?: FunctionValue;
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

  evaluateExpression: EvaluateExpression;

  loadModule: (modulePath: string) => {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  };
}

export interface ArgValues {
  forallArgs: Value[];
  args: (Value | undefined)[];
  implicitArgs: (Value | undefined)[];
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
  value: Value | undefined;
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
