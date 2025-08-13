import { Environment } from "./env";
import { CapturedVariableInfo } from "./evaluator/context";
import { Expr } from "./expr";
import { FunctionType, Type } from "./types";
import type { Value } from "./value";
import { ValueTag } from "./value-tag";

export type FuncValueId = string;

export interface CalledComptFunctionCache {
  funcId: FuncValueId;
  /**
   * The function arguments that were used to call the compt function.
   */
  argValues: Value[];
  /**
   * The environment after the function call.
   */
  env: Environment;
  /**
   * The return value of the compt function call
   */
  value: Value;
  /**
   * Evaluated function body with the given argValues and env.
   */
  body: Expr;
}

export interface SpecializedFunctionCache {
  funcId: FuncValueId;
  /**
   * The environment after the function call.
   */
  env: Environment;
  /**
   * The compile-time arguments that were used to specialize the function.
   */
  compileTimeArgValues: Value[];
  /**
   * The specialized function with evaluated body.
   */
  specializedFunction: FunctionValue;
  /**
   * Evaluated function body with the given argValues and env.
   */
  // body: Expr; // No need to save this. FunctionValue already has the body.
}

export type FunctionValue = {
  tag: ValueTag.Function;

  /**
   * The type of the function.
   */
  type: FunctionType;

  /**
   * The type of the function after removing all the compile-time parameters.
   * This is useful for code generation and other operations.
   */
  specializedType?: FunctionType;

  /**
   * The frame level of the env at which the function is defined.
   */
  frameLevel: number;

  /**
   * The function body expression.
   */
  body: Expr;

  /**
   * The CPS-transformed function body, if the function uses 'do' expressions.
   * This is kept separate from the original body for debugging and other purposes.
   */
  cpsTransformedBody?: Expr;

  /**
   * The function name, if available
   */
  funcName?: string;

  /**
   * The unique identifier of the function
   */
  funcId: FuncValueId;

  /**
   * This is used to cache the result of the call to the function that returns a compt type value.
   * For example, a function returns a Type.
   * If the function is not a compt function, this will be empty.
   */
  calledComptFunctionCaches: CalledComptFunctionCache[];

  /**
   * This is used to cache specialized versions of generic functions with compile-time parameters.
   * Each cache entry stores a specialized function for a specific set of compile-time arguments.
   */
  specializedFunctionCaches: SpecializedFunctionCache[];

  /**
   * For closures, this contains the variables captured from outer scopes.
   * Maps variable name to capture information including frame level, usage type, token, value, and type.
   * This will be useful for codegen to construct a closure struct.
   */
  capturedVariables?: Map<string, FunctionCapturedVariableInfo>;
};

export interface FunctionCapturedVariableInfo extends CapturedVariableInfo {
  value: Value | undefined; // The actual captured value
  type: Type; // The type of the captured value
}
