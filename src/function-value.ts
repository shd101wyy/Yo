import { Environment } from "./env";
import { Expr } from "./expr";
import { FunctionType, Type } from "./types";
import type { Value } from "./value";
import { ValueTag } from "./value-tag";

export interface CalledComptFunctionCache {
  funcId: string;
  argValues: Value[];
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
  // TODO: Let's make it mandatory for now
  funcId: string;

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

export interface SpecializedFunctionCache {
  funcId: string;
  compileTimeArgValues: Value[]; // Only compile-time arguments
  specializedFunction: FunctionValue; // The specialized function with evaluated body
}
