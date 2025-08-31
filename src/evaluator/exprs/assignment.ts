import { checkBorrowings } from "../../borrow";
import {
  Environment,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage, formatErrorMessages } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  ControlFlowKind,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  ClosureType,
  createArrayType,
  EnumType,
  isArrayType,
  isClosureType,
  isEnumType,
  isSomeType,
  isStructType,
  isTypeHierarchyType,
  StructType,
  TupleType,
  Type,
  typeRequiresInference,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  createArrayValue,
  createEnumValue,
  createStructValue,
  createTupleValue,
  isArrayValue,
  isEnumValue,
  isFunctionValue,
  isModuleValue,
  isStructValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  StructValue,
  TupleValue,
} from "../../value";
import { EvaluatorContext, trackVariableUsage } from "../context";
import { synthesizeExprAndType } from "../types/expr_synthesizer";
import { evaluateBinding } from "./binding";
import { evaluateIdentifierAndOperator } from "./identifer_and_operator";

export function throwRhsContainsControlFlowExpressionError(
  rhs: Expr,
  controlFlow: ControlFlowKind
) {
  let errorMessage = `Right-hand side contains "${controlFlow}" from function.`;
  if (
    exprIsFunctionCall(rhs) &&
    exprIsFunctionCallOf(rhs, BuiltinKeywords.cond)
  ) {
    errorMessage = `Cannot assign "cond" expression to variable when all cases contain "${controlFlow}" statements. Consider using the "cond" result directly without assignment, or ensure at least one case doesn't return.`;
  } else if (
    exprIsFunctionCall(rhs) &&
    exprIsFunctionCallOf(rhs, BuiltinKeywords.match)
  ) {
    errorMessage = `Cannot assign "match" expression to variable when all cases contain "${controlFlow}" statements. Consider using the "match" result directly without assignment, or ensure at least one case doesn't return.`;
  } else if (
    exprIsFunctionCall(rhs) &&
    exprIsFunctionCallOf(rhs, BuiltinKeywords.begin)
  ) {
    errorMessage = `Cannot assign "begin" expression to variable when it contains "${controlFlow}" statement.`;
  }

  throw formatErrorMessage({
    token: rhs.token,
    errorMessage,
  });
}

/**
 * Check if a type contains unknown values that need to be resolved
 */

/**
 * Resolve unknown values and SomeType instances in a type by looking up their resolved values in the environment
 */
function resolveUnknownValuesAndSomeTypeInType(
  type: Type,
  env: Environment
): Type {
  if (isArrayType(type) && isUnknownValue(type.length)) {
    const unknownLength = type.length;
    if (unknownLength.variableName) {
      // Look up the resolved value of the unknown length variable
      const variables = getVariablesFromEnv(env, unknownLength.variableName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.value && !isUnknownValue(variable.value)) {
          // Create a new array type with the resolved length
          return createArrayType(type.elementType, variable.value);
        }
      }
    }
  }

  if (isClosureType(type) && isSomeType(type.captureType)) {
    const someTypeCapture = type.captureType;
    // Look up the resolved value of the SomeType
    const variables = getVariablesFromEnv(env, someTypeCapture.name);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;
      if (variable.value && isTypeValue(variable.value)) {
        const resolvedCaptureType = variable.value.value;
        // Create a new closure type with the resolved capture type
        return {
          ...type,
          captureType: resolvedCaptureType,
        } as ClosureType;
      }
    }
  }

  return type;
}

/**
 * Evaluate assignment like
 * (x : i32) = 12;
 * x = 13;
 */
export function evaluateAssignment({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, "=", 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "=" for assignment.`,
    });
  }

  let lhs = expr.args[0]!;
  let rhs = expr.args[1]!;

  // Something like
  // - (x : i32) = 12;
  // - x = 12;
  if (
    exprIsAtom(lhs) ||
    (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2))
  ) {
    let variableName: string;
    if (exprIsAtom(lhs)) {
      // x = 12;
      const evaluatedLhs = evaluateIdentifierAndOperator({
        expr: lhs,
        env,
        context: { ...context },
        throwErrorOnUndefined: false,
      });
      if (!evaluatedLhs.$) {
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`,
        });
      }
      env = evaluatedLhs.$.env;

      // Check if the variable exists in the environment
      lhs = evaluatedLhs;
      variableName = lhs.token.value;
    } else {
      // (x: i32) = 12;
      const {
        expr: bindingExpr,
        variableExpr,
        variableName: nextVariableName,
      } = evaluateBinding({
        expr: lhs,
        env,
        context: {
          ...context,
        },
      });
      if (bindingExpr.$?.env) {
        env = bindingExpr.$?.env;
      }
      lhs = variableExpr;
      variableName = nextVariableName;
    }

    const variables = getVariablesFromEnv(env, variableName);
    if (!variables.length) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Variable ${variableName} not found in the environment`,
      });
    }
    const variable = variables[variables.length - 1]!;

    // Evaluate the rhs expression
    rhs = context.evaluateExpression({
      expr: rhs,
      env,
      context: {
        ...context,
        expectedType: { type: variable.type, env },
      },
    });
    if (rhs.$?.env) {
      env = rhs.$?.env;
    }

    if (rhs.$?.controlFlow) {
      throwRhsContainsControlFlowExpressionError(rhs, rhs.$.controlFlow);
    }

    let rhsType = rhs.$?.type;
    if (!rhsType) {
      // Try synthesize the type
      try {
        // Infer the type
        const {
          expr: nextRhs,
          type: nextRhsType,
          env: nextEnv,
        } = synthesizeExprAndType({
          expr: rhs,
          type: variable.type,
          env: env,
          context: { ...context },
        });
        rhs = nextRhs;
        rhsType = nextRhsType;
        // as it is actually lhs.type if not synthesized.
        env = nextEnv;
      } catch (e) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `(evaluateAssignment) Failed to synthesize type for expression: ${exprToString(
            rhs
          )}\n${e}`,
        });
      }
    }

    // Check if the type matches
    if (
      !areTypesCompatible({ type: variable.type, env }, { type: rhsType, env })
    ) {
      // Only try synthesis if the expected type contains unknown values that could be resolved
      if (typeRequiresInference(variable.type)) {
        // If types are incompatible, try synthesis in case there are unknown values to resolve
        try {
          const {
            expr: synthesizedRhs,
            type: synthesizedRhsType,
            env: synthesizedEnv,
          } = synthesizeExprAndType({
            expr: rhs,
            type: variable.type,
            env: env,
            context: { ...context },
          });

          // Check if synthesis made the types compatible
          if (
            areTypesCompatible(
              { type: variable.type, env: synthesizedEnv },
              { type: synthesizedRhsType, env: synthesizedEnv }
            )
          ) {
            rhs = synthesizedRhs;
            rhsType = synthesizedRhsType;
            env = synthesizedEnv;

            // After synthesis, resolve any unknown values in the variable type
            const resolvedVariableType = resolveUnknownValuesAndSomeTypeInType(
              variable.type,
              env
            );

            // Update the variable in the environment with the resolved type
            env = updateExistingVariable(env, variable, {
              ...variable,
              type: resolvedVariableType,
            });
          } else {
            // Still incompatible after synthesis
            throw formatErrorMessage({
              token: lhs.token,
              errorMessage: `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`,
            });
          }
        } catch (synthesisError) {
          // Synthesis failed, throw original incompatibility error
          throw formatErrorMessage({
            token: lhs.token,
            errorMessage: `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`,
          });
        }
      } else {
        // No unknown values to resolve, just throw the incompatibility error
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`,
        });
      }
    }

    // Get the updated variable from the environment (in case it was updated during synthesis)
    const updatedVariables = getVariablesFromEnv(env, variableName);
    const updatedVariable = updatedVariables[updatedVariables.length - 1]!;

    // Add .typeName info if necessary
    const rhsValue = rhs.$?.value;
    if (isTypeValue(rhsValue) && !rhsValue.value.typeName) {
      rhsValue.value.typeName = variableName;

      if (
        isTypeHierarchyType(updatedVariable.type) &&
        !updatedVariable.type.baseType
      ) {
        // If the variable type is a type hierarchy, set the base type
        updatedVariable.type.baseType = rhsValue.value;
      }
    } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
      rhsValue.funcName = variableName;
      rhsValue.funcId += `_${lhs.token.value}`;
    } else if (isModuleValue(rhsValue) && !rhsValue.type.typeName) {
      rhsValue.type.typeName = variableName;
    }

    // No consumption logic needed

    let variableType = updatedVariable.type;
    // Check if it's enum and selectedVariant changed
    if (
      isEnumType(variableType) &&
      isEnumType(rhsType) &&
      variableType.selectedVariantName !== rhsType.selectedVariantName
    ) {
      variableType = {
        ...variableType,
        selectedVariantName: rhsType.selectedVariantName,
      } as EnumType;
    }
    let isMutatingDefinedVariable = false;
    if (!variable.initializedAtToken) {
      // Check if we are initializing a variable that is defined outside the current while loop.
      if (
        context.isEvaluatingLoopBody &&
        variable.frameLevel < context.isEvaluatingLoopBody.env.frames.length
      ) {
        throw formatErrorMessages([
          {
            token: lhs.token,
            errorMessage: `Cannot initialize a variable that is defined outside the while loop.`,
          },
          {
            token: variable.token,
            errorMessage: `Defined here:`,
          },
        ]);
      }

      // Check if we are initializing a variable defined outside the current funciton body.
      if (
        context.isEvaluatingFunctionBody &&
        variable.frameLevel <
          context.isEvaluatingFunctionBody.type.env.frames.length
      ) {
        throw formatErrorMessages([
          {
            token: lhs.token,
            errorMessage: `Cannot initialize a variable that is defined outside the function body.`,
          },
          {
            token: variable.token,
            errorMessage: `Defined here:`,
          },
        ]);
      }

      // Initialize the variable
      // For value semantics, clone array and enum values when initializing variables
      let valueToStore = variable.isCompileTimeOnly ? rhsValue : undefined;
      if (valueToStore && isArrayValue(valueToStore)) {
        // Clone the array to ensure value semantics
        const arrayType = variable.type as ArrayType;
        valueToStore = createArrayValue(arrayType, [...valueToStore.elements]);
      } else if (valueToStore && isEnumValue(valueToStore)) {
        // Clone the enum only for value semantics, not for reference semantics
        const enumType = variable.type as EnumType;
        if (!enumType.isReferenceSemantics) {
          valueToStore = createEnumValue(enumType, valueToStore.variantName, [
            ...valueToStore.elements,
          ]);
        }
        // For reference semantics enums, keep the original value to share the reference
      }

      env = updateExistingVariable(env, variable, {
        ...variable,
        initializedAtToken: lhs.token,
        value: valueToStore,
        type: variableType,
        // type: rhsType,
      });
    } else if (variable.isMutable) {
      // For closures, track variable writes to outer scope
      if (
        context.isEvaluatingFunctionBody &&
        context.isEvaluatingFunctionBody.type.isClosure &&
        context.isEvaluatingFunctionBody.evaluationEnv
      ) {
        const closureEvaluationFrameLevel =
          context.isEvaluatingFunctionBody.evaluationEnv.frames.length;

        // If variable is from an outer scope (lower frame level than closure evaluation), it's captured
        if (variable.frameLevel < closureEvaluationFrameLevel) {
          // Determine usage type based on closure kind
          const usageType = "own";
          /*
            context.isEvaluatingFunctionBody.type.closureKind === "FnMove"
              ? "own"
              : "write";
          */

          trackVariableUsage(
            variable.name,
            variable.frameLevel,
            usageType,
            lhs.token,
            context
          );
        }
      }

      // Update the variable value
      // For value semantics, clone array and enum values when assigning to new variables
      let valueToStore = variable.isCompileTimeOnly ? rhsValue : undefined;
      if (valueToStore && isArrayValue(valueToStore)) {
        // Clone the array to ensure value semantics
        const arrayType = variable.type as ArrayType;
        valueToStore = createArrayValue(arrayType, [...valueToStore.elements]);
      } else if (valueToStore && isEnumValue(valueToStore)) {
        // Clone the enum only for value semantics, not for reference semantics
        const enumType = variable.type as EnumType;
        if (!enumType.isReferenceSemantics) {
          valueToStore = createEnumValue(enumType, valueToStore.variantName, [
            ...valueToStore.elements,
          ]);
        }
        // For reference semantics enums, keep the original value to share the reference
      }

      env = updateExistingVariable(env, variable, {
        ...variable,
        value: valueToStore,
        type: variableType,
      });
      isMutatingDefinedVariable = true;
    } else {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Cannot assign to immutable variable "${variableName}"`,
      });
    }

    lhs.$ = {
      env,
      type: variable.type, // NOTE: It shouldn't be the rhsType.
      value: variable.isCompileTimeOnly ? rhsValue : undefined,
      isMutable: variable.isMutable,
      pathCollection: [[variableName]],
    };
    // Check the borrowings
    checkBorrowings(context.borrowings, lhs);

    if (!isMutatingDefinedVariable) {
      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        isMutable: variable.isMutable,
        pathCollection: [],
      };
    } else {
      expr.$ = {
        // NOTE: This should return the original value of lhs
        env,
        value: variable.value,
        type: variable.type,
        isMutable: variable.isMutable,
        pathCollection: [],
      };

      // This temp variable is used to hold the old value of lhs
      attachTempVariableToExpr(expr);
    }

    return expr;
  }
  // Something like
  // - x.a = 12;
  // - arr(0) = 12;
  else {
    // Evaluate the lhs
    const evaluatedLhs = context.evaluateExpression({
      expr: lhs,
      env,
      context: {
        ...context,
        expectedType: undefined,
      },
    });
    if (!evaluatedLhs.$) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`,
      });
    }
    if (!evaluatedLhs.$.isMutable) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Cannot assign value to the immutable: ${exprToString(lhs)}`,
      });
    }

    // Check the borrowings
    checkBorrowings(context.borrowings, evaluatedLhs);

    // Track variable usage for closure kind checking
    if (context.isEvaluatingFunctionBody && evaluatedLhs.$.pathCollection) {
      for (const path of evaluatedLhs.$.pathCollection) {
        if (path.length > 0) {
          const variableName = path[0];
          if (typeof variableName === "string") {
            // Get the variable to determine its frame level
            const variables = getVariablesFromEnv(env, variableName);
            if (variables.length > 0) {
              const variable = variables[variables.length - 1]!;
              // Track this as a write operation for field assignment
              trackVariableUsage(
                variableName,
                variable.frameLevel,
                "write",
                lhs.token,
                context
              );
            }
          }
        }
      }
    }

    const expectedType = evaluatedLhs.$.type;

    // Evaluate the rhs expression
    rhs = context.evaluateExpression({
      expr: rhs,
      env,
      context: {
        ...context,
        expectedType: { type: expectedType, env },
      },
    });
    if (rhs.$?.env) {
      env = rhs.$?.env;
    }

    let rhsType = rhs.$?.type;
    if (!rhsType) {
      // Try synthesize the type
      try {
        // Infer the type
        const {
          expr: nextRhs,
          type: nextRhsType,
          env: nextEnv,
        } = synthesizeExprAndType({
          expr: rhs,
          type: expectedType,
          env: env,
          context: { ...context },
        });
        rhs = nextRhs;
        rhsType = nextRhsType;
        // as it is actually lhs.type if not synthesized.
        env = nextEnv;
      } catch (e) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `(evaluateAssignment) Failed to synthesize type for expression: ${exprToString(
            rhs
          )}\n${e}`,
        });
      }
    }

    // Check if the type matches
    if (
      !areTypesCompatible({ type: expectedType, env }, { type: rhsType, env })
    ) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Incompatible types:
- Expected: ${typeToString(expectedType)}
- Given   : ${typeToString(rhsType)}`,
      });
    }

    // For field/index assignments, we need to update the actual variable value
    // if it's a compile-time mutable variable
    if (
      evaluatedLhs.$.pathCollection &&
      evaluatedLhs.$.pathCollection.length > 0
    ) {
      const path = evaluatedLhs.$.pathCollection[0];
      if (path && path.length >= 2) {
        const variableName = path[0] as string;
        const fieldOrIndex = path[1] as string;

        // Get the variable from environment
        const variables = getVariablesFromEnv(env, variableName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;

          // If it's a compile-time mutable variable with a struct/array value, update it
          if (
            variable.isMutable &&
            variable.isCompileTimeOnly &&
            variable.value
          ) {
            const currentValue = variable.value;

            // Handle struct/tuple field assignment
            if (isStructValue(currentValue) || isTupleValue(currentValue)) {
              // Find the field index
              const structType = variable.type as StructType | TupleType;
              const fieldIndex = structType.elements.findIndex(
                (element) => element.label === fieldOrIndex
              );

              if (fieldIndex >= 0 && rhs.$?.value) {
                // For reference semantics structs, we need to update ALL variables
                // that point to the same struct object
                if (
                  isStructType(variable.type) &&
                  variable.type.isReferenceSemantics
                ) {
                  // Create a new struct value with the updated field
                  const newElements = [...currentValue.elements];
                  newElements[fieldIndex] = rhs.$.value;
                  const newValue = createStructValue(
                    variable.type,
                    newElements
                  );

                  // Find all variables in the environment that have the same struct value
                  // and update them all to maintain reference semantics
                  const allVariables = getVariablesFromEnvByFilter(
                    env,
                    (v) => v.isCompileTimeOnly && v.value === currentValue
                  );
                  for (const sharedVariable of allVariables) {
                    env = updateExistingVariable(env, sharedVariable, {
                      ...sharedVariable,
                      value: newValue,
                    });
                  }
                } else {
                  // Value semantics - only update the specific variable
                  const newElements = [...currentValue.elements];
                  newElements[fieldIndex] = rhs.$.value;

                  let newValue: StructValue | TupleValue;
                  if (isStructValue(currentValue)) {
                    newValue = createStructValue(
                      structType as StructType,
                      newElements
                    );
                  } else {
                    newValue = createTupleValue(
                      structType as TupleType,
                      newElements
                    );
                  }

                  // Update only this variable
                  env = updateExistingVariable(env, variable, {
                    ...variable,
                    value: newValue,
                  });
                }
              }
            }
            // Handle array index assignment
            else if (isArrayValue(currentValue)) {
              const arrayIndex = parseInt(fieldOrIndex, 10);
              if (
                !isNaN(arrayIndex) &&
                arrayIndex >= 0 &&
                arrayIndex < currentValue.elements.length &&
                rhs.$?.value
              ) {
                // Create a new array value with the updated element
                const newElements = [...currentValue.elements];
                newElements[arrayIndex] = rhs.$.value;

                const arrayType = variable.type as ArrayType;
                const newValue = createArrayValue(arrayType, newElements);

                // Update the variable in the environment
                env = updateExistingVariable(env, variable, {
                  ...variable,
                  value: newValue,
                });
              }
            }
            // Handle enum field assignment
            else if (isEnumValue(currentValue)) {
              const enumType = variable.type as EnumType;

              // Find the selected variant
              const selectedVariant = enumType.variants.find(
                (variant) => variant.name === currentValue.variantName
              );

              if (selectedVariant) {
                // Find the field index in the variant
                const fieldIndex = (selectedVariant.elements ?? []).findIndex(
                  (element) => element.label === fieldOrIndex
                );

                if (fieldIndex >= 0 && rhs.$?.value) {
                  // Create a new enum value with the updated field
                  const newElements = [...currentValue.elements];
                  newElements[fieldIndex] = rhs.$.value;

                  const newValue = createEnumValue(
                    enumType,
                    currentValue.variantName,
                    newElements
                  );

                  // For reference semantics enums, we need to update ALL variables
                  // that point to the same enum object
                  if (
                    isEnumType(variable.type) &&
                    variable.type.isReferenceSemantics
                  ) {
                    // Find all variables in the environment that have the same enum value
                    // and update them all to maintain reference semantics
                    const allVariables = getVariablesFromEnvByFilter(
                      env,
                      (v) => v.isCompileTimeOnly && v.value === currentValue
                    );
                    for (const sharedVariable of allVariables) {
                      env = updateExistingVariable(env, sharedVariable, {
                        ...sharedVariable,
                        value: newValue,
                      });
                    }
                  } else {
                    // Value semantics - only update the specific variable
                    env = updateExistingVariable(env, variable, {
                      ...variable,
                      value: newValue,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // Attach the updated env to expr
    expr.$ = {
      // NOTE: This should return the original value of lhs
      env,
      value: evaluatedLhs.$.value,
      type: evaluatedLhs.$.type,
      isMutable: evaluatedLhs.$.isMutable,
      pathCollection: [],
    };

    // This temp variable is used to hold the old value of lhs
    attachTempVariableToExpr(expr);

    // Update the lhs with the new value
    evaluatedLhs.$ = {
      env,
      type: expectedType, // NOTE: It shouldn't be the rhsType.
      value: rhs.$?.value,
      isMutable: evaluatedLhs.$.isMutable,
      pathCollection: evaluatedLhs.$.pathCollection,
    };
    // Return the updated expression
    return expr;
  }
}
