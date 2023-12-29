import { formatErrorMessages } from "./error";
import { Token } from "./token";
import { Region, TClass, TEffect, Type } from "./type-checker";

type ValueTypeKind =
  | "type" // type, enum, type or region parameter
  | "region"
  | "value" // value, function, enum variant
  | "class" // typeclass
  | "effect" // effect
  | "module";

export type ValueType = {
  // id: string; // NOTE: The `id` here doesn't really help in generic function
  variableName: string;
  isMutable?: boolean;
  isExported?: boolean;
  isUninitialized?: boolean;
  isConsumed?: boolean;
  type: Type;
  region?: Region;
  effect?: TEffect;
  class?: TClass;
  kind: ValueTypeKind;
  /* referenceCount of the value inside current frame */
  // referenceCount: number;
  /**
   * frameLevel is the level of the frame where the value is defined.
   * It's zero-based.
   */
  frameLevel: number;
  /**
   * At which token the variable is defined.
   */
  token: Token;
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
  // Check if there is already a value with the same variableName
  // but is uninitialized
  const existingValueTypeIndex = frame.values.findIndex(
    (valueType) =>
      valueType.variableName === valueType.variableName &&
      valueType.isUninitialized
  );
  if (existingValueTypeIndex > -1) {
    const newValues = frame.values.slice();
    newValues[existingValueTypeIndex] = valueType;
    return {
      regionId: frame.regionId,
      values: newValues,
    };
  } else {
    return {
      regionId: frame.regionId,
      values: [...frame.values, valueType],
    };
  }
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
  modulePath: string;
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
    modulePath: env.modulePath,
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
    modulePath: env.modulePath,
  };
}

export function popEnvFrame(
  env: Environment,
  inputString: string
): Environment {
  const frameToPop = env.frames[env.frames.length - 1];
  // Check if there is any value in the frame that is not consumed or uninitialized
  if (
    frameToPop.values.some(
      (valueType) =>
        (valueType.type.kind === "Linear" || valueType.type.kind === "Type") &&
        !valueType.isConsumed
    )
  ) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: frameToPop.values.map((value) => {
        return {
          token: value.token,
          errorMessage: `"${value.variableName}" is linear type but is not consumed.`,
        };
      }),
    });
  } else if (
    frameToPop.values.some((valueType) => !valueType.isUninitialized)
  ) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: frameToPop.values.map((value) => {
        return {
          token: value.token,
          errorMessage: `"${value.variableName}" is not uninitialized.`,
        };
      }),
    });
  }

  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: env.frames.slice(0, -1),
    modulePath: env.modulePath,
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
    modulePath: env.modulePath,
  };
}

export function updateExistingValueType(
  env: Environment,
  valueType: ValueType,
  newValueType: ValueType
): Environment {
  const frames = env.frames.map((frame) => {
    const values = frame.values.map((value) =>
      value === valueType ? newValueType : value
    );
    return { ...frame, values };
  });
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames,
    modulePath: env.modulePath,
  };
}

export function addEnvFreeVariable(
  env: Environment,
  valueType: ValueType
): Environment {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: Array.from(new Set([...env.freeVariables, valueType])),
    frames: env.frames,
    modulePath: env.modulePath,
  };
}

export function isVariableNameInitializedInEnvFrame(
  env: Environment,
  variableName: string,
  frameLevel?: number
): boolean {
  const frameLevel_ = frameLevel ?? getEnvCurrentFrameLevel(env);
  const frame = env.frames[frameLevel_];
  return frame.values.some(
    (valueType) =>
      valueType.variableName === variableName && !valueType.isUninitialized
  );
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

export function createNewEnv(modulePath: string): Environment {
  return {
    functionDeclarationFrameLevel: -1,
    frames: [
      {
        regionId: getNewRegionId(),
        values: [],
      },
    ],
    freeVariables: [],
    modulePath,
  };
}
