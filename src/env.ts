import { createHash } from "crypto";
import { IfCase, MatchCase } from "./ast";
import { formatErrorMessages, formatWarningMessages } from "./error";
import {
  OperatorPrecedence,
  Operators,
  charIsOperator,
  stringIsOperator,
} from "./operator";
import { Token, TokenType } from "./token";
import {
  TClass,
  TEffect,
  TRegionParameter,
  Type,
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
  id: string; // NOTE: The `id` here doesn't really help in generic function
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

  // Operator precedence
  operatorPrecedence?: OperatorPrecedence;

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

export function generateModuleId(modulePath: string) {
  const hash = createHash("sha1").update(modulePath).digest("hex");
  return "mo" + hash.slice(0, 8);
}

const IdMap = new Map<string, number>();
/**
 * Return the first 10 characters of SHA1 of env.modulePath + variableName
 * @param env
 * @param variableName
 * @returns
 */
export function generateValueTypeId(
  env: Environment,
  variableName: string
): string {
  let sanitizedVariableName = "";
  for (let i = 0; i < variableName.length; i++) {
    if (charIsOperator(variableName[i])) {
      const index = Operators.indexOf(variableName[i]);
      sanitizedVariableName += `${index}`;
    } else {
      sanitizedVariableName += variableName[i];
    }
  }

  const id = generateModuleId(env.modulePath) + "_" + sanitizedVariableName;
  let count = IdMap.get(id);
  if (count === undefined) {
    count = 0;
  } else {
    count++;
  }
  IdMap.set(id, count);
  return id + (count == 0 ? "" : `_${count}`);
}

let tempVariableNameCount = 1;
function generateTempVariableNamePrefix(env: Environment): string {
  return `_${generateModuleId(env.modulePath)}_temp_`;
}
export function generateNewTempVariableName(env: Environment): string {
  return `${generateTempVariableNamePrefix(env)}${tempVariableNameCount++}`;
}
export function isTempVariableName(
  env: Environment,
  variableName: string
): boolean {
  return variableName.startsWith(generateTempVariableNamePrefix(env));
}

type Frame = {
  regionId: string;
  values: ValueType[];
};

function addFrameValueType({
  env,
  frame,
  valueType,
  preventDuplicate,
}: {
  env: Environment;
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
          modulePath: env.modulePath,
          inputString: env.inputString,
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
  inputString: string;
  operatorPrecedenceMap: { [key: string]: OperatorPrecedence };
};

export function copyEnvironment(
  env: Environment,
  functionDeclarationFrameLevel: number,
  freeVariables: ValueType[]
): Environment {
  return {
    functionDeclarationFrameLevel:
      functionDeclarationFrameLevel /*?? env.functionDeclarationFrameLevel*/,
    frames: [...env.frames],
    freeVariables: [...freeVariables],
    modulePath: env.modulePath,
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
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
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
  };
}

export function popEnvFrame(
  env: Environment,
  /* Check synthesizeFunctionTypeFromTokens function in type-checker.ts
   * when withFunctionBody is false, we push fake frame for holding the parameters.
   * In this case, when we pop the frame, we need to **ignoreCheck**
   */
  ignoreCheck = false
): Environment {
  if (!ignoreCheck) {
    const frameToPop = env.frames[env.frames.length - 1];
    // Check if there is any value in the frame that is not consumed or uninitialized
    const unconsumedLinearValues = frameToPop.values.filter(
      (value) =>
        value.kind === "value" &&
        (value.type.kind === "Linear" || value.type.kind === "Type") &&
        !value.consumedAtToken &&
        value.type.permission === "own"
    );
    const unusedFreeValues = frameToPop.values.filter(
      (value) =>
        value.kind === "value" &&
        value.type.kind === "Free" &&
        !value.consumedAtToken &&
        !isTempVariableName(env, value.variableName)
    );

    const uninitializedValues = frameToPop.values.filter(
      (value) => value.isUninitialized
    );
    if (unconsumedLinearValues.length > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: unconsumedLinearValues.map((value) => {
          return {
            token: value.token,
            errorMessage: `${
              isTempVariableName(env, value.variableName) ? "Value" : "Variable"
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
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: uninitializedValues.map((value) => {
          return {
            token: value.token,
            errorMessage: `Variable is not initialized.`,
          };
        }),
      });
    } else if (unusedFreeValues.length > 0) {
      console.warn(
        formatWarningMessages({
          modulePath: env.modulePath,
          inputString: env.inputString,
          tokenAndWarningList: unusedFreeValues.map((value) => {
            return {
              token: value.token,
              warningMessage: `Variable "${value.variableName}" is not used.`,
            };
          }),
        })
      );
    }
  }

  const topFrame = env.frames[env.frames.length - 1];
  const references = topFrame.values.filter(
    (value) => value.type.permission !== "own"
  );
  if (references.length) {
    for (let i = 0; i < references.length; i++) {
      const referedVariable = references[i].referedVariable;
      if (referedVariable) {
        // decrement the reference count
        env = decrementVariableReferenceCount({
          env,
          referedVariable,
        });
      }
    }
  }

  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: env.frames.slice(0, -1),
    modulePath: env.modulePath,
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
  };
}

export function addEnvValueType({
  env,
  valueType,
  deltaFrame,
  preventDuplicate,
  variableId,
}: {
  env: Environment;
  valueType: Omit<ValueType, "frameLevel" | "id">;
  deltaFrame?: number;
  preventDuplicate?: boolean;
  variableId?: string;
}): { env: Environment; value: ValueType } {
  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);
  const frame = env.frames[frameLevel];
  const id = isTempVariableName(env, valueType.variableName)
    ? valueType.variableName
    : variableId ?? generateValueTypeId(env, valueType.variableName);
  const value: ValueType = { ...valueType, frameLevel, id };
  const newFrame = addFrameValueType({
    env,
    frame,
    valueType: value,
    preventDuplicate,
  });
  const newFrames = env.frames.slice();
  newFrames[frameLevel] = newFrame;
  const newEnv: Environment = {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: newFrames,
    modulePath: env.modulePath,
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
  };
  return { env: newEnv, value: value };
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
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
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
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
  };
}

export function addEnvOperatorPrecedence(
  env: Environment,
  operator: string,
  associativity: "infix" | "infixl" | "infixr",
  precedence: number
): Environment {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: env.frames,
    modulePath: env.modulePath,
    inputString: env.inputString,
    operatorPrecedenceMap: {
      ...env.operatorPrecedenceMap,
      [operator]: { operator, associativity, precedence },
    },
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
  consumedAtToken,
}: {
  env: Environment;
  variableName: string;
  consumedAtToken: Token;
}): { env: Environment; referedVariable?: ReferedVariable } {
  const valueTypes = getEnvValueTypesByVariableName(env, variableName);
  if (valueTypes.length === 0) {
    throw formatErrorMessages({
      modulePath: env.modulePath,
      inputString: env.inputString,
      tokenAndErrorList: [
        {
          token: emptyToken,
          errorMessage: `Variable ${variableName} is not defined.`,
        },
      ],
    });
  }
  const valueType = valueTypes[valueTypes.length - 1];
  if (valueType.type.permission !== "own") {
    return { env, referedVariable: valueType.referedVariable };
  }

  const immutableReferences = valueType.immutableReferences ?? [];
  const mutableReferences = valueType.mutableReferences ?? [];
  if (valueType.type.kind === "Linear" || valueType.type.kind === "Type") {
    if (valueType.consumedAtToken) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: valueType.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }

    if (immutableReferences.length > 0) {
      /*
      for (let i = 0; i < immutableReferences.length; i++) {
        const valueType = getEnvValueTypeByReferedVariableToken(
          env,
          immutableReferences[i]
        );
        if (valueType) {
          env = deleteEnvValueType(env, valueType);
        }
      }
      */
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: immutableReferences.map((token) => {
          return {
            token,
            errorMessage: "Previously borrowed as immutable reference here:",
          };
        }),
      });
    }

    if (mutableReferences.length > 0) {
      /*
      for (let i = 0; i < mutableReferences.length; i++) {
        const valueType = getEnvValueTypeByReferedVariableToken(
          env,
          mutableReferences[i]
        );
        if (valueType) {
          env = deleteEnvValueType(env, valueType);
        }
      }
      */

      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: mutableReferences.map((token) => {
          return {
            token,
            errorMessage: "Previously borrowed as mutable reference here:",
          };
        }),
      });
    }
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

  // Check if there is any linear value after that is not consumed
  if (!isTempVariableName(env, variableName)) {
    const { frameLevel, index } = getEnvFrameLevelAndIndexForValueType(
      env,
      valueType
    );
    const frame = env.frames[frameLevel];
    const valuesAfter = [
      ...frame.values.slice(index + 1),
      ...env.frames.slice(frameLevel + 1).flatMap((frame) => frame.values),
    ];
    const linearValuesAfter = valuesAfter.filter(
      (value) =>
        (value.type.kind === "Linear" || value.type.kind === "Type") &&
        value.type.permission === "own" &&
        !value.consumedAtToken
    );
    if (linearValuesAfter.length > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: linearValuesAfter.slice(0, 1).map((value) => {
          return {
            token: value.token,
            errorMessage: `Please consume ${
              isTempVariableName(env, value.variableName)
                ? "the value"
                : `"${value.variableName}"`
            } before "${variableName}":`,
          };
        }),
      });
    }
  }

  const newValueType: ValueType = { ...valueType, consumedAtToken };
  return {
    env: updateExistingValueType(env, valueType, newValueType),
    referedVariable,
  };
}

export function decrementVariableReferenceCount({
  env,
  referedVariable,
}: {
  env: Environment;
  referedVariable: ReferedVariable;
}): Environment {
  const referedFrame = env.frames[referedVariable.frameLevel];
  const referedValueType = referedFrame.values.find(
    (value) => value.variableName === referedVariable.variableName
  );
  if (!referedValueType) {
    throw formatErrorMessages({
      modulePath: env.modulePath,
      inputString: env.inputString,
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
  token,
  isForAssignment,
}: {
  env: Environment;
  variableName: string;
  isMutableReference: boolean;
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
      modulePath: env.modulePath,
      inputString: env.inputString,
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
  if (
    (valueType.type.kind === "Linear" || valueType.type.kind === "Type") &&
    valueType.consumedAtToken
  ) {
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
        modulePath: env.modulePath,
        inputString: env.inputString,
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
  // const immutableReferenceCount = immutableReferences.length;
  // const mutableReferenceCount = mutableReferences.length;
  if (isMutableReference) {
    /* NOTE: We allow to have multiple immutable references and mutable references at the same time.
    if (immutableReferenceCount > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: valueType.token,
            errorMessage: `Variable ${variableName} is already borrowed as immutable reference ${immutableReferenceCount} time(s):

${immutableReferences
  .map((token) =>
    getLineAtToken({
      modulePath: env.modulePath,
      inputString: env.inputString,
      token,
    })
  )
  .join("\n")}`,
          },
        ],
      });
    } else if (mutableReferenceCount > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: valueType.token,
            errorMessage: `Variable "${variableName}" is already borrowed as mutable reference ${mutableReferenceCount} time(s):

${mutableReferences
  .map((token) =>
    getLineAtToken({
      modulePath: env.modulePath,
      inputString: env.inputString,
      token,
    })
  )
  .join("\n")}`,
          },
        ],
      });
    } else */ {
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
    /* NOTE: We allow to have multiple immutable references and mutable references at the same time.
    if (mutableReferenceCount > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: valueType.token,
            errorMessage: `Variable "${variableName}" is already borrowed as mutable reference ${mutableReferenceCount} time(s):

${mutableReferences
  .map((token) =>
    getLineAtToken({
      modulePath: env.modulePath,
      inputString: env.inputString,
      token,
    })
  )
  .join("\n")}`,
          },
        ],
      });
    } else */ {
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

/*
export function setEnvVariableReferedVariable({
  env,
  variableNameToken,
  referedVariable,
}: {
  env: Environment;
  variableNameToken: Token;
  referedVariable: ReferedVariable;
}): Environment {
  const variableName = variableNameToken.value;
  // Increase the reference count for referedVariable
  const frame = env.frames[referedVariable.frameLevel];
  const referedValueType = frame.values.find(
    (value) => value.variableName === referedVariable.variableName
  );
  if (!referedValueType) {
    throw formatErrorMessages({
      modulePath: env.modulePath,
      inputString: env.inputString,
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
      modulePath: env.modulePath,
      inputString: env.inputString,
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
*/

export function getEnvInfixOperatorPrecedence(
  env: Environment,
  operator: string
): OperatorPrecedence | undefined {
  if (
    stringIsOperator(operator) &&
    // check token.ts
    operator !== "." &&
    operator !== "=" &&
    operator !== ":" &&
    operator !== "->" &&
    operator !== "=>" &&
    !env.operatorPrecedenceMap[operator]
  ) {
    return undefined;
    // throw new Error(`The precedence of operator ${operator} is not defined.`);
  }

  return env.operatorPrecedenceMap[operator];
}

/**
 * Zero-based frame level.
 * @param env
 * @returns
 */
export function getEnvCurrentFrameLevel(env: Environment): number {
  return env.frames.length - 1;
}

export function getEnvCurrentRegionId(env: Environment): string {
  return env.frames[env.frames.length - 1].regionId;
}

export function createNewEnv({
  modulePath,
  inputString,
}: {
  modulePath: string;
  inputString: string;
}): Environment {
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
    inputString,
    operatorPrecedenceMap: {},
  };
}

/**
 * Update `env` based on multiple envs in different cases.
 * @param env
 */
export function mergeAndCheckEnv(
  env: Environment,
  cases: (IfCase | MatchCase)[]
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
        modulePath: env.modulePath,
        inputString: env.inputString,
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
          modulePath: env.modulePath,
          inputString: env.inputString,
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
            modulePath: env.modulePath,
            inputString: env.inputString,
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

      // Check the "Free" values.
      // If any case consumed (used) the "Free" value, then we set it as consumed in env.
      if (frameValues[i].type.kind === "Free") {
        const consumed = tokens.filter((t) => !!t) as Token[];
        if (consumed.length > 0) {
          const newValueType: ValueType = {
            ...frameValues[i],
            consumedAtToken: tokens[0],
          };
          env = updateExistingValueType(env, frameValues[i], newValueType);
        }
        continue;
      }

      // case 1
      if (tokens.length === 1) {
        if (!!tokens[0] && !frameValues[i].consumedAtToken) {
          throw formatErrorMessages({
            modulePath: env.modulePath,
            inputString: env.inputString,
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
            modulePath: env.modulePath,
            inputString: env.inputString,
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

/*
function getEnvValueTypeByReferedVariableToken(
  env: Environment,
  token: Token
): ValueType | null {
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    const valueType = frame.values.find(
      (value) => value.referedVariable?.token === token
    );
    if (valueType) {
      return valueType;
    }
  }
  return null;
}

function deleteEnvValueType(
  env: Environment,
  valueType: ValueType
): Environment {
  const frames = env.frames.map((frame) => {
    const values = frame.values.filter((value) => value !== valueType);
    return { ...frame, values };
  });
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames,
    modulePath: env.modulePath,
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
  };
}
*/

export function createTopLevelEnv(
  env: Environment,
  delta: number = 0
): Environment {
  return {
    functionDeclarationFrameLevel: -1,
    frames: env.frames.slice(0, 1 + delta),
    freeVariables: [],
    modulePath: env.modulePath,
    inputString: env.inputString,
    operatorPrecedenceMap: env.operatorPrecedenceMap,
  };
}

export function getEnvFrameLevelAndIndexForValueType(
  env: Environment,
  valueType: ValueType
): { frameLevel: number; index: number } {
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    const index = frame.values.findIndex((v) => v === valueType);
    if (index > -1) {
      return { frameLevel: i, index };
    }
  }
  throw new Error("Failed to find the value type in env.");
}
