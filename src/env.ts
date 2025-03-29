import { createHash } from "crypto";
import { formatErrorMessages } from "./error";
import { charIsOperator, Operators, Token } from "./token";
import { Type } from "./type-checker";
import { Value } from "./value";

export interface Variable {
  /**
   * Unique identifier of the variable.
   */
  id: string;
  /**
   * The name of the variable.
   */
  name: string;
  /**
   * The type of the variable.
   */
  type: Type;
  /**
   * The value of the variable.
   * Could be not defined if the variable is not initialized.
   */
  value?: Value;
  /**
   * If the variable is mutable.
   */
  isMutable?: boolean;
  /**
   * If the variable is initialized.
   */
  isNotInitialized?: boolean;
  /**
   * Check linear type consumption.
   */
  consumedAtToken?: Token;
  /**
   * frameLevel is the level of the frame where the value is defined.
   * It's zero-based.
   */
  frameLevel: number;
  /**
   * At which token the variable is defined.
   */
  token: Token;
}

export type Frame = {
  variables: Variable[];
};

export type Environment = {
  functionDeclarationFrameLevel: number;
  freeVariables: Variable[];
  frames: Frame[];
  modulePath: string;
  inputString: string;
};

export function generateModuleId(modulePath: string) {
  const hash = createHash("sha1").update(modulePath).digest("hex");
  return "mo" + hash.slice(0, 8);
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
        variables: [],
      },
    ],
    freeVariables: [],
    modulePath,
    inputString,
  };
}

export function addVariableToEnv({
  env,
  variable,
  deltaFrame,
  preventDuplicate,
  variableId,
}: {
  env: Environment;
  variable: Omit<Variable, "id" | "frameLevel">;
  deltaFrame?: number;
  preventDuplicate?: boolean;
  variableId?: string;
}): { env: Environment; value: Variable } {
  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);
  const frame = env.frames[frameLevel];
  const id = isTempVariableName(env, variable.name)
    ? variable.name
    : variableId ?? generateVarialeValueId(env, variable.name);
  const newVariable: Variable = { ...variable, frameLevel, id };
  const newFrame = addVariableToFrame({
    env,
    frame,
    variable: newVariable,
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
  };
  return { env: newEnv, value: newVariable };
}

function addVariableToFrame({
  env,
  frame,
  variable,
  preventDuplicate,
}: {
  env: Environment;
  frame: Frame;
  variable: Variable;
  preventDuplicate?: boolean;
}): Frame {
  // Check if there is already a value with the same variableName
  // but is uninitialized
  const existingVariableIndex = frame.variables.findIndex(
    (value_) => value_.name === variable.name && value_.isNotInitialized
  );
  if (existingVariableIndex > -1) {
    const newVariables = frame.variables.slice();
    newVariables[existingVariableIndex] = variable;
    return {
      variables: newVariables,
    };
  } else {
    if (preventDuplicate) {
      const existingVariable = frame.variables.find(
        (value) => value.name === variable.name
      );
      if (existingVariable) {
        throw formatErrorMessages({
          modulePath: env.modulePath,
          inputString: env.inputString,
          tokenAndErrorList: [
            {
              token: variable.token,
              errorMessage: `Failed to define variable "${variable.name}":`,
            },
            {
              token: existingVariable.token,
              errorMessage: `Variable "${existingVariable.name}" is already defined here:`,
            },
          ],
        });
      }
    }

    return {
      variables: [...frame.variables, variable],
    };
  }
}

export function getVariableFromFrame(
  frame: Frame,
  variableName: string
): Variable[] {
  return frame.variables.filter((variable) => {
    variable.name === variableName;
  });
}

export function getVariableFromEnv(
  env: Environment,
  variableName: string
): Variable[] {
  const variables: Variable[] = [];
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i];
    const variablesInFrame = getVariableFromFrame(frame, variableName);
    variables.push(...variablesInFrame);
  }
  return variables;
}
