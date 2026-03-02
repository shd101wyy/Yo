import {
  type Environment,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage, formatErrorMessages } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  type ControlFlowFlags,
  controlFlowToString,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
  requireExprNotConsumed,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { createArrayType } from "../../types/creators";
import type {
  ArrayType,
  EnumType,
  SomeType,
  StructType,
  TupleType,
  Type,
} from "../../types/definitions";
import {
  isArrayType,
  isEnumType,
  isSomeType,
  isStructType,
  isTypeHierarchyType,
} from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  typeContainsRcType,
  typeRequiresInference,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import { generateVarialeId } from "../../utils";
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
  isTraitValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  type StructValue,
  type TupleValue,
  type Value,
} from "../../value";
import { type EvaluatorContext, trackVariableUsage } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { synthesizeExprAndType } from "../types/expr-synthesizer";
import {
  findRcValueOwnerRelationship,
  throwExprIsImplicitVariableError,
} from "../utils";
import { cloneValue } from "../values/clone-value";
import { evaluateBinding } from "./binding";
import { evaluateIdentifierAndOperator } from "./identifer-and-operator";

export function throwRhsContainsControlFlowExpressionError(
  rhs: Expr,
  controlFlow: ControlFlowFlags
) {
  const controlFlowStr = controlFlowToString(controlFlow);
  let errorMessage = `Right-hand side contains "${controlFlowStr}" from function.`;
  if (
    exprIsFunctionCall(rhs) &&
    exprIsFunctionCallOf(rhs, BuiltinKeywords.cond)
  ) {
    errorMessage = `Cannot assign "cond" expression to variable when all cases contain "${controlFlowStr}" statements. Consider using the "cond" result directly without assignment, or ensure at least one case doesn't return.`;
  } else if (
    exprIsFunctionCall(rhs) &&
    exprIsFunctionCallOf(rhs, BuiltinKeywords.match)
  ) {
    errorMessage = `Cannot assign "match" expression to variable when all cases contain "${controlFlowStr}" statements. Consider using the "match" result directly without assignment, or ensure at least one case doesn't return.`;
  } else if (
    exprIsFunctionCall(rhs) &&
    exprIsFunctionCallOf(rhs, BuiltinKeywords.begin)
  ) {
    errorMessage = `Cannot assign "begin" expression to variable when it contains "${controlFlowStr}" statement.`;
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
        if (variable.value?.[0] && !isUnknownValue(variable.value[0])) {
          // Create a new array type with the resolved length
          return createArrayType(type.childType, variable.value[0]);
        }
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
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

    // Check if trying to reassign, eg a function parameter
    if (!variable.isReassignable) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Cannot reassign "${variableName}".  
You can mutate fields (e.g., ${variableName}.field = value) but cannot reassign itself.`,
      });
    }

    // Evaluate the rhs expression
    rhs = evaluateExpression({
      expr: rhs,
      env,
      context: {
        ...context,
        expectedType: { type: variable.type, env },
        isInsideGivenHandler: variable.isImplicit
          ? true
          : context.isInsideGivenHandler,
      },
    });
    if (!rhs.$) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Failed to evaluate right-hand side of assignment: ${exprToString(rhs)}`,
      });
    }
    env = rhs.$.env;

    // Check if the RHS variable has been consumed (moved)
    requireExprNotConsumed(rhs, env);

    // Disallow using implicit variables (or property access of them) as the RHS
    throwExprIsImplicitVariableError(rhs);

    // Under the new ownership model, all assignments transfer ownership
    // so we always need to call dup on the RHS
    setExprAsNeedsToCallDup(rhs, context);
    env = rhs.$.env;

    if (hasAnyControlFlow(rhs.$?.controlFlow)) {
      throwRhsContainsControlFlowExpressionError(rhs, rhs.$.controlFlow!);
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

    // Convert compile-time types to runtime types if needed
    // For example: comptime_string -> [u8] when assigning to a [u8] variable
    if (!variable.isCompileTimeOnly) {
      rhsType = convertComptimeTypeToRuntimeType({
        type: rhsType,
        expectedType: variable.type,
        expr: rhs,
        env,
      });
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
      // Don't set typeName if this is a reference to Self (context.SelfType)
      // This prevents mutating the enclosing type's typeName
      if (rhsValue.value !== context.SelfType) {
        rhsValue.value.typeName = variableName;
      }

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
    } else if (
      (isModuleValue(rhsValue) || isTraitValue(rhsValue)) &&
      !rhsValue.type.typeName
    ) {
      // Don't set typeName if this is a reference to Self (context.SelfType)
      if (rhsValue.type !== context.SelfType) {
        rhsValue.type.typeName = variableName;
      }
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

    // For SomeType (Impl(...)), copy the resolvedConcreteType from RHS to variable type.
    // This is crucial for closures where the capture struct type is determined at assignment time.
    // The resolvedConcreteType is needed by mergeAndCheckEnvs to verify that all branches
    // have compatible concrete types (Impl uses static dispatch, so concrete type must be known).
    // Note: Reassignment of SomeType variables is disallowed (see the else branch below),
    // so this only applies to the initial assignment.
    if (
      isSomeType(variableType) &&
      isSomeType(rhsType) &&
      rhsType.resolvedConcreteType
    ) {
      variableType = {
        ...variableType,
        resolvedConcreteType: rhsType.resolvedConcreteType,
      } as SomeType;
    }
    let isMutatingDefinedVariable = false;
    const oldVariableIsOwningTheSameRcValueAs =
      variable.isOwningTheSameRcValueAs;
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
        context.isEvaluatingFunctionBodyOrAsyncBlock?.kind ===
          "function-body" &&
        variable.frameLevel <
          context.isEvaluatingFunctionBodyOrAsyncBlock.type.env.frames.length
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
      // For value semantics, use cloneValue to ensure deep copy
      // This prevents mutations to one variable from affecting another
      const valueToStore =
        variable.isCompileTimeOnly && rhsValue
          ? cloneValue(rhsValue)
          : undefined;

      // Under the new simplified ownership model:
      // Variables created by := always own their values
      // But we track shared ownership for dup/drop optimization

      // Find if RHS is sharing ownership with another variable
      const rhsOwningVariable = findRcValueOwnerRelationship(
        rhs,
        env,
        env.modulePath
      );

      // If the RHS owning variable was consumed (moved), LHS becomes the primary owner
      let isOwningTheSameRcValueAs = rhsOwningVariable;
      if (rhsOwningVariable?.consumedAtToken) {
        isOwningTheSameRcValueAs = undefined;
      }

      env = updateExistingVariable(env, variable, {
        ...variable,
        initializedAtToken: lhs.token,
        value: valueToStore ? [valueToStore] : undefined,
        type: variableType,
        isOwningTheRcValue: typeContainsRcType(variableType),
        isOwningTheSameRcValueAs, // Track shared ownership for optimization, or undefined if moved
      });
    } else {
      // Disallow reassignment of SomeType (Impl(...)) variables.
      // In Rust, once a variable's concrete type is determined through `impl Trait`,
      // it cannot be reassigned to a different value (even of the same trait).
      // This is because Impl(...) uses static dispatch and the concrete type is fixed.
      // If you need to reassign closures with different capture types, use Dyn(...) instead.
      if (isSomeType(variableType)) {
        throw formatErrorMessages([
          {
            token: lhs.token,
            errorMessage: `Cannot reassign variable "${variableName}" of type Impl(...).
Impl(...) uses static dispatch and the concrete type is fixed at first assignment.
Consider using Dyn(...) for dynamic dispatch if you need to reassign to different implementations.`,
          },
          {
            token: variable.initializedAtToken ?? variable.token,
            errorMessage: `First assigned here:`,
          },
        ]);
      }

      // For closures, track variable writes to outer scope
      if (
        context.isEvaluatingFunctionBodyOrAsyncBlock?.kind ===
          "function-body" &&
        context.capturedVariables &&
        context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv
      ) {
        const closureEvaluationFrameLevel =
          context.isEvaluatingFunctionBodyOrAsyncBlock.evaluationEnv.frames
            .length;

        // If variable is from an outer scope (lower frame level than closure evaluation), it's captured
        if (variable.frameLevel < closureEvaluationFrameLevel) {
          // Determine usage type based on closure kind
          const usageType = "own";
          /*
            context.isEvaluatingFunctionBodyOrAsyncBlock.type.closureKind === "FnMove"
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
      // For value semantics, use cloneValue to ensure deep copy
      // This prevents mutations to one variable from affecting another
      const valueToStore =
        variable.isCompileTimeOnly && rhsValue
          ? cloneValue(rhsValue)
          : undefined;

      // Generate a new variable ID for reassignment
      // This is crucial for dup/drop optimization: dup calls on the old ID
      // won't be matched with drop calls on the new ID
      const newVariableId = generateVarialeId(env.modulePath, variableName);

      // Find if RHS is sharing ownership with another variable
      const rhsOwningVariable = findRcValueOwnerRelationship(
        rhs,
        env,
        env.modulePath
      );

      // If the RHS owning variable was consumed (moved), LHS becomes the primary owner
      let isOwningTheSameRcValueAs = rhsOwningVariable;
      if (rhsOwningVariable?.consumedAtToken) {
        isOwningTheSameRcValueAs = undefined;
      }

      // Under the new simplified ownership model:
      // Variables always own their values
      // But we track shared ownership for dup/drop optimization
      env = updateExistingVariable(env, variable, {
        ...variable,
        id: newVariableId, // New ID distinguishes this instance from previous one
        value: valueToStore ? [valueToStore] : undefined,
        type: variableType,
        isOwningTheRcValue: typeContainsRcType(variableType),
        isOwningTheSameRcValueAs, // Track shared ownership for optimization, or undefined if moved
      });
      isMutatingDefinedVariable = true;
    }

    // NOTE: The finalVariable might be SomeType that contains resolvedConcreteType
    // That's what we need
    const finalVariables = getVariablesFromEnv(env, variableName);
    const finalVariable = finalVariables[finalVariables.length - 1]!;
    lhs.$ = {
      env,
      type: finalVariable.type, // NOTE: It shouldn't be the rhsType.
      value: finalVariable.isCompileTimeOnly ? rhsValue : undefined,
      pathCollection: [[variableName]],
    };

    if (!isMutatingDefinedVariable) {
      expr.$ = {
        env,
        value: VUnit,
        type: VUnit.type,
        pathCollection: [],
      };
    } else {
      expr.$ = {
        // NOTE: This should return the original value of lhs
        env,
        value: variable.value?.[0],
        type: variable.type,
        pathCollection: [],
      };

      // This temp variable is used to hold the old value of lhs
      attachTempVariableToExpr(
        expr,
        true,

        // Check if the oldVariableIsOwningTheSameRcValueAs is located on the same frame level
        // If not, we can't track the relationship as the old variable is out of scope
        oldVariableIsOwningTheSameRcValueAs?.frameLevel ===
          env.frames.length - 1
          ? oldVariableIsOwningTheSameRcValueAs
          : undefined
      );
    }

    return expr;
  }
  // Something like
  // - x.a = 12;
  // - arr(0) = 12;
  else {
    // Evaluate the lhs
    const evaluatedLhs = evaluateExpression({
      expr: lhs,
      env,
      context: {
        ...context,
        expectedType: undefined,
        isLhsOfAssignment: true, // Signal that we're assigning into, not moving out
      },
    });
    if (!evaluatedLhs.$) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Failed to evaluate left-hand side of assignment: ${exprToString(lhs)}`,
      });
    }

    // Track variable usage for closure kind checking
    if (
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body" &&
      evaluatedLhs.$.pathCollection
    ) {
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
    rhs = evaluateExpression({
      expr: rhs,
      env,
      context: {
        ...context,
        expectedType: { type: expectedType, env },
      },
    });

    if (!rhs.$) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Failed to evaluate right-hand side of assignment: ${exprToString(rhs)}`,
      });
    }
    env = rhs.$.env;

    // Check if the RHS variable has been consumed (moved)
    requireExprNotConsumed(rhs, env);

    // Disallow using implicit variables (or property access of them) as the RHS
    throwExprIsImplicitVariableError(rhs);

    setExprAsNeedsToCallDup(rhs, context);
    env = rhs.$.env;

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
    let isCompileTimeOnlyAssignment = false;
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
          if (variable.isCompileTimeOnly && variable.value?.[0]) {
            const currentValue = variable.value[0];

            // If RHS is also compile-time known, mark this as compile-time-only assignment
            if (rhs.$?.value) {
              isCompileTimeOnlyAssignment = true;
            }

            // Handle struct/tuple field assignment
            if (isStructValue(currentValue) || isTupleValue(currentValue)) {
              // Find the field index
              const structType = variable.type as StructType | TupleType;
              const fieldIndex = structType.fields.findIndex(
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
                  const newFields = [...currentValue.fields];
                  newFields[fieldIndex] = rhs.$.value;
                  const newValue = createStructValue(variable.type, newFields);

                  // Find all variables in the environment that have the same struct value
                  // and update them all to maintain reference semantics
                  const allVariables = getVariablesFromEnvByFilter(
                    env,
                    (v) => v.isCompileTimeOnly && v.value?.[0] === currentValue
                  );
                  for (const sharedVariable of allVariables) {
                    env = updateExistingVariable(env, sharedVariable, {
                      ...sharedVariable,
                      value: [newValue],
                    });
                  }
                } else {
                  // Value semantics - only update the specific variable
                  const newFields = [...currentValue.fields];
                  newFields[fieldIndex] = rhs.$.value;

                  let newValue: StructValue | TupleValue;
                  if (isStructValue(currentValue)) {
                    newValue = createStructValue(
                      structType as StructType,
                      newFields
                    );
                  } else {
                    newValue = createTupleValue(
                      structType as TupleType,
                      newFields
                    );
                  }

                  // Update only this variable
                  env = updateExistingVariable(env, variable, {
                    ...variable,
                    value: [newValue],
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
                  value: [newValue],
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
                const fieldIndex = (selectedVariant.fields ?? []).findIndex(
                  (element) => element.label === fieldOrIndex
                );

                if (fieldIndex >= 0 && rhs.$?.value) {
                  // Create a new enum value with the updated field
                  const newFields = [...currentValue.fields];
                  newFields[fieldIndex] = rhs.$.value;

                  const newValue = createEnumValue(
                    enumType,
                    currentValue.variantName,
                    newFields
                  );

                  // Value semantics - only update the specific variable
                  env = updateExistingVariable(env, variable, {
                    ...variable,
                    value: [newValue],
                  });
                }
              }
            }
          }
        }
      }
    }

    // Handle compile-time pointer dereference assignment (y.* = value)
    // Check if the LHS expression has a ptrTargetValue (set by property_access.ts)
    const ptrTargetValue = (evaluatedLhs.$ as { ptrTargetValue?: [Value] })
      .ptrTargetValue;
    const ptrTargetIndex =
      (evaluatedLhs.$ as { ptrTargetIndex?: number }).ptrTargetIndex ?? 0;
    if (ptrTargetValue && rhs.$?.value) {
      // Update the value - if targetValue[0] is an ArrayValue, update its element
      // Otherwise, update targetValue[0] directly
      const target = ptrTargetValue[0];
      if (isArrayValue(target)) {
        target.elements[ptrTargetIndex] = rhs.$.value;
      } else {
        ptrTargetValue[0] = rhs.$.value;
      }
      // Both LHS (pointer dereference) and RHS are compile-time known,
      // so this assignment should not generate any runtime code
      isCompileTimeOnlyAssignment = true;
    }

    // Handle compile-time array/slice element assignment (arr(0) = value or s(0) = value)
    // Check if the LHS expression has an arrayElementRef (set by function.ts for array/slice indexing)
    const arrayElementRef = evaluatedLhs.$.arrayElementRef;
    if (arrayElementRef && rhs.$?.value) {
      // Update the element in the source array directly
      arrayElementRef.arrayValue.elements[arrayElementRef.index] = rhs.$.value;
      // Both LHS (array element) and RHS are compile-time known
      isCompileTimeOnlyAssignment = true;
    }

    // Attach the updated env to expr
    expr.$ = {
      // NOTE: This should return the original value of lhs
      env,
      value: evaluatedLhs.$.value,
      type: evaluatedLhs.$.type,
      pathCollection: [],
      isCompileTimeOnlyAssignment,
    };

    // This temp variable is used to hold the old value of lhs
    // Skip attaching temp variable for compile-time only assignments
    if (!isCompileTimeOnlyAssignment) {
      attachTempVariableToExpr(expr, true);
    }

    // Update the lhs with the new value
    // Let's not set evaluatedLhs.$ as it is causing problem in C codegen.
    // evaluatedLhs.$ = {
    //   env,
    //   type: expectedType, // NOTE: It shouldn't be the rhsType.
    //   value: rhs.$?.value,
    //   pathCollection: evaluatedLhs.$.pathCollection,
    // };
    // Return the updated expression
    return expr;
  }
}
