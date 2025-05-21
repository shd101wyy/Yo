import { Environment } from "./env";
import { Expr } from "./expr";
import { FunctionType, Type } from "./type-checker";
import { TypeValue } from "./type-value";
import type { Value } from "./value";
import { ValueTag } from "./value-tag";

export interface CalledTypeFunctionCache {
  funcId: string;
  argValues: Value[];
  env: Environment;
  typeValue: TypeValue;
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
   * This is used to cache the result of the call to the type function (a function that returns a Type)
   * If the function is not a type function, this will be empty.
   */
  calledTypeFunctionCaches: CalledTypeFunctionCache[];
};
