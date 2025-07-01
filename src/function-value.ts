import { Environment } from "./env";
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
}

export type FunctionValue = {
  tag: ValueTag.Function;
  type: FunctionType;
  frameLevel: number;
  body: Expr;

  /**
   * The function name, if available
   */
  funcName?: string;

  /**
   * The unique identifier of the function
   */
  funcId: FuncValueId;

  /**
   * Under which type the function is defined,
   * for example, it might be an interface
   */
  SelfType?: Type;

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
};
