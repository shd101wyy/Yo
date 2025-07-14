import { checkBorrowings } from "../../borrow";
import {
  Environment,
  getVariablesFromEnv,
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
  requireExprNotConsumed,
  setExprAsConsumed,
} from "../../expr";
import { setTypeValueAsLinear } from "../../type-value";
import {
  areTypesCompatible,
  createArrayType,
  EnumType,
  isArrayType,
  isEnumType,
  isFreeType,
  isLinearType,
  isTypeHierarchyType,
  Type,
  typeContainsReference,
  typeContainsUnknownValues,
  typeOfType,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  isFunctionValue,
  isModuleValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import { EvaluatorContext, trackVariableUsage } from "../context";
import { synthesizeExprAndType } from "../types/synthesizer";
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
 * Resolve unknown values in a type by looking up their resolved values in the environment
 */
function resolveUnknownValuesInType(type: Type, env: Environment): Type {
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

      requireExprNotConsumed(evaluatedLhs, env);

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

    // Set rhs as consumed
    env = setExprAsConsumed(rhs, env, context);

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
      if (typeContainsUnknownValues(variable.type)) {
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
            const resolvedVariableType = resolveUnknownValuesInType(
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
    let rhsValue = rhs.$?.value;
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

    // Check if it's assigning Free to Linear
    if (
      isTypeValue(rhsValue) &&
      isFreeType(typeOfType(rhsValue.value)) &&
      isLinearType(updatedVariable.type)
    ) {
      rhsValue = setTypeValueAsLinear(rhsValue);
    }

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
      env = updateExistingVariable(env, variable, {
        ...variable,
        initializedAtToken: lhs.token,
        value: variable.isCompileTimeOnly ? rhsValue : undefined,
        type: variableType,
        // type: rhsType,
      });
    } else if (variable.isMutable) {
      // For closures, track variable writes to outer scope
      if (
        context.isEvaluatingFunctionBody &&
        context.isEvaluatingFunctionBody.type.closureKind !== undefined &&
        context.isEvaluatingFunctionBody.evaluationEnv
      ) {
        const closureEvaluationFrameLevel =
          context.isEvaluatingFunctionBody.evaluationEnv.frames.length;

        // If variable is from an outer scope (lower frame level than closure evaluation), it's captured
        if (variable.frameLevel < closureEvaluationFrameLevel) {
          // Determine usage type based on closure kind
          const usageType =
            context.isEvaluatingFunctionBody.type.closureKind === "FnOnce"
              ? "own"
              : "write";

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
      env = updateExistingVariable(env, variable, {
        ...variable,
        value: variable.isCompileTimeOnly ? rhsValue : undefined,
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
  // x.a = 12;
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

    // Set rhs as consumed
    env = setExprAsConsumed(rhs, env, context);

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

    // Check if the rhsType contains reference
    if (typeContainsReference(rhsType)) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Assigning reference to variable is not allowed.`,
      });
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
