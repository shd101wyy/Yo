import { Type } from "./type-checker";
import { ValueTag } from "./value-tag";

export type TypeValue = {
  /**
   * This is for value such as
   *    MyI32 := i32
   *
   * i32 is the value, where:
   *    .type = Free
   *    .value = i32
   */
  tag: ValueTag.Type;
  /**
   * Type of the .value
   */
  type: Type;

  /**
   * Such as TFree, TLinear, TType, TI32, TBoolean, TStruct, etc.
   */
  value: Type;
};
