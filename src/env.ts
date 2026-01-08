import { formatErrorMessages } from "./error";
import { findMethodsFromGenericImpls } from "./evaluator/values/module";
import { Token } from "./token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  FunctionType,
  isComptFloatType,
  isComptIntType,
  isComptStringType,
  isDynType,
  isFunctionType,
  isModuleType,
  isObjectType,
  isPtrType,
  isSomeType,
  ModuleType,
  Type,
  typeContainsRcType,
  typeContainsSelfTypeForDynamicDispatchCheck,
  typeContainsSomeType,
  typeImplementsFuture,
  typeToString,
} from "./types";
import { generateVarialeId, isTempVariableName } from "./utils";
import {
  createUnknownValue,
  isFunctionValue,
  isModuleValue,
  isTupleValue,
  isTypeValue,
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
   * Whether the variable is compile-time only or not.
   * Eg:
   * x :: 1;
   */
  isCompileTimeOnly: boolean;

  /**
   * Whether the variable is holding the Rc value or borrowing the Rc value.
   * This is only relevant for types that are managed by Rc.
   * If the value is not Rc managed, then it should be 'false'
   *
   * Under the new simplified ownership model:
   * - Variables created by := or = always own (isOwningTheRcValue: true)
   * - Function parameters borrow by default (isOwningTheRcValue: false)
   * - Function parameters with own() explicitly own (isOwningTheRcValue: true)
   * - For non-Rc types, this is always false (no ownership tracking needed)
   */
  isOwningTheRcValue: boolean;

  /**
   * Tracks when this variable owns a share of the same Rc object as another variable.
   * This is used for dup/drop optimization across variable reassignments.
   *
   * When a temp variable is created to hold the old value during reassignment:
   * - The temp variable's `isOwningTheSameRcValueAs` points to the original variable
   * - This allows us to optimize away `dup(original) + drop(temp)` pairs
   *
   * Example:
   * ```yo
   * x := MyBox(42);
   * y := x;              // y dups x, both hold shares of MyBox(42)
   * x = MyBox(100);      // temp := x; x = MyBox(100); drop(temp)
   * ```
   *
   * Here, `temp` would have `isOwningTheSameRcValueAs = y` because both own
   * shares of the same MyBox(42). We can then optimize away `dup(y) + drop(temp)`.
   */
  isOwningTheSameRcValueAs?: Variable;

  /**
   * Whether this variable is isReassignable or not.
   * For example, the function parameter is not reassignable.
   */
  isReassignable?: boolean;

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

  /**
   * When an anonymous function parameter has a different name than the expected
   * interface parameter, this field stores the expected name for C codegen.
   *
   * Example:
   * ```yo
   * Id :: module(id : (fn(self : Self) -> Self));
   * impl(Box(i32), Id(
   *   id : ((self2) -> { return self2; })
   * ));
   * ```
   *
   * Here, `self2` is the anonymous function parameter name, but the interface
   * expects `self`. So `parameterAlias` would be "self" for the `self2` variable.
   * In C codegen, we use `self` in the function signature but reference `self2` in the body.
   */
  parameterAlias?: string;
}

export type Frame = {
  variables: Variable[];
  /**
   * The unique identifier of the frame.
   */
  id: string;
  /**
   * Whether this frame was created from a begin block.
   * Temp variables created during evaluation should be added to the nearest
   * begin block frame, not the current top frame (which might be a function call frame).
   */
  isBeginBlockFrame: boolean;
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

export function createEmptyEnv(): Environment {
  const env = createNewEnv({ modulePath: "", inputString: "" });
  return pushEnvFrame(env);
}

let _envContainingPrelude: Environment | null = null;
export function setEnvContainingPrelude(env: Environment) {
  _envContainingPrelude = env;
}
export function clearEnvContainingPrelude() {
  _envContainingPrelude = null;
}
export function createEnvContainingPrelude(): Environment {
  if (!_envContainingPrelude) {
    throw new Error("Environment containing prelude is not set.");
  }
  return _envContainingPrelude;
}
export function isEvaluatingPreludeModule(): boolean {
  return _envContainingPrelude === null;
}

/**
 * This is the special variable name that allows variable shadowing.
 */
export const YoSelf = "__yo_self";

export function addVariableToEnv({
  env,
  variable,
  deltaFrame,
  variableId,
  addToBeginBlockFrame,
  allowVariableShadowing,
}: {
  env: Environment;
  variable: Omit<Variable, "id" | "frameLevel">;
  deltaFrame?: number;
  variableId?: string;
  /**
   * If true, variable will be added to a nearest begin block frame
   * instead of top frame. This is used for temp variables that hold
   * intermediate results - they should be tracked at begin block level
   * so they get dropped when begin block ends, not when a nested
   * function call frame is popped.
   */
  addToBeginBlockFrame?: boolean;
  /**
   * If true, allow this variable to shadow a variable with the same name in an outer scope.
   * This is used for type parameters in function signatures, which can be shadowed in nested functions.
   */
  allowVariableShadowing?: boolean;
}): { env: Environment; variable: Variable } {
  let frameLevel = env.frames.length - 1 + (deltaFrame ?? 0);

  // If addToBeginBlockFrame is true, find the nearest begin block frame
  if (addToBeginBlockFrame) {
    const beginBlockFrameLevel = findNearestBeginBlockFrameLevel(env);
    if (beginBlockFrameLevel >= 0) {
      frameLevel = beginBlockFrameLevel;
    }
    // If no begin block frame found, fall back to top frame
  }

  // Prevent variable shadowing across all scopes
  // Variables with the same name cannot exist in different frames
  // EXCEPT: When allowVariableShadowing is true (for function type parameters)
  if (variable.name !== YoSelf) {
    const existingVariables = getVariablesFromEnv(env, variable.name);
    if (existingVariables.length > 0 && !allowVariableShadowing) {
      const existingVariable = existingVariables[existingVariables.length - 1]!;
      // console.trace("Variable shadowing detected:");
      throw formatErrorMessages([
        {
          token: variable.token,
          errorMessage: `Failed to define variable "${variable.name}":`,
        },
        {
          token: existingVariable.token,
          errorMessage: `Variable "${variable.name}" is already defined here (variable shadowing is not allowed):`,
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
}: {
  frame: Frame;
  variable: Variable;
}): Frame {
  // Check if variable already exists in the frame
  // If yes, then report an error
  if (frame.variables.some((value) => value.name === variable.name)) {
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
      isBeginBlockFrame: frame.isBeginBlockFrame,
    };
  }

  return {
    id: frame.id,
    variables: [...frame.variables, variable],
    isBeginBlockFrame: frame.isBeginBlockFrame,
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
    isBeginBlockFrame: false,
  },
  isBeginBlockFrame?: boolean
): Environment {
  const newFrame: Frame = isBeginBlockFrame
    ? { ...frame, isBeginBlockFrame: true }
    : frame;
  return {
    functionDeclarationFrameLevel: env.functionDeclarationFrameLevel,
    freeVariables: env.freeVariables,
    frames: [...env.frames, newFrame],
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

    const undefinedVariables = frameToPop.variables.filter(
      (variable) => !variable.initializedAtToken
    );
    if (unconsumedVariables.length > 0) {
      throw formatErrorMessages(
        unconsumedVariables.map((variable) => {
          return {
            token: variable.token,
            errorMessage: `Variable "${variable.name}" was not consumed. It is supposed to be consumed before going out of scope.
Typeof "${variable.name}": ${typeToString(variable.type)}`,
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
    }
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
      return frame.variables.map(getVariableInfo);
    })
  );
}

export function printEnvFrame(frame: Frame) {
  console.log(frame.variables.map(getVariableInfo));
}

export function getVariableInfo(variable: Variable) {
  return {
    id: variable.id,
    name: variable.name,
    type: typeToString(variable.type),
    typeId: variable.type.id,
    value: valueToString(variable.value),
    isCompileTimeOnly: variable.isCompileTimeOnly,
    isUndefined: !variable.initializedAtToken,
    isOwningTheRcValue: !!variable.isOwningTheRcValue,
    isOwningTheSameRcValueAs: variable.isOwningTheSameRcValueAs?.name,
    isReassignable: !!variable.isReassignable,
    isConsumed: !!variable.consumedAtToken,
  };
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
  isInfixOperatorCall = false,
  currentFunctionType?: FunctionType
): {
  type: Type;
  value: Value | undefined;
  needsPointerConversion?: boolean;
}[] {
  const methods: {
    type: Type;
    value: Value | undefined;
    needsPointerConversion?: boolean;
  }[] = [];

  // Automatically dereference if it's pointer/reference type
  let dereferencedReceiverType = receiverType;
  while (isPtrType(dereferencedReceiverType)) {
    dereferencedReceiverType = dereferencedReceiverType.childType;
  }

  function checkModule(moduleType: ModuleType, moduleValue: Value) {
    /*
    // NOTE: No need to do the check anymore, since we now only allow method call from type method
    // Check if the module receiverType compatible with receiverType
    if (isModuleValue(moduleValue)) {
      const moduleReceiverType = moduleType.receiverType;
      if (moduleReceiverType) {
        if (
          !areTypesCompatible(
            { type: moduleReceiverType, env: moduleValue.type.env },
            { type: receiverType, env },
            true // isMethodReceiver
          )
        ) {
          if (dereferencedReceiverType === receiverType) {
            return;
          } else {
            // Continue checking with the dereferencedReceiverType
            if (
              !areTypesCompatible(
                { type: moduleReceiverType, env: moduleValue.type.env },
                { type: dereferencedReceiverType, env },
                true // isMethodReceiver
              )
            ) {
              return;
            }
          }
        }
      }
    }
    */

    const method = moduleType.fields.find(
      (field) =>
        field.label === methodName &&
        (isFunctionType(field.type) || isModuleType(field.type))
    );

    if (method) {
      let value: Value | undefined = undefined;
      if (isFunctionType(method.type)) {
        if (isUnknownValue(moduleValue)) {
          value = createUnknownValue(method.type, method.label);
        } else if (isModuleValue(moduleValue)) {
          const index = moduleType.fields.findIndex(
            (field) => field.label === method.label
          );
          value = moduleValue.fields[index];
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

    // If method not found directly, search in nested modules
    if (!method) {
      for (const field of moduleType.fields) {
        if (isModuleType(field.type) && field.assignedValue) {
          // Recursively check nested modules
          checkModule(field.type, field.assignedValue);
        }
      }
    }
  }

  function checkModuleSelfCall(moduleValue: ModuleValue) {
    const selfTypeIndex = moduleValue.type.fields.findIndex(
      (field) => field.label === "Call"
    );
    if (selfTypeIndex >= 0) {
      const selfType = moduleValue.type.fields[selfTypeIndex]!;
      if (selfType.assignedValue) {
        const selfValue = selfType.assignedValue;
        if (isTupleValue(selfValue)) {
          selfValue.fields.forEach((field) => {
            methods.push({
              type: field.type,
              value: field,
            });
          });
        } else {
          methods.push({
            type: selfValue.type,
            value: selfValue,
          });
        }
      }
    }
  }

  function filterMethodsByReceiverType(
    methods: {
      type: Type;
      value: Value | undefined;
      needsPointerConversion?: boolean;
    }[]
  ): {
    type: Type;
    value: Value | undefined;
    needsPointerConversion?: boolean;
  }[] {
    const filtered = methods.filter((method) => {
      if (isFunctionType(method.type)) {
        if (method.type.parameters.length === 0) {
          return false; // Methods must have at least one parameter (receiver)
        }
        const methodFirstParamType = method.type.parameters[0]!.type;

        // CRITICAL: Check pointer conversion BEFORE checking SomeType
        // Because Self types are represented as SomeType, and *(Self) would contain SomeType,
        // we need to handle pointer conversion first
        if (!isInfixOperatorCall && isPtrType(methodFirstParamType)) {
          const methodPtrChildType = methodFirstParamType.childType;
          const receiverCompatibleWithPtrChild = areTypesCompatible(
            {
              type: methodPtrChildType,
              env: method.type.env,
            },
            { type: receiverType, env },
            true // isMethodReceiver
          );

          if (receiverCompatibleWithPtrChild) {
            // Mark this method as needing pointer conversion
            method.needsPointerConversion = true;
            return true;
          }
        }

        if (typeContainsSomeType(methodFirstParamType)) {
          // Leave it to the later function call checker.
          return true;
        }

        // If only method has SomeType but receiver doesn't
        if (
          typeContainsSomeType(methodFirstParamType) &&
          !typeContainsSomeType(receiverType)
        ) {
          return true;
        }

        // Special case: if receiverType is a SomeType with resolvedConcreteType,
        // and the method's first parameter matches the resolvedConcreteType,
        // accept it (e.g., ___drop from capture struct for NON-Future value types).
        // EXCEPTION: For Future types, do NOT accept methods from resolvedConcreteType,
        // because Futures are heap-backed ref-counted and use SomeType's own ARC methods.
        if (
          isSomeType(receiverType) &&
          receiverType.resolvedConcreteType &&
          !typeImplementsFuture(receiverType) &&
          !typeContainsSomeType(methodFirstParamType) &&
          areTypesCompatible(
            {
              type: methodFirstParamType,
              env: method.type.env,
            },
            { type: receiverType.resolvedConcreteType, env },
            true // isMethodReceiver
          )
        ) {
          return true;
        }

        // If only receiver has SomeType, but method doesn't
        if (
          !typeContainsSomeType(methodFirstParamType) &&
          typeContainsSomeType(receiverType)
        ) {
          return false;
        }

        // Special case: compt types (compt_int, compt_float, compt_string) can call
        // methods from their runtime type equivalents (i32, f64, [u8])
        if (
          isComptIntType(receiverType) ||
          isComptFloatType(receiverType) ||
          isComptStringType(receiverType)
        ) {
          const runtimeReceiverType = convertComptTypeToRuntimeType({
            type: receiverType,
            expectedType: undefined,
            expr: undefined,
            env,
          });
          const isRuntimeCompatible = areTypesCompatible(
            { type: methodFirstParamType, env: method.type.env },
            { type: runtimeReceiverType, env },
            true // isMethodReceiver
          );
          if (isRuntimeCompatible) {
            return true;
          }
        }

        // Check if it's a valid dyn type method call
        if (isDynType(receiverType)) {
          // Dyn has two kinds of callable methods:
          // 1) Dyn wrapper's own module methods (e.g., ___dup/___drop) which have concrete values.
          //    These are NOT dynamically dispatched to the wrapped object, so they may return Self.
          // 2) Wrapped object methods invoked via dynamic dispatch (value is undefined here).
          //    These must be object-safe (e.g., must not return Self).
          if (method.value !== undefined) {
            // Skip dynamic-dispatch object-safety restrictions for dyn wrapper methods.
          } else {
            // Check 1: Self parameter must be by reference (&Self or &mut Self), not by value
            if (method.type.parameters.length > 0 && method.type.SelfType) {
              const selfParam = method.type.parameters[0];
              if (selfParam) {
                const selfParamType = selfParam.type;
                // Self parameter must be a pointer type
                if (
                  !isObjectType(selfParamType) &&
                  !isDynType(selfParamType) &&
                  !isPtrType(selfParamType)
                ) {
                  return false;
                }
              }
            }

            // Check 2: Return type must not contain Self
            const returnType = method.type.return.type;
            if (
              typeContainsSelfTypeForDynamicDispatchCheck(
                returnType,
                method.type.SelfType
              )
            ) {
              return false;
            }
          }
        }

        // Check normal compatibility
        const isCompatible = areTypesCompatible(
          {
            type: methodFirstParamType,
            env: method.type.env,
          },
          { type: receiverType, env },
          true // isMethodReceiver
        );

        return isCompatible;
      }
      return true; // QUESTION: How to handle non-function types?
    });

    return filtered;
  }

  // Helper function to recursively check a module for methods
  function checkModuleForMethod(
    moduleType: ModuleType,
    methodName: string,
    visitedModules: Set<string> = new Set()
  ): void {
    // Prevent infinite recursion for circular module references
    if (visitedModules.has(moduleType.id)) {
      return;
    }
    visitedModules.add(moduleType.id);

    // First, check direct methods in this module
    const directMethod = moduleType.fields.find(
      (field) => field.label === methodName && isFunctionType(field.type)
    );

    if (directMethod && isFunctionType(directMethod.type)) {
      let value: Value | undefined = directMethod.assignedValue;
      if (isUnknownValue(value)) {
        value = createUnknownValue(directMethod.type, directMethod.label);
      }
      methods.push({ type: directMethod.type, value });
      return; // Found the method, no need to search nested modules
    }

    // If not found, recursively check nested modules
    for (const field of moduleType.fields) {
      if (isModuleType(field.type) && field.assignedValue) {
        // We need to use checkModule here to properly handle the module value
        // which might contain the actual function values
        checkModule(field.type, field.assignedValue);
      }
    }
  }

  // Check if th receiverType itself has method that can be called
  if (receiverType !== dereferencedReceiverType && receiverType.module) {
    // First check direct methods
    const directMethod = receiverType.module.fields.find(
      (field) => field.label === methodName && isFunctionType(field.type)
    );

    if (directMethod && isFunctionType(directMethod.type)) {
      let value: Value | undefined = directMethod.assignedValue;
      if (isUnknownValue(value)) {
        value = createUnknownValue(directMethod.type, directMethod.label);
      }
      methods.push({ type: directMethod.type, value });
    } else {
      // If no direct method found, recursively check nested modules
      checkModuleForMethod(receiverType.module, methodName);
    }
  }

  // Check generic impl registry for the original receiver type (e.g., *(i32))
  // This is needed for impls like `impl(forall(T : Type), *(T), Add(...))`
  if (methods.length === 0 && receiverType !== dereferencedReceiverType) {
    const genericMethods = findMethodsFromGenericImpls({
      concreteType: receiverType,
      methodName,
      env,
    });
    methods.push(...genericMethods);
  }

  // Check if the dereferencedReceiverType itself has method that can be called
  // NOTE: Skip DynType here since DynType has specialized handling below
  // NOTE: Skip SomeType with resolvedConcreteType since it has specialized handling below
  // EXCEPTION: For Future types, DO check SomeType's module methods (they use __yo_sometype_drop)
  const skipSomeTypeWithResolvedConcreteType =
    isSomeType(dereferencedReceiverType) &&
    dereferencedReceiverType.resolvedConcreteType &&
    !typeImplementsFuture(dereferencedReceiverType);
  if (
    dereferencedReceiverType.module &&
    !isDynType(dereferencedReceiverType) &&
    !skipSomeTypeWithResolvedConcreteType
  ) {
    // First check direct methods
    const directMethod = dereferencedReceiverType.module.fields.find(
      (field) => field.label === methodName && isFunctionType(field.type)
    );

    if (directMethod && isFunctionType(directMethod.type)) {
      let value: Value | undefined = directMethod.assignedValue;
      if (isUnknownValue(value)) {
        value = createUnknownValue(directMethod.type, directMethod.label);
      }
      methods.push({ type: directMethod.type, value });
    } else {
      // If no direct method found, recursively check nested modules
      checkModuleForMethod(dereferencedReceiverType.module, methodName);
    }

    // If no methods found yet, check for impl'd modules (stored with empty label as ModuleValue)
    // Type methods have higher priority than impl'd module methods
    if (methods.length === 0) {
      for (const field of dereferencedReceiverType.module.fields) {
        if (
          field.label === "" &&
          field.assignedValue &&
          isModuleValue(field.assignedValue)
        ) {
          const implModuleValue = field.assignedValue;
          const implModuleType = implModuleValue.type;
          // Search for the method in the impl'd module
          const methodIndex = implModuleType.fields.findIndex(
            (f) => f.label === methodName && isFunctionType(f.type)
          );
          if (methodIndex >= 0) {
            const method = implModuleType.fields[methodIndex]!;
            if (isFunctionType(method.type)) {
              // Get the actual function value from the module value
              const value = implModuleValue.fields[methodIndex];
              // Use the function value's specialized type if available,
              // as it has Self replaced with the concrete receiver type
              let methodType = method.type;
              if (isFunctionValue(value) && value.specializedType) {
                methodType = value.specializedType;
              }
              methods.push({ type: methodType, value });
            }
          }
        }
      }
    }

    // If still no methods found, check generic impl registry
    if (methods.length === 0) {
      const genericMethods = findMethodsFromGenericImpls({
        concreteType: dereferencedReceiverType,
        methodName,
        env,
      });
      methods.push(...genericMethods);
    }
  }

  // If no methods found and receiver is a compt type, also check the runtime type's module
  // because compt literals should be able to call methods from their runtime equivalents
  if (
    methods.length === 0 &&
    (isComptIntType(dereferencedReceiverType) ||
      isComptFloatType(dereferencedReceiverType) ||
      isComptStringType(dereferencedReceiverType))
  ) {
    const runtimeType = convertComptTypeToRuntimeType({
      type: dereferencedReceiverType,
      expectedType: undefined,
      expr: undefined,
      env,
    });
    if (runtimeType.module) {
      for (const field of runtimeType.module.fields) {
        if (
          field.label === "" &&
          field.assignedValue &&
          isModuleValue(field.assignedValue)
        ) {
          const implModuleValue = field.assignedValue;
          const implModuleType = implModuleValue.type;
          const methodIndex = implModuleType.fields.findIndex(
            (f) => f.label === methodName && isFunctionType(f.type)
          );
          if (methodIndex >= 0) {
            const method = implModuleType.fields[methodIndex]!;
            if (isFunctionType(method.type)) {
              const value = implModuleValue.fields[methodIndex];
              let methodType = method.type;
              if (isFunctionValue(value) && value.specializedType) {
                methodType = value.specializedType;
              }
              methods.push({ type: methodType, value });
            }
          }
        }
      }
    }
  }

  // Check if the dereferencedReceiverType is a SomeType with required modules
  if (isSomeType(dereferencedReceiverType)) {
    // If SomeType has resolvedConcreteType, prefer resolving methods against the concrete type's
    // impl modules (static dispatch). This is used for `fn() -> Impl(Module)` return values.
    // EXCEPTION: For Future types, do NOT use resolvedConcreteType methods.
    if (
      dereferencedReceiverType.resolvedConcreteType?.module &&
      !typeImplementsFuture(dereferencedReceiverType)
    ) {
      const concreteType = dereferencedReceiverType.resolvedConcreteType;
      const concreteModule = concreteType.module;

      // 1) Direct methods on the concrete type
      const directConcreteMethod = concreteModule?.fields.find(
        (f) => f.label === methodName && isFunctionType(f.type)
      );
      if (directConcreteMethod && isFunctionType(directConcreteMethod.type)) {
        const value =
          directConcreteMethod.assignedValue ||
          createUnknownValue(
            directConcreteMethod.type,
            directConcreteMethod.label
          );
        methods.push({ type: directConcreteMethod.type, value });
      }

      // 2) Impl module methods stored as ModuleValue with empty label ""
      // This is where `impl(concreteType, Module(...))` attaches concrete method bodies.
      if (methods.length === 0) {
        for (const field of concreteModule?.fields ?? []) {
          if (
            field.label === "" &&
            field.assignedValue &&
            isModuleValue(field.assignedValue)
          ) {
            const implModuleValue = field.assignedValue;
            const implModuleType = implModuleValue.type;
            const methodIndex = implModuleType.fields.findIndex(
              (f) => f.label === methodName && isFunctionType(f.type)
            );
            if (methodIndex >= 0) {
              const method = implModuleType.fields[methodIndex]!;
              if (isFunctionType(method.type)) {
                const value = implModuleValue.fields[methodIndex];
                let methodType = method.type;
                if (isFunctionValue(value) && value.specializedType) {
                  methodType = value.specializedType;
                }
                methods.push({ type: methodType, value });
                break;
              }
            }
          }
        }
      }

      // 3) Generic impl registry for the concrete type
      if (methods.length === 0) {
        const genericMethods = findMethodsFromGenericImpls({
          concreteType,
          methodName,
          env,
        });
        methods.push(...genericMethods);
      }
    }

    // Look for methods in the requiredModules array (from Impl(Module1, Module2, ...))
    // This handles cases like `Impl(Id)` where we need to find the `id` method
    if (methods.length === 0 && dereferencedReceiverType.requiredModules) {
      for (const requiredModuleType of dereferencedReceiverType.requiredModules) {
        // Search for the method in the required module
        const method = requiredModuleType.fields.find(
          (f) => f.label === methodName && isFunctionType(f.type)
        );
        if (method && isFunctionType(method.type)) {
          // Create a specialized method type with SelfType set to the receiver type
          // This allows `Self` in the method signature to resolve to `Impl(Id)`
          const specializedMethodType: FunctionType = {
            ...method.type,
            SelfType: dereferencedReceiverType,
          };

          // Create an unknown value since the actual implementation is not known
          // The actual dispatch will happen at runtime based on the concrete type
          const value = createUnknownValue(specializedMethodType, method.label);
          methods.push({ type: specializedMethodType, value });
        }
      }
    }

    // Look for methods in function-scoped where clause constraints
    // This checks currentFunctionType.whereClauseConstraints for the SomeType
    // Also checks parent function types (for nested functions like methods inside generic types)
    if (methods.length === 0) {
      // Helper function to find constraints from a function type
      const findConstraintsInFunction = (
        funcType: FunctionType | undefined
      ): { requiredModules: ModuleType[] } | undefined => {
        if (!funcType?.whereClauseConstraints) return undefined;

        // First try direct lookup
        let constraints = funcType.whereClauseConstraints.get(
          dereferencedReceiverType
        );

        // If direct lookup fails and receiver is a SomeType, try to find a compatible
        // constrained type parameter. This handles cases like:
        //   - where(T <: Eq(T)) in has method
        //   - current_opt.value has type X (from Node(X))
        //   - X should match T because they're unified type parameters
        if (!constraints && isSomeType(dereferencedReceiverType)) {
          for (const [
            constrainedType,
            typeConstraints,
          ] of funcType.whereClauseConstraints) {
            if (
              isSomeType(constrainedType) &&
              areTypesCompatible(
                { type: constrainedType, env },
                { type: dereferencedReceiverType, env },
                false // Allow type parameter unification
              )
            ) {
              constraints = typeConstraints;
              break;
            }
          }
        }

        return constraints;
      };

      // Check current function and all parent functions in the chain
      let funcToCheck: FunctionType | undefined = currentFunctionType;
      while (funcToCheck && methods.length === 0) {
        const constraints = findConstraintsInFunction(funcToCheck);
        if (constraints) {
          for (const requiredModuleType of constraints.requiredModules) {
            // Search for the method in the required module
            const method = requiredModuleType.fields.find(
              (f) => f.label === methodName && isFunctionType(f.type)
            );
            if (method && isFunctionType(method.type)) {
              // Create a specialized method type with SelfType set to the receiver type
              const specializedMethodType: FunctionType = {
                ...method.type,
                SelfType: dereferencedReceiverType,
              };
              // Create an unknown value since the actual implementation is not known
              const value = createUnknownValue(
                specializedMethodType,
                method.label
              );
              methods.push({ type: specializedMethodType, value });
            }
          }
        }
        // Move to parent function
        funcToCheck = funcToCheck.ParentFunctionType;
      }
    }

    // Look for methods in the required modules stored in the SomeType's module
    // Only consider modules with empty label "" (from module-level where clauses)
    if (methods.length === 0) {
      for (const field of dereferencedReceiverType.module.fields) {
        // Required modules are stored as TypeValue containing ModuleType
        // Only allow modules with empty label (where clause constraints)
        if (
          field.label === "" &&
          field.assignedValue &&
          isTypeValue(field.assignedValue) &&
          isModuleType(field.assignedValue.value)
        ) {
          const requiredModuleType = field.assignedValue.value;
          // Search for the method in the required module
          const method = requiredModuleType.fields.find(
            (f) => f.label === methodName && isFunctionType(f.type)
          );
          if (method && isFunctionType(method.type)) {
            // Create an unknown value since the actual implementation is not known
            const value = createUnknownValue(method.type, method.label);
            methods.push({ type: method.type, value });
          }
        }
      }
    }
  }

  // Check if the dereferencedReceiverType is a DynType
  if (isDynType(dereferencedReceiverType)) {
    // First, check the dyn object's own module for its Rc methods (___drop, ___dup, ___dispose)
    const dynMethod = dereferencedReceiverType.module.fields.find(
      (field) =>
        field.label === methodName &&
        (isFunctionType(field.type) || isModuleType(field.type))
    );
    if (dynMethod && isFunctionType(dynMethod.type)) {
      // For dyn object's own methods, we can use the assigned value directly
      const value =
        dynMethod.assignedValue ||
        createUnknownValue(dynMethod.type, dynMethod.label);
      methods.push({ type: dynMethod.type, value });
    }

    // Then, for dynamic dispatch, check all module types in the DynType for wrapped object methods
    // A method might exist in only some modules, and that's perfectly valid
    const requiredModules = dereferencedReceiverType.requiredModules;
    for (const moduleType of requiredModules) {
      const method = moduleType.fields.find(
        (field) =>
          field.label === methodName &&
          (isFunctionType(field.type) || isModuleType(field.type))
      );
      if (method && isFunctionType(method.type)) {
        // Check if the receiver type is compatible
        if (
          method.type.parameters.length > 0 &&
          (typeContainsSomeType(method.type.parameters[0]!.type) || // Leave it to the later function call checker.
            typeContainsSomeType(receiverType) ||
            areTypesCompatible(
              {
                type: method.type.parameters[0]!.type,
                env: method.type.env,
              },
              { type: receiverType, env },
              true // isMethodReceiver
            ))
        ) {
          // For dynamic dispatch, we create `undefined` to represent the method value
          const value = undefined; // NOTE: UnknownValue here is wrong: createUnknownValue(method.type, method.label);
          methods.push({ type: method.type, value });
        }
        // Don't break - continue checking other modules in case they have different signatures
      }
    }
  }
  // NOTE:
  // Type methods have higher priority than module methods,
  // so we check the module methods only if there are no type methods.
  if (methods.length > 0) {
    return filterMethodsByReceiverType(methods);
  }

  /*
  // Check the modules from innermost to outermost scope
  // ~~Stop at the first frame level where we find matching methods (shadowing)~~
  // NOTE: ^^^ This is wrong. We shouldn't stop at the latest frame level,
  // One example is the hash_map.yo where the HashMap has a parameter
  //    using(KeyEqual) : (K <: Eq(K, K))
  // When we compare (3 == 4) it only finds KeyEqual but not I32
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

  */
  /**
   * NOTE: We stop checking the methods from modules in the environment.
   * REASON 1: It is not performant to check all modules in the environment for methods.
   * REASON 2: It can lead to ambiguous method calls if multiple modules have methods with the same name.
   * REASON 3: The ambiguity problem might root deeper, for examle the code below:
   *
   * Id :: module(
   *   id : (fn(self : Self) -> Self)
   * );
   * Point :: struct(x : i32, y : i32,
   *   id :: ((self) -> self)
   * );
   *
   * use_id :: (fn(forall(T : Type), v : Type, using(XId) : (T <: Id)) -> T) {
   *   return v.id(); // This line could cause problem.
   * }
   *
   * AnotherId :: impl(Point, Id(
   *   id : ((self) -> Point(self.y, self.x))
   * ));
   *
   * use_id(Point(3, 4)); // What should it return? Should it use the `id` from Point or AnotherId?
   *
   * // The line `return v.id();` has ambiguity problem.
   *
   */
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
  const variables = topFrame.variables.filter((variable) => {
    if (variable.consumedAtToken) return false;
    if (!variable.isOwningTheRcValue) return false;
    if (!typeContainsRcType(variable.type)) return false;

    // Skip variables whose types contain unresolved SomeTypes.
    // We can't generate proper drop code for abstract type parameters.
    // This handles cases like compile-time generic functions: `compt(id) : (fn(forall(T), x: T) -> T)`
    // where temp variables may have type `T` that isn't resolved to a concrete type.
    const varType = variable.type;
    if (isSomeType(varType) && !varType.resolvedConcreteType) {
      return false;
    }

    return true;
  });

  // Return in reverse order (end to start) for proper drop order
  return variables.reverse();
}

/**
 * Find the nearest begin block frame level in the environment.
 * Temp variables should be added to the nearest begin block frame,
 * not the current top frame (which might be a function call frame).
 * Returns the frame level (0-indexed) or -1 if not found.
 */
export function findNearestBeginBlockFrameLevel(env: Environment): number {
  for (let i = env.frames.length - 1; i >= 0; i--) {
    if (env.frames[i]?.isBeginBlockFrame) {
      return i;
    }
  }
  return -1;
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
