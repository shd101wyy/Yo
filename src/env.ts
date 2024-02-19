import { createHash } from "crypto";
import { IfCase, MatchCase } from "./ast";
import { formatErrorMessages } from "./error";
import {
  OperatorPrecedence,
  Operators,
  charIsOperator,
  stringIsOperator,
} from "./operator";
import { Token, TokenType } from "./token";
import {
  TInterface,
  TInterfaceFunction,
  Type,
  checkType,
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

type VariableValueKind =
  | "type" // type, enum, type or region parameter
  | "region"
  | "value" // value, function, enum variant
  | "interface" // interface
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

export type VariableValue = {
  id: string; // NOTE: The `id` here doesn't really help in generic function
  variableName: string;

  // different kinds of values
  type: Type;
  interface?: TInterface;
  kind: VariableValueKind;

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
export function generateVarialeValueId(
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
  values: VariableValue[];
};

function addFrameVariableValue({
  env,
  frame,
  variableValue,
  preventDuplicate,
}: {
  env: Environment;
  frame: Frame;
  variableValue: VariableValue;
  preventDuplicate?: boolean;
}): Frame {
  // Check if there is already a value with the same variableName
  // but is uninitialized
  const existingValueIndex = frame.values.findIndex(
    (value_) =>
      value_.variableName === variableValue.variableName &&
      value_.isUninitialized
  );
  if (existingValueIndex > -1) {
    const newValues = frame.values.slice();
    newValues[existingValueIndex] = variableValue;
    return {
      regionId: frame.regionId,
      values: newValues,
    };
  } else {
    if (preventDuplicate) {
      const existingValue = frame.values.find(
        (value) => value.variableName === variableValue.variableName
      );
      if (existingValue) {
        throw formatErrorMessages({
          modulePath: env.modulePath,
          inputString: env.inputString,
          tokenAndErrorList: [
            {
              token: variableValue.token,
              errorMessage: `Failed to define variable "${variableValue.variableName}":`,
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
      values: [...frame.values, variableValue],
    };
  }
}

function getFrameVariableValuesByVariableName(
  frame: Frame,
  variableName: string,
  kind?: VariableValueKind
): VariableValue[] {
  return frame.values.filter(
    (value) =>
      value.variableName === variableName &&
      (kind !== undefined ? value.kind === kind : true)
  );
}

export type Environment = {
  functionDeclarationFrameLevel: number;
  freeVariables: VariableValue[];
  frames: Frame[];
  modulePath: string;
  inputString: string;
  operatorPrecedenceMap: { [key: string]: OperatorPrecedence };
};

export function copyEnvironment(
  env: Environment,
  functionDeclarationFrameLevel: number,
  freeVariables: VariableValue[]
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
    /*
    const unusedFreeValues = frameToPop.values.filter(
      (value) =>
        value.kind === "value" &&
        value.type.kind === "Free" &&
        !value.consumedAtToken &&
        !isTempVariableName(env, value.variableName)
    );
    */

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
              value.type.typeConstructorId === "Promise"
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
    } /* else if (unusedFreeValues.length > 0) {
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
    }*/
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

export function addEnvVariableValue({
  env,
  variableValue,
  deltaFrame,
  preventDuplicate,
  variableId,
}: {
  env: Environment;
  variableValue: Omit<VariableValue, "frameLevel" | "id" | "order">;
  deltaFrame?: number;
  preventDuplicate?: boolean;
  variableId?: string;
}): { env: Environment; value: VariableValue } {
  // Disable anonymous record
  if (variableValue.kind === "value" && variableValue.type.type === "Record") {
    throw formatErrorMessages({
      modulePath: env.modulePath,
      inputString: env.inputString,
      tokenAndErrorList: [
        {
          token: variableValue.token,
          errorMessage: `Anonymous record is currently not allowed.`,
        },
      ],
    });
  }

  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);
  const frame = env.frames[frameLevel];
  const id = isTempVariableName(env, variableValue.variableName)
    ? variableValue.variableName
    : variableId ?? generateVarialeValueId(env, variableValue.variableName);
  const value: VariableValue = { ...variableValue, frameLevel, id };
  const newFrame = addFrameVariableValue({
    env,
    frame,
    variableValue: value,
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

  if (variableValue.referedVariable) {
    env = setEnvVariableReferedVariable({
      env: newEnv,
      variableName: variableValue.variableName,
      variableToken: variableValue.token,
      referedVariable: variableValue.referedVariable,
    });
  }

  return { env: newEnv, value: value };
}

export function updateExistingVariableValue(
  env: Environment,
  variableValue: VariableValue,
  newVariableValue: VariableValue
): Environment {
  const frames = env.frames.map((frame) => {
    const values = frame.values.map((value) =>
      value === variableValue ? newVariableValue : value
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
  variableValue: VariableValue
): Environment {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: Array.from(new Set([...env.freeVariables, variableValue])),
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
    (value) => value.variableName === variableName && !value.isUninitialized
  );
}

export function getEnvVariableValueByVariableName(
  env: Environment,
  variableName: string,
  kind?: VariableValueKind
): VariableValue[] {
  const variableValues: VariableValue[] = [];
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    const variableValuesInFrame = getFrameVariableValuesByVariableName(
      frame,
      variableName,
      kind
    );
    variableValues.push(...variableValuesInFrame);
  }
  return variableValues;
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
  const variableValues = getEnvVariableValueByVariableName(env, variableName);
  if (variableValues.length === 0) {
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
  const variableValue = variableValues[variableValues.length - 1];

  if (
    variableValue.type.permission === "read" ||
    variableValue.type.permission === "write"
  ) {
    if (
      variableValue.type.kind === "Linear" ||
      variableValue.type.kind === "Type"
    ) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: variableValue.token,
            errorMessage: `Variable "${variableName}" doesn't "own" the value. Please consider adding "read" or "write" in front.`,
          },
        ],
      });
    }

    return { env, referedVariable: variableValue.referedVariable };
  }

  const immutableReferences = variableValue.immutableReferences ?? [];
  const mutableReferences = variableValue.mutableReferences ?? [];
  if (
    variableValue.type.kind === "Linear" ||
    variableValue.type.kind === "Type"
  ) {
    if (variableValue.consumedAtToken) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: variableValue.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }

    // QUESTION: We probably don't need to check this because
    //           we will set all valuesAfter as consumed.
    if (immutableReferences.length > 0) {
      for (let i = 0; i < immutableReferences.length; i++) {
        const variableValue = getEnvVariableValueByToken(
          env,
          immutableReferences[i]
        );
        if (variableValue) {
          env = updateExistingVariableValue(env, variableValue, {
            ...variableValue,
            consumedAtToken,
          });
        }
      }

      /*
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
      */
    }

    // QUESTION: We probably don't need to check this because
    //           we will set all valuesAfter as consumed.
    if (mutableReferences.length > 0) {
      for (let i = 0; i < mutableReferences.length; i++) {
        const variableValue = getEnvVariableValueByToken(
          env,
          mutableReferences[i]
        );
        if (variableValue) {
          // env = deleteEnvVariableValue(env, variableValue);
          env = updateExistingVariableValue(env, variableValue, {
            ...variableValue,
            consumedAtToken,
          });
        }
      }

      /*
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
      */
    }
  }

  const referedVariable = variableValue.referedVariable;
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
  /*if (!isTempVariableName(env, variableName)) */ {
    // FIXME: Check the constraints
    /*
    const { frameLevel, index } = getEnvFrameLevelAndIndexForVariableValue(
      env,
      variableValue
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
    */
    // Set all valuesAfter as consumed, no matter Linar or Free.
    /*
    valuesAfter.forEach((value) => {
      if (
        value.kind === "value" &&
        value.order > variableValue.order &&
        !value.consumedAtToken
      ) {
        env = updateExistingVariableValue(env, value, {
          ...value,
          consumedAtToken,
        });
      }
    });
    */
    // FIXME: ^^^ Set references as consumed
  }

  const newVariableValue: VariableValue = { ...variableValue, consumedAtToken };
  return {
    env: updateExistingVariableValue(env, variableValue, newVariableValue),
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
  const referedVariableValue = referedFrame.values.find(
    (value) => value.variableName === referedVariable.variableName
  );
  if (!referedVariableValue) {
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
  let mutableReferences = referedVariableValue.mutableReferences ?? [];
  let immutableReferences = referedVariableValue.immutableReferences ?? [];
  if (referedVariable.isMutableReference) {
    mutableReferences = mutableReferences.filter(
      (r) => r !== referedVariable.token
    );
  } else {
    immutableReferences = immutableReferences.filter(
      (r) => r !== referedVariable.token
    );
  }

  env = updateExistingVariableValue(env, referedVariableValue, {
    ...referedVariableValue,
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
  const variableValues = getEnvVariableValueByVariableName(env, variableName);
  if (variableValues.length === 0) {
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
  let variableValue = variableValues[variableValues.length - 1];
  if (
    (variableValue.type.kind === "Linear" ||
      variableValue.type.kind === "Type") &&
    variableValue.consumedAtToken
  ) {
    if (isForAssignment) {
      // NOTE: If it's for assignment, then we allow to reuse the consumed variable.
      const newVariableValue: VariableValue = {
        ...variableValue,
        consumedAtToken: undefined,
        token: token,
      };
      env = updateExistingVariableValue(env, variableValue, newVariableValue);
      variableValue = newVariableValue; // <= This is necessary
      resetConsumedVariable = true;
    } else {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: variableValue.consumedAtToken,
            errorMessage: `Variable "${variableName}" is already consumed here:`,
          },
        ],
      });
    }
  }

  const immutableReferences = variableValue.immutableReferences ?? [];
  const mutableReferences = variableValue.mutableReferences ?? [];
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
            token: variableValue.token,
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
            token: variableValue.token,
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
      const newVariableValue: VariableValue = {
        ...variableValue,
        mutableReferences: [...mutableReferences, token],
      };
      return {
        env: updateExistingVariableValue(env, variableValue, newVariableValue),
        referedVariable: {
          variableName,
          frameLevel: variableValue.frameLevel,
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
            token: variableValue.token,
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
      const newVariableValue: VariableValue = {
        ...variableValue,
        immutableReferences: [...immutableReferences, token],
      };
      return {
        env: updateExistingVariableValue(env, variableValue, newVariableValue),
        referedVariable: {
          variableName,
          frameLevel: variableValue.frameLevel,
          isMutableReference,
          token,
        },
        resetConsumedVariable,
      };
    }
  }
}

function setEnvVariableReferedVariable({
  env,
  // variableName,
  variableToken,
  referedVariable,
}: {
  env: Environment;
  variableName: string;
  variableToken: Token;
  referedVariable: ReferedVariable;
}): Environment {
  // Increase the reference count for referedVariable
  const frame = env.frames[referedVariable.frameLevel];
  const referedVariableValue = frame.values.find(
    (value) => value.variableName === referedVariable.variableName
  );
  if (!referedVariableValue) {
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
  const immutableReferences = referedVariableValue.immutableReferences ?? [];
  const mutableReferences = referedVariableValue.mutableReferences ?? [];
  if (referedVariable.isMutableReference) {
    mutableReferences.push(variableToken);
  } else {
    immutableReferences.push(variableToken);
  }
  const newVariableValue: VariableValue = {
    ...referedVariableValue,
    immutableReferences,
    mutableReferences,
  };
  const nextEnv = updateExistingVariableValue(
    env,
    referedVariableValue,
    newVariableValue
  );
  return nextEnv;
  /*
  const newReferedVariable: ReferedVariable = {
    ...referedVariable,
    token: variableToken,
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
          token: variableToken,
          errorMessage: `Failed to find the variable "${variableName}"`,
        },
      ],
    });
  }
  return updateExistingVariableValue(nextEnv, variableValueType, {
    ...variableValueType,
    referedVariable: newReferedVariable,
  });
  */
}

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
  cases: (IfCase | MatchCase)[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tempVariableName: string
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
          const newVariableValue: VariableValue = {
            ...frameValues[i],
            consumedAtToken: tokens[0],
          };
          env = updateExistingVariableValue(
            env,
            frameValues[i],
            newVariableValue
          );
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
        const newVariableValue: VariableValue = {
          ...frameValues[i],
          consumedAtToken: tokens[0],
        };
        env = updateExistingVariableValue(
          env,
          frameValues[i],
          newVariableValue
        );
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

  // FIXME: This part of code is not correct.
  /*
  // Update the tempVariable to host the shortest lifetime
  const tempVariables = getEnvVariableValueByVariableName(
    env,
    tempVariableName
  );
  let tempVariable = tempVariables[0];
  // console.log("tempVariable: ", tempVariable);


  for (let i = 0; i < caseEnvs.length; i++) {
    const caseEnv = caseEnvs[i];
    const caseTempVariables = getEnvVariableValueByVariableName(
      caseEnv,
      tempVariableName
    );
    const caseTempVariable = caseTempVariables[0];
    if (caseTempVariable.referedVariable) {
      if (
        !tempVariable.referedVariable ||
        tempVariable.order < caseTempVariable.order
      ) {
        const newTempVariable: VariableValue = {
          ...tempVariable,
          referedVariable: caseTempVariable.referedVariable,
          order: caseTempVariable.order,
        };
        env = updateExistingVariableValue(env, tempVariable, newTempVariable);
        tempVariable = newTempVariable;
      }
    }
    // console.log("caseTempVariable: ", caseTempVariable);
  }
  */

  return env;
}

function getEnvVariableValueByToken(
  env: Environment,
  token: Token
): VariableValue | null {
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    const variableValue = frame.values.find((value) => value.token === token);
    if (variableValue) {
      return variableValue;
    }
  }
  return null;
}

export function deleteEnvVariableValue(
  env: Environment,
  variableValue: VariableValue
): Environment {
  const frames = env.frames.map((frame) => {
    const values = frame.values.filter((value) => value !== variableValue);
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

export function getEnvFrameLevelAndIndexForVariableValue(
  env: Environment,
  variableValue: VariableValue
): { frameLevel: number; index: number } {
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    const index = frame.values.findIndex((v) => v === variableValue);
    if (index > -1) {
      return { frameLevel: i, index };
    }
  }
  throw new Error("Failed to find the value type in env.");
}

export function getEnvInterfaceById(
  env: Environment,
  interfaceId: string
): TInterface | null {
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    for (let j = 0; j < frame.values.length; j++) {
      const value = frame.values[j];
      if (
        value.kind === "interface" &&
        value.interface &&
        value.interface.interfaceId === interfaceId
      ) {
        return value.interface;
      }
    }
  }
  return null;
}

export function checkIfInterfaceFunctionImplementationExistsInEnv({
  interfaceId,
  interfaceFunction,
  env,
}: {
  interfaceId: string;
  interfaceFunction: TInterfaceFunction;
  env: Environment;
}): boolean {
  const interface_ = getEnvInterfaceById(env, interfaceId);
  if (!interface_) {
    return false;
  }
  const targetInterfaceFunction = interface_.functions.find(
    (f) => f.name === interfaceFunction.name
  );
  if (!targetInterfaceFunction) {
    return false;
  }
  const targetFunctionType = targetInterfaceFunction.func;

  if (
    !targetFunctionType.hasNoImplementation &&
    checkType(targetFunctionType, interfaceFunction.func, env)
  ) {
    return true;
  }

  for (
    let i = 0;
    i < targetFunctionType.interfaceFunctionImplementations.length;
    i++
  ) {
    const implementation =
      targetFunctionType.interfaceFunctionImplementations[i];
    if (checkType(implementation.func, interfaceFunction.func, env)) {
      return true;
    }
  }

  return false;
}
