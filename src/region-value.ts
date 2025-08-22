import { Environment } from "./env";
import { createRegionType, isRegionType, Type, TypeTag } from "./types";
import { ValueTag } from "./value-tag";

export type RegionValue = {
  tag: ValueTag.Region;
  type: Type & { tag: TypeTag.Region };
  /**
   * unique identifier for the region.
   * We currently use the frame id as the region id.
   */
  id: string;
  /**
   * The lower the number, the longer the lifetime of the region.
   */
  lifetime: number;
};

// TODO: Let's use 0 to represent the static region.
/*
 * key is modulePath, value is lifetime
 */
const lifetimeMap = {};
export function getRegionLifetime(modulePath: string): number {
  return lifetimeMap[modulePath] || 0;
}
export function setRegionLifetime(modulePath: string, lifetime: number): void {
  lifetimeMap[modulePath] = lifetime;
}

export function createRegionValue(env: Environment): RegionValue {
  // One frame should only exist one region value.
  const topFrame = env.frames[env.frames.length - 1];
  if (!topFrame) {
    throw new Error("createRegionValue: No top frame in environment");
  }
  for (const variable of topFrame.variables) {
    if (isRegionType(variable.type)) {
      return variable.value as unknown as RegionValue;
    }
  }

  const lifetime = getRegionLifetime(env.modulePath) + 1;
  setRegionLifetime(env.modulePath, lifetime);

  const regionValue: RegionValue = {
    tag: ValueTag.Region,
    type: createRegionType(),
    lifetime: lifetime,
    id: `${topFrame.id}`,
  };
  return regionValue;
}
