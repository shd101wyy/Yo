import { checkBorrowings } from "../../borrow";
import {
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
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
  EnumType,
  isEnumType,
  isFreeType,
  isLinearType,
  isTypeHierarchyType,
  typeContainsReference,
  typeOfType,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { isFunctionValue, isModuleValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { synthesizeExprAndType } from "../types/synthesizer";
import { evaluateBinding } from "./binding";
import { evaluateIdentifierAndOperator } from "./identifer_and_operator";

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

    // Set rhs as consumed
    env = setExprAsConsumed(rhs, env);

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
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Incompatible types:
- Expected: ${typeToString(variable.type)}
- Given   : ${typeToString(rhsType)}`,
      });
    }

    // Add .typeName info if necessary
    let rhsValue = rhs.$?.value;
    if (isTypeValue(rhsValue) && !rhsValue.value.typeName) {
      rhsValue.value.typeName = variableName;

      if (isTypeHierarchyType(variable.type) && !variable.type.baseType) {
        // If the variable type is a type hierarchy, set the base type
        variable.type.baseType = rhsValue.value;
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
      isLinearType(variable.type)
    ) {
      rhsValue = setTypeValueAsLinear(rhsValue);
    }

    let variableType = variable.type;
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
      // Initialize the variable
      env = updateExistingVariable(env, variable, {
        ...variable,
        initializedAtToken: lhs.token,
        value: variable.isCompileTimeOnly ? rhsValue : undefined,
        type: variableType,
        // type: rhsType,
      });
    } else if (variable.isMutable) {
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
    env = setExprAsConsumed(rhs, env);

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
