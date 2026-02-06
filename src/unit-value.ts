import { createUnitType } from "./types/creators";
import type { Type } from "./types/definitions";
import { ValueTag } from "./value-tag";

export type UnitValue = {
  tag: ValueTag.Unit;
  type: Type;
};

export const VUnit: UnitValue = {
  tag: ValueTag.Unit,
  type: createUnitType(),
};
