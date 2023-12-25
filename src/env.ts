import { Region, Type } from "./type-checker";

type ValueTypeKind =
  | "type" // type, enum, type or region parameter
  | "region"
  | "value" // value, function, enum variant
  | "class" // typeclass
  | "module";

export type ValueType = {
  // id: string; // NOTE: The `id` here doesn't really help in generic function
  variableName: string;
  isMutable?: boolean;
  isExported?: boolean;
  type: Type;
  region?: Region;
  kind: ValueTypeKind;
  /* referenceCount of the value inside current frame */
  // referenceCount: number;
  /**
   * frameLevel is the level of the frame where the value is defined.
   * It's zero-based.
   */
  frameLevel: number;
};

let regionCount = 1;
export function getNewRegionId(): string {
  return `'R_${regionCount++}`;
}

type Frame = {
  regionId: string;
  values: ValueType[];
};

function addFrameValueType(frame: Frame, valueType: ValueType): Frame {
  return {
    regionId: frame.regionId,
    values: [...frame.values, valueType],
  };
}

function getFrameValueTypesByVariableName(
  frame: Frame,
  variableName: string,
  kind?: ValueTypeKind
): ValueType[] {
  return frame.values.filter(
    (valueType) =>
      valueType.variableName === variableName &&
      (kind !== undefined ? valueType.kind === kind : true)
  );
}

export type Environment = {
  functionDeclarationFrameLevel: number;
  freeVariables: ValueType[];
  frames: Frame[];
};

export function copyEnvironment(
  env: Environment,
  functionDeclarationFrameLevel: number,
  freeVariables: ValueType[]
): Environment {
  return {
    functionDeclarationFrameLevel:
      functionDeclarationFrameLevel ?? env.functionDeclarationFrameLevel,
    frames: [...env.frames],
    freeVariables: [...freeVariables],
  };
}

export function pushEnvFrame(
  env: Environment,
  frame: Frame = {
    regionId: getNewRegionId(),
    values: [],
  }
): Environment {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: [...env.frames, frame],
  };
}

export function popEnvFrame(env: Environment): Environment {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: env.frames.slice(0, -1),
  };
}

export function addEnvValueType(
  env: Environment,
  valueType: Omit<ValueType, "frameLevel">,
  deltaFrame = 0
): Environment {
  const frameLevel = env.frames.length - 1 + deltaFrame;
  const frame = env.frames[frameLevel];
  const newFrame = addFrameValueType(frame, { ...valueType, frameLevel });
  const newFrames = env.frames.slice();
  newFrames[frameLevel] = newFrame;
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: newFrames,
  };
}

export function addEnvFreeVariable(env: Environment, valueType: ValueType) {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: Array.from(new Set([...env.freeVariables, valueType])),
    frames: env.frames,
  };
}

export function getEnvValueTypesByVariableName(
  env: Environment,
  variableName: string,
  kind?: ValueTypeKind
): ValueType[] {
  const valueTypes: ValueType[] = [];
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    const valueTypesInFrame = getFrameValueTypesByVariableName(
      frame,
      variableName,
      kind
    );
    valueTypes.push(...valueTypesInFrame);
  }
  return valueTypes;
}

export function getEnvCurrentFrameLevel(env: Environment): number {
  return env.frames.length - 1;
}

export function getEnvCurrentRegionId(env: Environment): string {
  return env.frames[env.frames.length - 1].regionId;
}
