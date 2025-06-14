import { formatErrorMessages } from "./error";
import { Token } from "./token";
import {
  areTypesCompatible,
  getModuleReceiverType,
  isEnumType,
  isFunctionType,
  isLinearOrType0Type,
  isModuleType,
  isStructType,
  isUnionType,
  ModuleType,
  Type,
  typeOfType,
  typeToString,
} from "./type-checker";
import { generateVarialeId, isTempVariableName } from "./utils";
import {
  createUnknownValue,
  isModuleValue,
  isUnknownValue,
  Value,
  valueToString,
} from "./value";

/*
export type ReferedVariable = {
  frameLevel: number;
  variableName: string;
  isMutableReference: boolean;
  //
  // token where the reference is created
  //
  token: Token;
};
*/

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
   * If the `value` is not `undefined`, then it means the variable is compile-time known.
   * Otherwise, it is a runtime variable.
   */
  value?: Value;
  /**
   * Whether the variabel is mutable or not.
   * Eg:
   * mut(x) := 1;
   * The token `x` has `isMutable` set to true.
   */
  isMutable: boolean;
  /**
   * Whether the variable is compile-time only or not.
   * Eg:
   * x :: 1;
   */
  isCompileTimeOnly: boolean;
  /**
   * Whether the variable is implicit or not.
   */
  isImplicit: boolean;
  /**
   * If the variable is initialized.
   */
  isUndefined: boolean;

  /**
   * Check linear type consumption.
   */
  consumedAtToken?: Token;

  /* This is only used for temp variable, check the
   * tempVariableName of the ReferenceExpr of AstType.Reference
   */
  // referedVariable?: ReferedVariable;

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

export function createNewEnv({
  modulePath,
  inputString,
}: {
  modulePath: string;
  inputString: string;
}): Environment {
  return {
    functionDeclarationFrameLevel: -1,
    frames: [],
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
  skipCheckingFunctionOverloading,
}: {
  env: Environment;
  variable: Omit<Variable, "id" | "frameLevel">;
  deltaFrame?: number;
  preventDuplicate?: boolean;
  variableId?: string;
  skipCheckingFunctionOverloading?: boolean;
}): { env: Environment; variable: Variable } {
  // Prevent the function overloading
  if (!skipCheckingFunctionOverloading && isFunctionType(variable.type)) {
    const existingFunctionVariables = getVariablesFromEnv(
      env,
      variable.name,
      (variable) => isFunctionType(variable.type)
    );
    if (existingFunctionVariables.length > 0) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: variable.token,
            errorMessage: `Failed to define function "${variable.name}" as overloading is not allowed:`,
          },
          {
            token: existingFunctionVariables[0]!.token,
            errorMessage: `Function "${existingFunctionVariables[0]!.name}" is already defined here:`,
          },
        ],
      });
    }
  }

  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);
  const frame = env.frames[frameLevel]!;
  const id = isTempVariableName(env.modulePath, variable.name)
    ? variable.name
    : (variableId ?? generateVarialeId(env.modulePath, variable.name));
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

  return { env: newEnv, variable: newVariable };
}

// let someIdIndex = 0;
export function addVariableToFrame({
  frame,
  variable,
  preventDuplicate,
}: {
  env: Environment;
  frame: Frame;
  variable: Variable;
  preventDuplicate?: boolean;
}): Frame {
  // Check if variable already exists in the frame
  // If yes, then report an error
  if (frame.variables.some((value) => value.name === variable.name)) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: variable.token,
          errorMessage: `Failed to define variable "${variable.name}":`,
        },
        {
          token: frame.variables.find((value) => value.name === variable.name)!
            .token,
          errorMessage: `Variable "${variable.name}" is already defined here in the same scope:`,
        },
      ],
    });
  }

  // Check if there is already a value with the same variableName
  // but is uninitialized
  const existingUndefinedVariableIndex = frame.variables.findIndex(
    (value_) => value_.name === variable.name && value_.isUndefined
  );
  if (existingUndefinedVariableIndex > -1) {
    const newVariables = frame.variables.slice();
    newVariables[existingUndefinedVariableIndex] = variable;
    return {
      variables: newVariables,
    };
  }

  if (preventDuplicate) {
    const existingVariable = frame.variables.find(
      (value) => value.name === variable.name
    );
    if (existingVariable) {
      throw formatErrorMessages({
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

export function getVariablesFromFrame(
  frame: Frame,
  variableName: string,
  variableFilter?: (variable: Variable) => boolean
): Variable[] {
  const variables = frame.variables.filter((variable) => {
    return variable.name === variableName;
  });

  if (variableFilter) {
    return variables.filter(variableFilter);
  } else {
    return variables;
  }
}

/**
 * This function will search for the variable in all frames of the env.
 * It will return all variables with the same name.
 * [...old, latest] = getVariablesFromEnv(env, variableName);
 * The latest variable will be the last one in the array.
 * @param env
 * @param variableName
 * @returns
 */
export function getVariablesFromEnv(
  env: Environment,
  variableName: string,
  variableFilter?: (variable: Variable) => boolean
): Variable[] {
  const variables: Variable[] = [];
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i]!;
    const variablesInFrame = getVariablesFromFrame(
      frame,
      variableName,
      variableFilter
    );
    variables.push(...variablesInFrame);
  }

  if (variableFilter) {
    return variables.filter(variableFilter);
  }
  return variables;
}

export function getVariablesFromEnvByFilter(
  env: Environment,
  variableFilter: (variable: Variable) => boolean
): Variable[] {
  const variables: Variable[] = [];
  for (let i = 0; i < env.frames.length; i++) {
    const frame = env.frames[i]!;
    const variablesInFrame = frame.variables.filter(variableFilter);
    variables.push(...variablesInFrame);
  }
  return variables;
}

export function pushEnvFrame(
  env: Environment,
  frame: Frame = {
    variables: [],
  }
): Environment {
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: [...env.frames, frame],
    modulePath: env.modulePath,
    inputString: env.inputString,
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
    const frameToPop = env.frames[env.frames.length - 1]!;
    // Check if there is any value in the frame that is not consumed or uninitialized
    const unconsumedLinearVariables = frameToPop.variables.filter(
      (variable) =>
        isLinearOrType0Type(typeOfType(variable.type)) &&
        !variable.consumedAtToken &&
        !variable.isCompileTimeOnly // We only check for runtime variables
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

    const undefinedVariables = frameToPop.variables.filter(
      (variable) => variable.isUndefined
    );
    if (unconsumedLinearVariables.length > 0) {
      // TODO: Restore the block of the code below
      throw formatErrorMessages({
        tokenAndErrorList: unconsumedLinearVariables.map((variable) => {
          return {
            token: variable.token,
            errorMessage: `${
              isTempVariableName(env.modulePath, variable.name)
                ? "Value"
                : `Variable "${variable.name}"`
            } is "Linear" type but is not consumed:
${typeToString(variable.type)}`,
          };
        }),
      });
    } else if (undefinedVariables.length > 0) {
      throw formatErrorMessages({
        tokenAndErrorList: undefinedVariables.map((value) => {
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

  /*
  TODO: Restore the block of the code below
  const topFrame = env.frames[env.frames.length - 1];
  const references = topFrame.variables.filter((value) =>
    typeIsReference(value.type)
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
  */

  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: env.frames.slice(0, -1),
    modulePath: env.modulePath,
    inputString: env.inputString,
  };
}

export function updateExistingVariable(
  env: Environment,
  oldVariable: Variable,
  newVariable: Variable
): Environment {
  const frames: Frame[] = env.frames.map((frame) => {
    const variables = frame.variables.map((variable) =>
      variable === oldVariable ? newVariable : variable
    );
    return { ...frame, variables };
  });
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames,
    modulePath: env.modulePath,
    inputString: env.inputString,
  };
}

export function setEnvVariableAsConsumed({
  env,
  variableName,
  consumedAtToken,
}: {
  env: Environment;
  variableName: string;
  consumedAtToken: Token;
}): { env: Environment /* referedVariable?: ReferedVariable */ } {
  const variables = getVariablesFromEnv(env, variableName);
  if (variables.length === 0) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: consumedAtToken,
          errorMessage: `Variable ${variableName} is not defined.`,
        },
      ],
    });
  }
  const variable = variables[variables.length - 1]!;

  // Check if it's linear type
  if (isLinearOrType0Type(typeOfType(variable.type))) {
    // Check if the variable is already consumed.
    if (variable.consumedAtToken) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: consumedAtToken,
            errorMessage: `Variable "${variable.name}" is already consumed and cannot be used again.`,
          },
          {
            token: variable.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }
  }

  // const referedVariable = variable.referedVariable;

  const newVariableValue: Variable = { ...variable, consumedAtToken };
  return {
    env: updateExistingVariable(env, variable, newVariableValue),
    // referedVariable,
  };
}

export function printEnvVarNames(env: Environment) {
  console.log(
    env.frames.map((frame) => {
      return frame.variables.map((variable) => ({
        name: variable.name,
        type: typeToString(variable.type),
        value: valueToString(variable.value),
        isCompileTimeOnly: variable.isCompileTimeOnly,
        isMutable: variable.isMutable,
        isImplicit: variable.isImplicit,
        isUndefined: variable.isUndefined,
        isConsumed: !!variable.consumedAtToken,
      }));
    })
  );
}

export function getMethodsByNameFromEnv(
  env: Environment,
  methodName: string,
  receiverType: Type
): { type: Type; value: Value | undefined }[] {
  const methods: { type: Type; value: Value | undefined }[] = [];

  function checkModule(moduleType: ModuleType, moduleValue: Value) {
    const structReceiverType = getModuleReceiverType(moduleType);
    if (!structReceiverType) {
      // NOTE: We require receiverType to be defined with "This"
      return;
    }

    const method = moduleType.elements.find(
      (element) =>
        areTypesCompatible(
          { type: structReceiverType, env },
          { type: receiverType, env }
        ) &&
        element.label === methodName &&
        isFunctionType(element.type) &&
        element.type.parameters.length > 0 &&
        // TODO: support autocast to reference/immutable reference.
        areTypesCompatible(
          { type: element.type.parameters[0]!.type, env },
          { type: receiverType, env }
        )
    );
    if (method) {
      let value: Value | undefined = undefined;
      if (isUnknownValue(moduleValue)) {
        value = createUnknownValue(method.type, method.label);
      } else if (isModuleValue(moduleValue)) {
        const index = moduleType.elements.findIndex(
          (element) => element.label === method.label
        );
        value = moduleValue.elements[index];
      }

      methods.push({ type: method.type, value });
    }
  }

  // Check if the receiverType itself has method that can be called
  if (
    (isStructType(receiverType) ||
      isEnumType(receiverType) ||
      isUnionType(receiverType)) &&
    receiverType.methods.length > 0
  ) {
    const typeMethods = receiverType.methods.filter(
      (method) =>
        method.label === methodName && method.type.parameters.length > 0
    );
    for (let i = 0; i < typeMethods.length; i++) {
      const method = typeMethods[i]!;
      if (!methods.some((m) => m.value === method.value)) {
        methods.push({ type: method.type, value: method.value });
      }
    }
  }
  // Type methods have higher priority than module methods,
  // so we check the module methods only if there are no type methods.
  if (methods.length > 0) {
    return methods;
  }

  // Check the modules
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i]!;
    for (let j = frame.variables.length - 1; j >= 0; j--) {
      const variable = frame.variables[j]!;
      const moduleType = variable.type;
      const moduleValue = variable.value;
      if (
        // Find the module value
        isModuleType(moduleType) &&
        moduleValue
      ) {
        checkModule(moduleType, moduleValue);
      }
    }
  }

  return methods;
}

/**
 * This function will remove all runtime variables from the environment.
 * @param env Environment
 */
export function keepComptimeVariablesFromEnv(env: Environment): Environment {
  const newFrames = env.frames.map((frame) => {
    const newVariables = frame.variables.filter(
      (variable) => variable.isCompileTimeOnly
    );
    return { ...frame, variables: newVariables };
  });

  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: newFrames,
    modulePath: env.modulePath,
    inputString: env.inputString,
  };
}
