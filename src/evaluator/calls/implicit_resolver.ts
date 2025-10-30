import { Environment, Variable } from "../../env";
import { formatErrorMessage } from "../../error";
import { PlaceholderToken, Token } from "../../token";
import {
  areTypesCompatible,
  isFunctionType,
  isModuleType,
  isTypeHierarchyType,
  Type,
  typeToString,
} from "../../types";
import {
  isFunctionValue,
  isModuleValue,
  isTypeValue,
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
 * Resolve an implicit value from the environment based on the expected type.
 * This is used for both function implicit parameters and module implicit elements.
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

  // First, check if the implicit can be resolved from context.SelfType
  // This allows accessing module implementations defined in the same struct
  if (context.SelfType && isModuleType(expectedType)) {
    const selfTypeModule = context.SelfType.module;
    if (selfTypeModule) {
      // Use findLast to get the most recently added element (with assignedValue)
      const matchingElement = selfTypeModule.elements.findLast((element) => {
        if (!isModuleValue(element.assignedValue)) {
          return false;
        }
        const moduleValue = element.assignedValue;
        return areTypesCompatible(
          { type: moduleValue.type, env: callerEnv },
          { type: expectedType, env: calleeEnv }
        );
      });

      if (matchingElement && isModuleValue(matchingElement.assignedValue)) {
        return {
          value: matchingElement.assignedValue,
          type: matchingElement.assignedValue.type,
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
        if (isTypeHierarchyType(variable.type)) {
          return false;
        }

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
            const module = type.module;
            for (let i = 0; i < module.elements.length; i++) {
              const moduleElement = module.elements[i]!;
              if (isModuleValue(moduleElement.assignedValue)) {
                const moduleValue = moduleElement.assignedValue;
                if (
                  areTypesCompatible(
                    { type: moduleValue.type, env: callerEnv },
                    { type: expectedType, env: calleeEnv }
                  )
                ) {
                  implicitFunctionCalls.push({
                    returnType: moduleValue.type,
                    returnValue: moduleValue,
                    calleeEnv,
                    callerEnv,
                    variable,
                  });
                  return true;
                }
              }
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
