import { IfCase, MatchCase } from "./ast";
import { formatErrorMessages, getLineAtToken } from "./error";
import { Token, TokenType } from "./token";
import {
  TClass,
  TEffect,
  TRegionParameter,
  Type,
  typeIsReferenceOrMutableReference,
  typeToString,
} from "./type-checker";

export const emptyToken: Token = {
  position: {
    line: 0,
    character: 0,
  },
  type: TokenType.Undefined,
  value: "",
};

type ValueTypeKind =
  | "type" // type, enum, type or region parameter
  | "region"
  | "value" // value, function, enum variant
  | "class" // typeclass
  | "effect" // effect
  | "module";

export type ReferedVariable = {
  frameLevel: number;
  variableName: string;
  isMutableReference: boolean;
  /**
   * token where the reference is created
   */
  token: Token;
};

export type ValueType = {
  // id: string; // NOTE: The `id` here doesn't really help in generic function
  variableName: string;

  // different kinds of values
  type: Type;
  region?: TRegionParameter;
  effect?: TEffect;
  class?: TClass;
  kind: ValueTypeKind;

  // some flags
  isMutable?: boolean;
  isExported?: boolean;
  isUninitialized?: boolean;

  // Check linear type is consumed
  consumedAtToken?: Token;

  // References
  mutableReferences?: Token[];
  immutableReferences?: Token[];

  // This is only used for temp variable, check the
  // tempVariableName of the ReferenceExpr of AstType.Reference
  referedVariable?: ReferedVariable;

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

let tempVariableNameCount = 1;
export function getNewTempVariableName(): string {
  return `$$temp_${tempVariableNameCount++}`;
}
export function isTempVariableName(variableName: string): boolean {
  return variableName.startsWith("$$temp_");
}

type Frame = {
  regionId: string;
  values: ValueType[];
};

function addFrameValueType({
  inputString,
  frame,
  valueType,
  preventDuplicate,
}: {
  inputString: string;
  frame: Frame;
  valueType: ValueType;
  preventDuplicate?: boolean;
}): Frame {
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
    if (preventDuplicate) {
      const existingValue = frame.values.find(
        (value) => value.variableName === valueType.variableName
      );
      if (existingValue) {
        throw formatErrorMessages({
          inputString,
          tokenAndErrorList: [
            {
              token: valueType.token,
              errorMessage: `Failed to define variable "${valueType.variableName}":`,
            },
            {
              token: existingValue.token,
              errorMessage: `Variable "${existingValue.variableName}" is already defined here:`,
            },
          ],
        });
      }
    }

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
  inputString: string,
  ignoreCheck = false
): Environment {
  if (!ignoreCheck) {
    const frameToPop = env.frames[env.frames.length - 1];
    // Check if there is any value in the frame that is not consumed or uninitialized
    const unconsumedValues = frameToPop.values.filter(
      (value) =>
        value.kind === "value" &&
        (value.type.kind === "Linear" || value.type.kind === "Type") &&
        !value.consumedAtToken &&
        // NOTE: reference and mutable reference are linear
        // but we automatically consume in the end.
        !typeIsReferenceOrMutableReference(value.type)
    );

    const uninitializedValues = frameToPop.values.filter(
      (value) => value.isUninitialized
    );
    if (unconsumedValues.length > 0) {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: unconsumedValues.map((value) => {
          return {
            token: value.token,
            errorMessage: `${
              isTempVariableName(value.variableName) ? "Value" : "Variable"
            } is "Linear" type but is not consumed:
${typeToString(value.type)}${
              value.type.type === "TypeConstructor" &&
              value.type.name === "Promise"
                ? `\nPlease consider using \`await\` to consume the "Promise" value.`
                : ""
            }`,
          };
        }),
      });
    } else if (uninitializedValues.length > 0) {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: uninitializedValues.map((value) => {
          return {
            token: value.token,
            errorMessage: `Variable is not uninitialized.`,
          };
        }),
      });
    }
  }

  const topFrame = env.frames[env.frames.length - 1];
  const references = topFrame.values.filter((value) =>
    typeIsReferenceOrMutableReference(value.type)
  );
  if (references.length) {
    for (let i = 0; i < references.length; i++) {
      const referedVariable = references[i].referedVariable;
      if (referedVariable) {
        // decrement the reference count
        env = decrementVariableReferenceCount({
          env,
          referedVariable,
          inputString,
        });
      }
    }
  }

  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: env.frames.slice(0, -1),
    modulePath: env.modulePath,
  };
}

export function addEnvValueType({
  inputString,
  env,
  valueType,
  deltaFrame,
  preventDuplicate,
}: {
  inputString: string;
  env: Environment;
  valueType: Omit<ValueType, "frameLevel">;
  deltaFrame?: number;
  preventDuplicate?: boolean;
}): Environment {
  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);
  const frame = env.frames[frameLevel];
  const newFrame = addFrameValueType({
    inputString,
    frame,
    valueType: { ...valueType, frameLevel },
    preventDuplicate,
  });
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

export function setEnvVariableAsConsumed({
  env,
  variableName,
  inputString,
  consumedAtToken,
}: {
  env: Environment;
  variableName: string;
  inputString: string;
  consumedAtToken: Token;
}): { env: Environment; referedVariable?: ReferedVariable } {
  const valueTypes = getEnvValueTypesByVariableName(env, variableName);
  if (valueTypes.length === 0) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: [
        {
          token: emptyToken,
          errorMessage: `Variable ${variableName} is not defined.`,
        },
      ],
    });
  }
  const valueType = valueTypes[valueTypes.length - 1];
  const immutableReferences = valueType.immutableReferences ?? [];
  const mutableReferences = valueType.mutableReferences ?? [];
  if (valueType.consumedAtToken) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: [
        /*
        {
          token: valueType.token,
          errorMessage: `${
            isTempVariableName(variableName) ? "Value" : "Variable"
          } is already consumed.`,
        },
        */
        {
          token: valueType.consumedAtToken,
          errorMessage: `Previously consumed here:`,
        },
      ],
    });
  } else if (immutableReferences.length > 0) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: immutableReferences.map((token) => {
        return {
          token,
          errorMessage: "Previously borrowed as immutable reference here:",
        };
      }),
    });
  } else if (mutableReferences.length > 0) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: mutableReferences.map((token) => {
        return {
          token,
          errorMessage: "Previously borrowed as mutable reference here:",
        };
      }),
    });
  }

  const referedVariable = valueType.referedVariable;
  /* // NOTE: We shouldn't decrement the reference count here
     // when we consume a (immutable) reference.
     // Instead, we decrement when the (immutable) reference is out of the scope and dropped
     // when we `popEnvFrame`.
  if (referedVariable) {
    // decrement the reference count
    env = decrementVariableReferenceCount({
      env,
      referedVariable,
      inputString,
    });
  }
  */

  const newValueType: ValueType = { ...valueType, consumedAtToken };
  return {
    env: updateExistingValueType(env, valueType, newValueType),
    referedVariable,
  };
}

export function decrementVariableReferenceCount({
  env,
  referedVariable,
  inputString,
}: {
  env: Environment;
  referedVariable: ReferedVariable;
  inputString;
}): Environment {
  const referedFrame = env.frames[referedVariable.frameLevel];
  const referedValueType = referedFrame.values.find(
    (value) => value.variableName === referedVariable.variableName
  );
  if (!referedValueType) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: [
        {
          token: referedVariable.token,
          errorMessage: `Failed to find the refered variable "${referedVariable.variableName}"`,
        },
      ],
    });
  }
  let mutableReferences = referedValueType.mutableReferences ?? [];
  let immutableReferences = referedValueType.immutableReferences ?? [];
  if (referedVariable.isMutableReference) {
    mutableReferences = mutableReferences.filter(
      (r) => r !== referedVariable.token
    );
  } else {
    immutableReferences = immutableReferences.filter(
      (r) => r !== referedVariable.token
    );
  }

  env = updateExistingValueType(env, referedValueType, {
    ...referedValueType,
    mutableReferences,
    immutableReferences,
  });
  return env;
}

export function increaseEnvVariableReferenceCount({
  env,
  variableName,
  isMutableReference,
  inputString,
  token,
  isForAssignment,
}: {
  env: Environment;
  variableName: string;
  isMutableReference: boolean;
  inputString: string;
  token: Token;
  isForAssignment?: boolean;
}): {
  env: Environment;
  referedVariable: ReferedVariable;
  resetConsumedVariable: boolean;
} {
  const valueTypes = getEnvValueTypesByVariableName(env, variableName);
  if (valueTypes.length === 0) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: [
        {
          token: emptyToken,
          errorMessage: `Variable ${variableName} is not defined.`,
        },
      ],
    });
  }

  let resetConsumedVariable = false;
  let valueType = valueTypes[valueTypes.length - 1];
  if (valueType.consumedAtToken) {
    if (isForAssignment) {
      // NOTE: If it's for assignment, then we allow to reuse the consumed variable.
      const newValueType: ValueType = {
        ...valueType,
        consumedAtToken: undefined,
        token: token,
      };
      env = updateExistingValueType(env, valueType, newValueType);
      valueType = newValueType; // <= This is necessary
      resetConsumedVariable = true;
    } else {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: [
          {
            token: valueType.consumedAtToken,
            errorMessage: `Variable "${variableName}" is already consumed here:`,
          },
        ],
      });
    }
  }

  const immutableReferences = valueType.immutableReferences ?? [];
  const mutableReferences = valueType.mutableReferences ?? [];
  const immutableReferenceCount = immutableReferences.length;
  const mutableReferenceCount = mutableReferences.length;
  if (isMutableReference) {
    if (immutableReferenceCount > 0) {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: [
          {
            token: valueType.token,
            errorMessage: `Variable ${variableName} is already borrowed as immutable reference:

${immutableReferences
  .map((token) => getLineAtToken(inputString, token))
  .join("\n")}`,
          },
        ],
      });
    } else if (mutableReferenceCount > 0) {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: [
          {
            token: valueType.token,
            errorMessage: `Variable "${variableName}" is already borrowed as mutable reference:

${mutableReferences
  .map((token) => getLineAtToken(inputString, token))
  .join("\n")}`,
          },
        ],
      });
    } else {
      const newValueType: ValueType = {
        ...valueType,
        mutableReferences: [...mutableReferences, token],
      };
      return {
        env: updateExistingValueType(env, valueType, newValueType),
        referedVariable: {
          variableName,
          frameLevel: valueType.frameLevel,
          isMutableReference,
          token,
        },
        resetConsumedVariable,
      };
    }
  } else {
    // immutable reference
    if (mutableReferenceCount > 0) {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: [
          {
            token: valueType.token,
            errorMessage: `Variable "${variableName}" is already borrowed as mutable reference:

${mutableReferences
  .map((token) => getLineAtToken(inputString, token))
  .join("\n")}`,
          },
        ],
      });
    } else {
      const newValueType: ValueType = {
        ...valueType,
        immutableReferences: [...immutableReferences, token],
      };
      return {
        env: updateExistingValueType(env, valueType, newValueType),
        referedVariable: {
          variableName,
          frameLevel: valueType.frameLevel,
          isMutableReference,
          token,
        },
        resetConsumedVariable,
      };
    }
  }
}

export function setEnvVariableReferedVariable({
  env,
  variableNameToken,
  referedVariable,
  inputString,
}: {
  env: Environment;
  variableNameToken: Token;
  referedVariable: ReferedVariable;
  inputString: string;
}): Environment {
  const variableName = variableNameToken.value;
  // Increase the reference count for referedVariable
  const frame = env.frames[referedVariable.frameLevel];
  const referedValueType = frame.values.find(
    (value) => value.variableName === referedVariable.variableName
  );
  if (!referedValueType) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: [
        {
          token: referedVariable.token,
          errorMessage: `Failed to find the refered variable "${referedVariable.variableName}"`,
        },
      ],
    });
  }
  const immutableReferences = referedValueType.immutableReferences ?? [];
  const mutableReferences = referedValueType.mutableReferences ?? [];
  if (referedVariable.isMutableReference) {
    mutableReferences.push(variableNameToken);
  } else {
    immutableReferences.push(variableNameToken);
  }
  const newValueType: ValueType = {
    ...referedValueType,
    immutableReferences,
    mutableReferences,
  };
  const nextEnv = updateExistingValueType(env, referedValueType, newValueType);

  const newReferedVariable: ReferedVariable = {
    ...referedVariable,
    token: variableNameToken,
  };
  const variableValueType = nextEnv.frames[
    nextEnv.frames.length - 1
  ].values.find((value) => value.variableName === variableName);
  if (!variableValueType) {
    throw formatErrorMessages({
      inputString,
      tokenAndErrorList: [
        {
          token: variableNameToken,
          errorMessage: `Failed to find the variable "${variableName}"`,
        },
      ],
    });
  }
  return updateExistingValueType(nextEnv, variableValueType, {
    ...variableValueType,
    referedVariable: newReferedVariable,
  });
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

/**
 * Update `env` based on multiple envs in different cases.
 * @param env
 */
export function mergeAndCheckEnv(
  env: Environment,
  cases: (IfCase | MatchCase)[],
  inputString: string
): Environment {
  const maxFrameLevel = env.frames.length - 1;
  const caseEnvs: Environment[] = [];
  for (let i = 0; i < cases.length; i++) {
    const caseEnv = cases[i].body.env;
    caseEnvs.push(caseEnv);
  }

  // Check if the frame level is the same for all cases
  for (let i = 0; i < caseEnvs.length; i++) {
    const caseEnv = caseEnvs[i];
    if (caseEnv.frames.length - 1 !== maxFrameLevel) {
      throw formatErrorMessages({
        inputString,
        tokenAndErrorList: [
          {
            token: cases[i].body.token,
            errorMessage: `Frame level is different for different cases.`,
          },
        ],
      });
    }
  }

  // Check each frame
  for (let i = 0; i <= maxFrameLevel; i++) {
    const frame = env.frames[i];
    const frameValues = frame.values;

    // Build the consumedAtToken matrix
    // that has 1 + caseEnvs.length rows
    // and frameValues.length columns
    // each cell is consumedAtToken of the value
    const matrix: (Token | undefined)[][] = [[]];
    frameValues.forEach((value) => {
      matrix[0].push(value.consumedAtToken);
    });

    for (let j = 0; j < caseEnvs.length; j++) {
      const caseEnv = caseEnvs[j];
      const caseEnvFrame = caseEnv.frames[i];
      const caseEnvFrameValues = caseEnvFrame.values;

      // Check if the number of values is the same
      if (frameValues.length !== caseEnvFrameValues.length) {
        throw formatErrorMessages({
          inputString,
          tokenAndErrorList: [
            {
              token: cases[j].body.token,
              errorMessage: `Frame level ${i} has different number of values for different cases.`,
            },
          ],
        });
      }

      // Check if the variable names are the same
      for (let k = 0; k < frameValues.length; k++) {
        const frameValue = frameValues[k];
        const caseEnvFrameValue = caseEnvFrameValues[k];
        if (frameValue.variableName !== caseEnvFrameValue.variableName) {
          throw formatErrorMessages({
            inputString,
            tokenAndErrorList: [
              {
                token: cases[j].body.token,
                errorMessage: `Frame level ${i} has different variable names for different cases.`,
              },
            ],
          });
        }
      }

      // TODO: Check type, but I think it's unnecessary here.

      // Check the consumedAtToken
      matrix.push([]);
      caseEnvFrameValues.forEach((value) => {
        matrix[matrix.length - 1].push(value.consumedAtToken);
      });
    }

    // Check the matrix column to make sure that
    // for each variable:
    // 1. If there is only one case, and it's not consumed in env, but consumed in the case, then throw error.
    // 2. If have consumed in all cases, then set it as consumed in env.
    // 3. If some are consumed in some cases, then throw error.
    const rows = matrix.length;
    const cols = matrix[0].length;
    for (let i = 0; i < cols; i++) {
      const variableName = frameValues[i].variableName;
      const tokens: (Token | undefined)[] = [];
      for (let j = 1; j < rows; j++) {
        tokens.push(matrix[j][i]);
      }

      // case 1
      if (tokens.length === 1) {
        if (!!tokens[0] && !frameValues[i].consumedAtToken) {
          throw formatErrorMessages({
            inputString,
            tokenAndErrorList: [
              {
                token: frameValues[i].token,
                errorMessage: `Variable "${variableName}" might not be consumed in all cases:`,
              },
              {
                token: tokens[0],
                errorMessage: `Might be consumed here:`,
              },
            ],
          });
        }
      }
      // case 2
      else if (tokens.every((t) => !!t)) {
        const newValueType: ValueType = {
          ...frameValues[i],
          consumedAtToken: tokens[0],
        };
        env = updateExistingValueType(env, frameValues[i], newValueType);
      } else {
        // case 3
        const consumed = tokens.filter((t) => !!t) as Token[];
        const notConsumed = tokens.filter((t) => !t);
        if (consumed.length > 0 && notConsumed.length > 0) {
          throw formatErrorMessages({
            inputString,
            errorMessage: `Variable "${variableName}" might be consumed in some cases but not consumed in other cases:\n`,
            tokenAndErrorList: tokens.map((token, index) => {
              return {
                errorMessage: token
                  ? "Might be consumed here:"
                  : "Not consumed here:",
                token: token ?? cases[index].body.token,
              };
            }),
          });
        }
      }
    }
  }

  return env;
}
