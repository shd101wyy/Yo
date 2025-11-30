import { Environment, Variable } from "../../env";
import { formatErrorMessage } from "../../error";
import { PlaceholderToken, Token } from "../../token";
import {
  areTypesCompatible,
  isFunctionType,
  isModuleType,
  ModuleField,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import {
  isFunctionValue,
  isModuleValue,
  isTypeValue,
  ModuleValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { synthesizeTypes } from "../types/synthesizer";
import { tryToCallFunctionWithArguments } from "./helper";

export interface ImplicitResolutionResult {
  value: Value | undefined;
  type: Type;
  calleeEnv: Environment;
  callerEnv: Environment;
}

/**
 * Recursively search through module fields to find a module value that matches the expected type.
 * This searches both direct fields and nested modules (e.g., Compt sub-modules).
 */
function findMatchingModuleFieldRecursively(
  fields: ModuleField[],
  expectedType: ModuleType,
  callerEnv: Environment,
  calleeEnv: Environment
): ModuleValue | undefined {
  // First, search direct fields (in reverse order to get most recent)
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]!;
    if (!isModuleValue(field.assignedValue)) {
      continue;
    }
    const moduleValue = field.assignedValue;
    if (
      areTypesCompatible(
        { type: moduleValue.type, env: callerEnv },
        { type: expectedType, env: calleeEnv }
      )
    ) {
      return moduleValue;
    }
  }

  // Then, recursively search inside nested modules
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]!;
    if (!isModuleValue(field.assignedValue)) {
      continue;
    }
    const nestedModuleValue = field.assignedValue;
    // Search inside this nested module's type fields
    const nestedFields = nestedModuleValue.type.fields;
    const found = findMatchingModuleFieldRecursively(
      nestedFields,
      expectedType,
      callerEnv,
      calleeEnv
    );
    if (found) {
      return found;
    }
  }

  return undefined;
}

/**
 * Resolve an implicit value from the environment based on the expected type.
 * This is used for both function implicit parameters and module implicit fields.
 */
export function resolveImplicitValue({
  expectedType,
  label,
  isCompileTimeOnly,
  calleeEnv,
  callerEnv,
  context,
  errorToken,
  preventCircularCall,
}: {
  expectedType: Type;
  label: string;
  isCompileTimeOnly: boolean;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
  errorToken: Token;
  preventCircularCall?: Value; // To prevent infinite loops
}): ImplicitResolutionResult {
  // Check in the env if implicit variable of such type exists
  const implicitFunctionCalls: {
    returnType: Type;
    returnValue: Value | undefined;
    calleeEnv: Environment;
    callerEnv: Environment;
    variable: Variable;
  }[] = [];

  // Highest priority: Check if expectedType is a module type with a receiverType
  // If so, check if the receiver type has a module implementation that satisfies the expected type
  // Example: expectedType = (Point(i32, i32) <: Id), we check if Point(i32, i32) has Id module
  if (isModuleType(expectedType) && expectedType.receiverType) {
    const receiverType = expectedType.receiverType;
    if (receiverType.module) {
      const receiverModule = receiverType.module;
      // Recursively find a module field that matches the expected type
      const matchingModuleValue = findMatchingModuleFieldRecursively(
        receiverModule.fields,
        expectedType,
        callerEnv,
        calleeEnv
      );

      if (matchingModuleValue) {
        return {
          value: matchingModuleValue,
          type: matchingModuleValue.type,
          calleeEnv,
          callerEnv,
        };
      }
    }
  }

  // Second priority: Check if the implicit can be resolved from context.SelfType
  // This allows accessing module implementations defined in the same struct
  if (context.SelfType && isModuleType(expectedType)) {
    const selfTypeModule = context.SelfType.module;
    if (selfTypeModule) {
      // Recursively find a module field that matches the expected type
      const matchingModuleValue = findMatchingModuleFieldRecursively(
        selfTypeModule.fields,
        expectedType,
        callerEnv,
        calleeEnv
      );

      if (matchingModuleValue) {
        return {
          value: matchingModuleValue,
          type: matchingModuleValue.type,
          calleeEnv,
          callerEnv,
        };
      }
    }
  }

  // Search implicit variables from the callerEnv frames top-down
  let implicitVariables: Variable[] = [];

  for (let i = callerEnv.frames.length - 1; i >= 0; i--) {
    const foundImplicitVariables = callerEnv.frames[i]!.variables.filter(
      (variable) => {
        if (variable.isCompileTimeOnly !== isCompileTimeOnly) {
          return false;
        }

        // Don't match TypeHierarchy types (like Type, Module) as implicit values
        // These are type-level values, not module implementations
        // NOTE: This is wrong. We still need to check in this case.
        //       For example, the "i32" has type "Type", but we might want to use its i32.Add module.
        // if (isTypeHierarchyType(variable.type)) {
        //   return false;
        // }

        // First synthesize types to allow unification of SomeTypes with concrete types
        const {
          expectedEnv: synthesizedCalleeEnv,
          givenEnv: synthesizedCallerEnv,
        } = synthesizeTypes(
          { type: expectedType, env: calleeEnv },
          { type: variable.type, env: callerEnv }
        );

        // Check if type matches
        const isCompatible = areTypesCompatible(
          { type: expectedType, env: synthesizedCalleeEnv },
          { type: variable.type, env: synthesizedCallerEnv }
        );

        if (isCompatible) {
          return true;
        }

        // Check if it's a function that has no parameters.
        // (can have type parameters, and implicit parameters).
        // Then try to call that function to check if its return type can
        // match the implicit parameter type
        if (isFunctionType(variable.type)) {
          const funcType = variable.type;
          if (funcType.parameters.length === 0) {
            const funcValue = variable.value;

            if (
              !!funcValue &&
              !!preventCircularCall &&
              funcValue === preventCircularCall
            ) {
              // Prevent infinite loop
              return false;
            }

            if (!(!funcValue || isFunctionValue(funcValue))) {
              return false;
            }

            try {
              const {
                returnType,
                returnValue,
                calleeEnv: nextCalleeEnv,
                callerEnv: nextCallerEnv,
              } = tryToCallFunctionWithArguments({
                argExprs: [],
                callerEnv,
                functionType: funcType,
                functionValue: funcValue,
                functionCalleeExpr: undefined,
                context: {
                  ...context,
                  expectedType: {
                    type: expectedType,
                    env: calleeEnv,
                  },
                },
                isMethodCall: false,
              });
              const matched = areTypesCompatible(
                { type: returnType, env: nextCallerEnv },
                { type: expectedType, env: nextCalleeEnv }
              );
              if (matched) {
                implicitFunctionCalls.push({
                  returnType,
                  returnValue,
                  calleeEnv: nextCalleeEnv,
                  callerEnv: nextCallerEnv,
                  variable,
                });
              }

              return matched;
            } catch {
              // Failed
            }
          }
        }

        // Check if the variable module value matches the expected expectedType
        if (isModuleType(expectedType) && isTypeValue(variable.value)) {
          const type = variable.value.value;
          if (type.module) {
            const matchingModuleValue = findMatchingModuleFieldRecursively(
              type.module.fields,
              expectedType,
              callerEnv,
              calleeEnv
            );
            if (matchingModuleValue) {
              implicitFunctionCalls.push({
                returnType: matchingModuleValue.type,
                returnValue: matchingModuleValue,
                calleeEnv,
                callerEnv,
                variable,
              });
              return true;
            }
          }
        }

        return false;
      }
    );
    // No need to continue searching if we found implicit variables in this frame
    if (foundImplicitVariables.length) {
      implicitVariables = implicitVariables.concat(foundImplicitVariables);
      break;
    }
  }

  // Get the max frame level of the implicit variables
  // This is to ensure that we get the most recent implicit variable
  const maxImplicitVariableFrameLevel = Math.max(
    ...implicitVariables.map((variable) => variable.frameLevel)
  );
  implicitVariables = implicitVariables.filter(
    (variable) => variable.frameLevel === maxImplicitVariableFrameLevel
  );

  if (implicitVariables.length === 0) {
    throw formatErrorMessage({
      token: errorToken ?? PlaceholderToken,
      errorMessage: `Implicit value is not provided. Expected:
using(${label}) : ${typeToString(expectedType)}`,
    });
  }

  if (implicitVariables.length > 1) {
    throw formatErrorMessage({
      token: errorToken ?? PlaceholderToken,
      errorMessage: `Ambiguous implicit value:
${label ? `(${label} : ${typeToString(expectedType)})` : typeToString(expectedType)}

Found:
${implicitVariables
  .map((variable) => {
    return `- ${variable.name} : ${typeToString(variable.type)}`;
  })
  .join("\n")}
`,
    });
  }

  // Get the implicit variable
  const implicitVariable = implicitVariables[0]!;

  // Check if it's from an implicit function call or type module
  const functionCallResult = implicitFunctionCalls.find(
    (c) => c.variable === implicitVariable
  );

  if (functionCallResult) {
    return {
      value: functionCallResult.returnValue,
      type: functionCallResult.returnType,
      calleeEnv: functionCallResult.calleeEnv,
      callerEnv: functionCallResult.callerEnv,
    };
  }

  // Direct variable match
  return {
    value: implicitVariable.value,
    type: implicitVariable.type,
    calleeEnv,
    callerEnv,
  };
}
