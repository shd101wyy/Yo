import { formatErrorMessages } from "./error";
import { Token } from "./token";
import {
  areTypesCompatible,
  isDynType,
  isEnumType,
  isFunctionType,
  isLinearOrType0Type,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isStructType,
  isUnionType,
  ModuleType,
  Type,
  typeContainsSomeType,
  typeOfType,
  typeToString,
} from "./types";
import { generateVarialeId, isTempVariableName } from "./utils";
import {
  createUnknownValue,
  isModuleValue,
  isTupleValue,
  isUnknownValue,
  ModuleValue,
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
   * Whether the variable is mutable or not.
   * This affects:
   * - Variable reassignment: x = new_value
   * - Creating mutable references: &!(x), *!(x)
   *
   * Examples:
   * - x := 1         -> isMutable: false
   * - mut(x) := 1    -> isMutable: true
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
   * Then token at which the variable is initialized.
   * If such token exists, then it means the variable is initialized at that point.
   */
  initializedAtToken: Token | undefined;

  /**
   * Check linear type consumption.
   * The token at which the variable is consumed.
   */
  consumedAtToken: Token | undefined;

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
   * At which token the variable is declared.
   */
  token: Token;

  /**
   * This is used to mark variables that are created from destructuring atom variable.
   * eg:
   *
   * Data :: struct(val : &(i32));
   *
   * test :: (fn(d : Data) -> unit) {
   *   { val } := d;
   *   // `val` here is created from destructuring atom variable.
   * };
   */
  isCreatedFromDestructuringAtomVariable?: boolean;
}

export type Frame = {
  variables: Variable[];
  /**
   * The unique identifier of the frame.
   */
  id: string;
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
  allowDuplicate,
  variableId,
  skipCheckingFunctionOverloading,
}: {
  env: Environment;
  variable: Omit<Variable, "id" | "frameLevel">;
  deltaFrame?: number;
  allowDuplicate?: boolean;
  variableId?: string;
  skipCheckingFunctionOverloading?: boolean;
}): { env: Environment; variable: Variable } {
  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);

  // Prevent the function overloading
  if (!skipCheckingFunctionOverloading && isFunctionType(variable.type)) {
    const existingFunctionVariables = getVariablesFromEnv(
      env,
      variable.name,
      (variable) =>
        isFunctionType(variable.type) && variable.frameLevel === frameLevel
    );
    if (existingFunctionVariables.length > 0) {
      throw formatErrorMessages([
        {
          token: variable.token,
          errorMessage: `Failed to define function "${variable.name}" as overloading is not allowed:`,
        },
        {
          token: existingFunctionVariables[0]!.token,
          errorMessage: `Function "${existingFunctionVariables[0]!.name}" is already defined here:`,
        },
      ]);
    }
  }

  const frame = env.frames[frameLevel];
  if (!frame) {
    // print traceback
    console.trace(
      `Frame at level ${frameLevel} does not exist in the environment.`
    );
    throw new Error(
      `Frame at level ${frameLevel} does not exist in the environment.`
    );
  }

  const id = isTempVariableName(env.modulePath, variable.name)
    ? variable.name
    : (variableId ?? generateVarialeId(env.modulePath, variable.name));
  const newVariable: Variable = { ...variable, frameLevel, id };
  const newFrame = addVariableToFrame({
    frame,
    variable: newVariable,
    allowDuplicate,
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
  allowDuplicate,
}: {
  frame: Frame;
  variable: Variable;
  allowDuplicate?: boolean;
}): Frame {
  // Check if variable already exists in the frame
  // If yes, then report an error
  if (
    !allowDuplicate &&
    frame.variables.some((value) => value.name === variable.name)
  ) {
    throw formatErrorMessages([
      {
        token: variable.token,
        errorMessage: `Failed to define variable "${variable.name}":`,
      },
      {
        token: frame.variables.find((value) => value.name === variable.name)!
          .token,
        errorMessage: `Variable "${variable.name}" is already defined here in the same scope:`,
      },
    ]);
  }

  // Check if there is already a value with the same variableName
  // but is uninitialized
  const existingUndefinedVariableIndex = frame.variables.findIndex(
    (value_) => value_.name === variable.name && !value_.initializedAtToken
  );
  if (existingUndefinedVariableIndex > -1) {
    const newVariables = frame.variables.slice();
    newVariables[existingUndefinedVariableIndex] = variable;
    return {
      id: frame.id,
      variables: newVariables,
    };
  }

  if (!allowDuplicate) {
    const existingVariable = frame.variables.find(
      (value) => value.name === variable.name
    );
    if (existingVariable) {
      throw formatErrorMessages([
        {
          token: variable.token,
          errorMessage: `Failed to define variable "${variable.name}":`,
        },
        {
          token: existingVariable.token,
          errorMessage: `Variable "${existingVariable.name}" is already defined here:`,
        },
      ]);
    }
  }

  return {
    id: frame.id,
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
    id: generateVarialeId(env.modulePath, "frame"),
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
    // Check if there is any Linear/Type0 value in the frame that is not consumed or uninitialized.
    const unconsumedVariables = getVariablesNeedingDrop(env);
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
      (variable) => !variable.initializedAtToken
    );
    if (unconsumedVariables.length > 0) {
      throw formatErrorMessages(
        unconsumedVariables.map((variable) => {
          return {
            token: variable.token,
            errorMessage: `Linear variable "${variable.name}" was not consumed. Linear values must be consumed before going out of scope.`,
          };
        })
      );
    } else if (undefinedVariables.length > 0) {
      throw formatErrorMessages(
        undefinedVariables.map((variable) => {
          return {
            token: variable.token,
            errorMessage: `Variable "${variable.name}" is undefined.`,
          };
        })
      );
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
    const variables = frame.variables.map((variable) => {
      // Use ID-based matching instead of object identity to avoid stale reference issues
      if (variable.id === oldVariable.id) {
        return newVariable;
      }
      return variable;
    });
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
        id: variable.id,
        name: variable.name,
        type: typeToString(variable.type),
        typeId: variable.type.id,
        value: valueToString(variable.value),
        isCompileTimeOnly: variable.isCompileTimeOnly,
        isMutable: variable.isMutable,
        isImplicit: variable.isImplicit,
        isUndefined: !variable.initializedAtToken,
        isConsumed: !!variable.consumedAtToken,
      }));
    })
  );
}

/**
 *
 * This is the uniform function call, which only allows calling
 * methods from a module value.
 *
 * @param env
 * @param methodName
 * @param receiverType
 * @param onlyFromTypeMethods
 * @returns
 */
export function getMethodsByNameFromEnv(
  env: Environment,
  methodName: string,
  receiverType: Type,
  onlyFromTypeMethods = false
): { type: Type; value: Value | undefined }[] {
  const methods: { type: Type; value: Value | undefined }[] = [];

  function checkModule(moduleType: ModuleType, moduleValue: Value) {
    // NOTE: We stop checking the moduleReceiverType
    //       It is only used for dynamic dispatching now.
    // const moduleReceiverType = getModuleReceiverType(moduleType);
    // if (!moduleReceiverType) {
    //   // NOTE: We require receiverType to be defined with "This"
    //   return;
    // }

    const method = moduleType.elements.find(
      (element) =>
        element.label === methodName &&
        (isFunctionType(element.type) || isModuleType(element.type))
    );

    if (method) {
      let value: Value | undefined = undefined;
      if (isFunctionType(method.type)) {
        if (isUnknownValue(moduleValue)) {
          value = createUnknownValue(method.type, method.label);
        } else if (isModuleValue(moduleValue)) {
          const index = moduleType.elements.findIndex(
            (element) => element.label === method.label
          );
          value = moduleValue.elements[index];
        }

        methods.push({ type: method.type, value });
      } else if (isModuleType(method.type)) {
        // Find the module value
        const moduleValue_ = method.assignedValue;
        if (isModuleValue(moduleValue_)) {
          checkModuleSelfCall(moduleValue_);
        }
      }
    }
  }

  function checkModuleSelfCall(moduleValue: ModuleValue) {
    const SelfTypeIndex = moduleValue.type.elements.findIndex(
      (element) => element.label === "Self"
    );
    if (SelfTypeIndex >= 0) {
      const SelfType = moduleValue.type.elements[SelfTypeIndex]!;
      if (SelfType.assignedValue) {
        const SelfValue = SelfType.assignedValue;
        if (isTupleValue(SelfValue)) {
          SelfValue.elements.forEach((element) => {
            methods.push({
              type: element.type,
              value: element,
            });
          });
        } else {
          methods.push({
            type: SelfValue.type,
            value: SelfValue,
          });
        }
      }
    }
  }

  function filterMethodsByReceiverType(
    methods: { type: Type; value: Value | undefined }[]
  ): { type: Type; value: Value | undefined }[] {
    return methods.filter((method) => {
      if (isFunctionType(method.type)) {
        // Check if the first parameter is compatible with the receiverType
        return (
          method.type.parameters.length > 0 &&
          (typeContainsSomeType(method.type.parameters[0]!.type) || // Leave it to the later function call checker.
            areTypesCompatible(
              {
                type: method.type.parameters[0]!.type,
                env: method.type.env, // QUESTION: What should be the env here?
              },
              { type: receiverType, env }
            ))
        );
      }
      return true; // QUESTION: How to handle non-function types?
    });
  }

  // Automatically dereference if it's pointer/reference type
  let dereferencedReceiverType = receiverType;
  while (
    isPtrType(dereferencedReceiverType) ||
    isMutPtrType(dereferencedReceiverType) ||
    isRefType(dereferencedReceiverType) ||
    isMutRefType(dereferencedReceiverType)
  ) {
    dereferencedReceiverType = dereferencedReceiverType.type;
  }

  // Check if the dereferencedReceiverType itself has method that can be called
  if (
    isStructType(dereferencedReceiverType) ||
    isEnumType(dereferencedReceiverType) ||
    isUnionType(dereferencedReceiverType)
  ) {
    const method = dereferencedReceiverType.module.elements.find(
      (element) =>
        element.label === methodName &&
        (isFunctionType(element.type) || isModuleType(element.type))
    );
    if (method) {
      let value: Value | undefined = undefined;
      if (isFunctionType(method.type)) {
        value = method.assignedValue;
        if (isUnknownValue(value)) {
          value = createUnknownValue(method.type, method.label);
        }
        methods.push({ type: method.type, value });
      } else if (isModuleType(method.type)) {
        // Find the module value
        const moduleValue = method.assignedValue;
        if (isModuleValue(moduleValue)) {
          checkModuleSelfCall(moduleValue);
        }
      }
    }
  }

  // Check if the dereferencedReceiverType is a DynType
  if (isDynType(dereferencedReceiverType)) {
    // For dynamic dispatch, we need to check all module types in the DynType
    // A method might exist in only some modules, and that's perfectly valid
    for (const moduleType of dereferencedReceiverType.moduleTypes) {
      const method = moduleType.elements.find(
        (element) =>
          element.label === methodName &&
          (isFunctionType(element.type) || isModuleType(element.type))
      );
      if (method && isFunctionType(method.type)) {
        // Check if the receiver type is compatible
        if (
          method.type.parameters.length > 0 &&
          (typeContainsSomeType(method.type.parameters[0]!.type) || // Leave it to the later function call checker.
            areTypesCompatible(
              {
                type: method.type.parameters[0]!.type,
                env: method.type.env,
              },
              { type: receiverType, env }
            ))
        ) {
          // For dynamic dispatch, we create an unknown value since we don't know
          // which concrete implementation will be called at runtime
          const value = createUnknownValue(method.type, method.label);
          methods.push({ type: method.type, value });
        }
        // Don't break - continue checking other modules in case they have different signatures
      }
    }
  }
  // NOTE:
  // Type methods have higher priority than module methods,
  // so we check the module methods only if there are no type methods.
  if (methods.length > 0 || onlyFromTypeMethods) {
    return filterMethodsByReceiverType(methods);
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

  return filterMethodsByReceiverType(methods);
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

    const newVariables = frame.variables.filter((variable) => {
      if (!variable.isCompileTimeOnly) {
        return false;
      } else {
        return true;
      }
    });
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
 * Get all variables in the top frame that need to be consumed (dropped).
 * Returns variables that are Linear or Type0 types, not consumed, and not compile-time only.
 * Variables are returned in reverse order (end to start) for proper drop order.
 */
export function getVariablesNeedingDrop(env: Environment): Variable[] {
  if (env.frames.length === 0) {
    return [];
  }

  const topFrame = env.frames[env.frames.length - 1]!;
  const variables = topFrame.variables.filter(
    (variable) =>
      isLinearOrType0Type(typeOfType(variable.type)) &&
      !variable.consumedAtToken &&
      !variable.isCompileTimeOnly
  );

  // Return in reverse order (end to start) for proper drop order
  return variables.reverse();
}

export function variableExistsInEnvTopFrame(
  env: Environment,
  variableName: string
): boolean {
  if (env.frames.length === 0) {
    return false;
  }
  const topFrame = env.frames[env.frames.length - 1]!;
  return topFrame.variables.some((variable) => variable.name === variableName);
}
