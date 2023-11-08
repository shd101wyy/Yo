import { Type } from "./type-checker";

export type ValueType = {
  id: string;
  variableName: string;
  // accessors: string[];
  type: Type;
  /* referenceCount of the value inside current frame */
  // referenceCount: number;

  /**
   * frameLevel is the level of the frame where the value is defined.
   * It's zero-based.
   */
  frameLevel: number;
};

type Frame = ValueType[];

function addFrameValueType(frame: Frame, valueType: ValueType): Frame {
  return [...frame, valueType];
}

function getFrameValueTypesByVariableName(
  frame: Frame,
  variableName: string
): ValueType[] {
  return frame.filter((valueType) => valueType.variableName === variableName);
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

export function pushEnvFrame(env: Environment, frame: Frame = []): Environment {
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

function GetVariableId() {
  const variableNameCounter: { [key: string]: number } = {};
  return (variableName: string) => {
    if (variableName in variableNameCounter) {
      variableNameCounter[variableName] = variableNameCounter[variableName] + 1;
    } else {
      variableNameCounter[variableName] = 0;
    }
    const counter = variableNameCounter[variableName];
    if (counter === 0) {
      return variableName;
    } else {
      return variableName + "_" + counter;
    }
  };
}
export const getEnvVariableId = GetVariableId();

export function addEnvValueType(
  env: Environment,
  valueType: Omit<ValueType, "id" | "frameLevel"> & { id?: string },
  deltaFrame = 0
): Environment {
  const frameLevel = env.frames.length - 1 + deltaFrame;
  const frame = env.frames[frameLevel];
  const id = valueType.id ?? getEnvVariableId(valueType.variableName);
  const newFrame = addFrameValueType(frame, { ...valueType, id, frameLevel });
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
  variableName: string
): ValueType[] {
  const valueTypes: ValueType[] = [];
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    const valueTypesInFrame = getFrameValueTypesByVariableName(
      frame,
      variableName
    );
    valueTypes.push(...valueTypesInFrame);
  }
  return valueTypes;
}

export function getEnvCurrentFrameLevel(env: Environment): number {
  return env.frames.length - 1;
}
