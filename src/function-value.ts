import { Environment } from "./env";
import { CapturedVariableInfo } from "./evaluator/context";
import { Expr } from "./expr";
import { FnModuleType, FunctionType, Type } from "./types";
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
   * Closure-specific information.
   * Only set for functions that are closure implementations.
   * Contains the FnModuleType and capture struct type for easy access during codegen.
   */
  closureInfo?: ClosureInfo;
};

export interface FunctionCapturedVariableInfo extends CapturedVariableInfo {
  value: Value | undefined; // The actual captured value
  type: Type; // The type of the captured value
}

/**
 * Information about a closure, stored on closure function values.
 * This allows codegen to easily access the closure type and capture struct type
 * without having to search through the type collection.
 */
export interface ClosureInfo {
  /**
   * The FnModuleType that represents this closure's callable interface
   */
  closureType: FnModuleType;

  /**
   * The capture struct type that holds captured variables
   */
  captureType: Type | undefined; // StructType | undefined
}
