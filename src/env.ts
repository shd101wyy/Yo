import { createHash } from "crypto";
import { formatErrorMessages } from "./error";
import { charIsOperator, Operators, Token } from "./token";
import {
  areTypesCompatible,
  getModuleReceiverType,
  isFunctionType,
  isModuleType,
  ModuleType,
  Type,
  TypeTag,
  typeToString,
} from "./type-checker";
import {
  createUnknownValue,
  isModuleValue,
  isTypeValue,
  isUnknownValue,
  Value,
  valueToString,
} from "./value";

export type ReferedVariable = {
  frameLevel: number;
  variableName: string;
  isMutableReference: boolean;
  /**
   * token where the reference is created
   */
  token: Token;
};

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
   * This is compile-time only value of the variable.
   * Could be not defined if the variable is not initialized.
   */
  value?: Value;
  /**
   * Whether the variabel is mutable or not.
   * Eg:
   * mut(x) := 1;
   * The token `x` has `isMutable` set to true.
   */
  isMutable?: boolean;
  /**
   * Whether the variable is compile-time only or not.
   * Eg:
   * x :: 1;
   */
  isCompileTimeOnly?: boolean;
  /**
   * If the variable is initialized.
   */
  isNotInitialized?: boolean;
  /**
   * Check linear type consumption.
   */
  consumedAtToken?: Token;

  /* This is only used for temp variable, check the
   * tempVariableName of the ReferenceExpr of AstType.Reference
   */
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
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: [
          {
            token: variable.token,
            errorMessage: `Failed to define function "${variable.name}" as overloading is not allowed:`,
          },
          {
            token: existingFunctionVariables[0].token,
            errorMessage: `Function "${existingFunctionVariables[0].name}" is already defined here:`,
          },
        ],
      });
    }
  }

  const frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);
  const frame = env.frames[frameLevel];
  const id = isTempVariableName(env, variable.name)
    ? variable.name
    : (variableId ?? generateVarialeValueId(env, variable.name));
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
  /*
  // Check if the variable has type of SomeType
  if (isTypeHierarchyType(variable.type)) {
    if (variable.value || variable.type.level > 0) {
      // throw formatErrorMessages({
      //   modulePath: env.modulePath,
      //   inputString: env.inputString,
      //   tokenAndErrorList: [
      //     {
      //       token: variable.token,
      //       errorMessage: `Failed to define variable "${variable.name}" for SomeType:`,
      //     },
      //   ],
      // });
    } else {
      const someType: SomeType = {
        tag: TypeTag.SomeType,
        typeId: `sometype_${someIdIndex++}`,
        name: variable.name,
        parentType: variable.type,
        size: undefined,
      };
      variable.value = createTypeValue(someType);
    }
  }
  */

  // Check if there is already a value with the same variableName
  // but is uninitialized
  const existingUninitializedVariableIndex = frame.variables.findIndex(
    (value_) => value_.name === variable.name && value_.isNotInitialized
  );
  if (existingUninitializedVariableIndex > -1) {
    const newVariables = frame.variables.slice();
    newVariables[existingUninitializedVariableIndex] = variable;
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
    const frame = env.frames[i];
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
    const frame = env.frames[i];
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
    const frameToPop = env.frames[env.frames.length - 1];
    // Check if there is any value in the frame that is not consumed or uninitialized
    const unconsumedLinearVariables = frameToPop.variables.filter(
      (variable) =>
        (!variable.value || !isTypeValue(variable.value)) &&
        (variable.type.tag === TypeTag.Linear ||
          variable.type.tag === TypeTag.Free) &&
        !variable.consumedAtToken
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

    const notInitializedVariables = frameToPop.variables.filter(
      (variable) => variable.isNotInitialized
    );
    if (unconsumedLinearVariables.length > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: unconsumedLinearVariables.map((variable) => {
          return {
            token: variable.token,
            errorMessage: `${
              isTempVariableName(env, variable.name) ? "Value" : "Variable"
            } is "Linear" type but is not consumed:
${typeToString(variable.type)}`,
          };
        }),
      });
    } else if (notInitializedVariables.length > 0) {
      throw formatErrorMessages({
        modulePath: env.modulePath,
        inputString: env.inputString,
        tokenAndErrorList: notInitializedVariables.map((value) => {
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

export function printEnvVarNames(env: Environment) {
  console.log(
    env.frames.map((frame) => {
      return frame.variables.map((variable) => ({
        name: variable.name,
        type: typeToString(variable.type),
        value: valueToString(variable.value),
        isCompileTimeOnly: variable.isCompileTimeOnly,
        isMutable: variable.isMutable,
        isNotInitialized: variable.isNotInitialized,
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
    const moduleReceiverType = getModuleReceiverType(moduleType);
    if (!moduleReceiverType) {
      // NOTE: We require receiverType to be defined with "This"
      return;
    }

    const method = moduleType.members.find(
      (member) =>
        areTypesCompatible(moduleReceiverType, receiverType, env) &&
        member.label === methodName &&
        isFunctionType(member.type) &&
        member.type.params.length > 0 &&
        // TODO: support autocast to reference/immutable reference.
        areTypesCompatible(member.type.params[0].type, receiverType, env)
    );
    if (method) {
      let value: Value | undefined = undefined;
      if (isUnknownValue(moduleValue)) {
        value = createUnknownValue(method.type, method.label);
      } else if (isModuleValue(moduleValue)) {
        value = moduleValue.members[method.label];
      }

      methods.push({ type: method.type, value });
    }
  }

  // Check if the receiverType itself has method that can be called
  /*
  if (receiverType.methods) {
    const typeMethods = receiverType.methods.filter(
      (method) =>
        method.label === methodName &&
        !!method.value &&
        isFunctionType(method.type) &&
        method.type.params.length > 0
    );
    for (let i = 0; i < typeMethods.length; i++) {
      const method = typeMethods[i];
      if (!methods.some((m) => m.value === method.value)) {
        methods.push({ type: method.type, value: method.value });
      }
    }
  }
  */

  // Check the modules
  for (let i = env.frames.length - 1; i >= 0; i--) {
    const frame = env.frames[i];
    for (let j = frame.variables.length - 1; j >= 0; j--) {
      const variable = frame.variables[j];
      const moduleType = variable.type;
      const moduleValue = variable.value;
      if (
        // Find the module value
        isModuleType(moduleType) &&
        moduleValue
      ) {
        checkModule(moduleType, moduleValue);
      }
      /*
      else if (
        // Check if it's a function that returns interface, then we check its caches
        isFunctionType(variable.type) &&
        isFunctionValue(variable.value)
      ) {
        const functionValue = variable.value;
        // Check the caches
        for (
          let k = 0;
          k < functionValue.calledTypeFunctionCaches.length;
          k++
        ) {
          const cache = functionValue.calledTypeFunctionCaches[k];
          if (isModuleType(cache.typeValue.value)) {
            const moduleType = cache.typeValue.value;
            checkModuleType(moduleType);
          }
        }
      }
      */
    }
  }

  return methods;
}
