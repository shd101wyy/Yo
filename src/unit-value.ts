import { TUnit, Type } from "./type-checker";
import { ValueTag } from "./value-tag";

export type UnitValue = {
  tag: ValueTag.Unit;
  type: Type;
};

export const VUnit: UnitValue = {
  tag: ValueTag.Unit,
  type: TUnit,
};
