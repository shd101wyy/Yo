import { formatErrorMessages } from "./error";
import { PlaceholderToken, Token } from "./token";
import {
  areTypesCompatible,
  getModuleReceiverType,
  isFunctionType,
  isLinearOrType0Type,
  isModuleType,
  ModuleType,
  Type,
  typeOfType,
  TypeTag,
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
      // RAII
      // check if we can call the `drop: ((self: Self)-> unit)`
      // method on the linear value to consume it.
      // for example:
      //    ptr := malloc();
      //    ptr.drop(); // <= this is the method we are looking for
      const errors: { token: Token; errorMessage: string }[] = [];
      for (let i = unconsumedLinearVariables.length - 1; i >= 0; i--) {
        const variable = unconsumedLinearVariables[i]!;

        // calling drop on it
        env = updateExistingVariable(env, variable, {
          ...variable,
          consumedAtToken: variable.token,
        });

        /*
        const { error, env: nextEnv } = canCallDropMethodOnVariable(
          variable,
          env
        );
        if (error) {
          errors.push(error);
        } else {
          // console.log(`Consumed ${variable.name}`);
          env = nextEnv;
        }
        */
      }

      if (errors.length > 0) {
        throw formatErrorMessages({
          tokenAndErrorList: errors,
        });
      }
    } else if (undefinedVariables.length > 0) {
      throw formatErrorMessages({
        tokenAndErrorList: undefinedVariables.map((variable) => {
          return {
            token: variable.token,
            errorMessage: `Variable "${variable.name}" is undefined.`,
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
  receiverType: Type,
  onlyFromTypeMethods = false
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
  if (receiverType.methods.length > 0) {
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
  // NOTE:
  // Type methods have higher priority than module methods,
  // so we check the module methods only if there are no type methods.
  if (methods.length > 0 || onlyFromTypeMethods) {
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
 * This function will remove all runtime variables from the environment,
 * except for the first (top) frame.
 * @param env Environment
 */
export function keepTopLevelFrameAndComptimeVariablesFromEnv(
  env: Environment
): Environment {
  const newFrames = env.frames.map((frame, index) => {
    if (index === 0) {
      return frame; // Keep the first frame as is
    }

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

/**
 * Check if we can call the `drop` method on the variable.
 * The drop method is used to consume the linear value.
 * It should have signature like this:
 *
 *   (self: Self) -> unit
 *
 * where `Self` is the type of the variable.
 */
export function canCallDropMethodOnVariable(
  variable: Variable,
  env: Environment
): {
  error?: { token: Token; errorMessage: string };
  env: Environment;
} {
  const variableType = variable.type;
  const methods = getMethodsByNameFromEnv(
    env,
    "drop",
    variableType,
    true
  ).filter((method) => {
    return (
      isFunctionType(method.type) &&
      method.type.parameters.length === 1 &&
      method.type.return.type.tag === TypeTag.Unit
    );
  });
  if (methods.length === 0) {
    return {
      error: {
        token: variable.token,
        errorMessage: `${
          isTempVariableName(env.modulePath, variable.name)
            ? "Value"
            : `Variable "${variable.name}"`
        } is "Linear" type but is not consumed.
No "drop" method found for type, so it cannot be consumed automatically:

  ${typeToString(variableType)}`,
      },
      env,
    };
  } else if (methods.length === 1) {
    // QUESTION: Do we really need to perform this action?
    // Update the variable to mark it as consumed
    env = updateExistingVariable(env, variable, {
      ...variable,
      consumedAtToken: PlaceholderToken, // QUESTION: What should be the correct token here
    });

    return { error: undefined, env: env };
  } else {
    return {
      error: {
        token: variable.token,
        errorMessage: `Failed to consume ${
          isTempVariableName(env.modulePath, variable.name)
            ? "Value"
            : `Variable "${variable.name}"`
        }.
Found multiple "drop" methods for type:

  ${typeToString(variable.type)}
  
Please specify the method explicitly.`,
      },
      env: env,
    };
  }
}
