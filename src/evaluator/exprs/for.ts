import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import {
  createUsizeType,
  isArrayType,
  isUnitType,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  createNumberValue,
  createUnknownValue,
  isArrayValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";
import { evaluateBeginExpression } from "./begin";

/**
 * For loop
 *
 * for <Array value>, <element value> => body
 * for <Array value>, (<element value>,) => body
 * for <Array value>, (<element value>, <element index>) => body
 */
export function evaluateFor({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.for, 2);
  expectExprToBeFunctionCallOf(expr.args[1]!, "=>", 2);

  const arrayValueExpr: Expr = expr.args[0]!;
  const arrowExpr: Expr = expr.args[1]!;
  if (!exprIsFunctionCall(arrowExpr)) {
    throw formatErrorMessage({
      token: arrowExpr.token,
      errorMessage: `Expected the second argument of 'for' to be =>, got:\n${exprToString(arrowExpr)}`,
    });
  }
  const bindingExpr: Expr = arrowExpr.args[0]!;
  const bodyExpr: Expr = arrowExpr.args[1]!;

  let elementVariableExpr: Expr | undefined;
  let elementIndexExpr: Expr | undefined;
  let isElementVariableMutable = false;
  if (exprIsAtom(bindingExpr)) {
    elementVariableExpr = bindingExpr;
  } else if (
    exprIsFunctionCall(bindingExpr) &&
    exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.mut)
  ) {
    isElementVariableMutable = true;
    elementVariableExpr = bindingExpr.args[0];
  } else {
    if (!exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.tuple)) {
      throw formatErrorMessage({
        token: bindingExpr.token,
        errorMessage: `Expected the binding expression to be a variable or a tuple, got:\n${exprToString(bindingExpr)}`,
      });
    }
    elementVariableExpr = bindingExpr.args[0];
    elementIndexExpr = bindingExpr.args[1];

    if (
      exprIsFunctionCall(elementVariableExpr) &&
      exprIsFunctionCallOf(elementVariableExpr, BuiltinKeywords.mut)
    ) {
      isElementVariableMutable = true;
      elementVariableExpr = elementVariableExpr.args[0];
    }
  }
  if (!elementVariableExpr) {
    throw formatErrorMessage({
      token: bindingExpr.token,
      errorMessage: `Expected the binding expression to have at least one element, got:\n${exprToString(bindingExpr)}`,
    });
  }

  // Expect the elementValueExpr to be a variable
  if (!isValidVariableName(elementVariableExpr)) {
    throw formatErrorMessage({
      token: elementVariableExpr.token,
      errorMessage: `Invalid variable name, got:\n${exprToString(
        elementVariableExpr
      )}`,
    });
  }
  // Expect the elementIndexExpr to be a variable or undefined
  if (elementIndexExpr && !isValidVariableName(elementIndexExpr)) {
    throw formatErrorMessage({
      token: elementIndexExpr.token,
      errorMessage: `Invalid variable name for element index, got:\n${exprToString(
        elementIndexExpr
      )}`,
    });
  }

  // Evaluate the arrayValue expression
  const evaluatedArrayValueExpr = context.evaluateExpression({
    expr: arrayValueExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArrayValueExpr.$) {
    throw formatErrorMessage({
      token: evaluatedArrayValueExpr.token,
      errorMessage: `Failed to evaluate the Array value expression:\n${exprToString(evaluatedArrayValueExpr)}`,
    });
  }
  env = evaluatedArrayValueExpr.$.env;

  const arrayType = evaluatedArrayValueExpr.$.type;
  if (!isArrayType(arrayType)) {
    throw formatErrorMessage({
      token: evaluatedArrayValueExpr.token,
      errorMessage: `Expected Array type for expression, got:\n${exprToString(
        evaluatedArrayValueExpr
      )}`,
    });
  }

  // Set the array value as consumed
  setExprAsConsumed(evaluatedArrayValueExpr, env, context);

  // Add the elementVariable and index to the environment
  const elementVariableName = elementVariableExpr.token.value;
  const elementIndexName = elementIndexExpr
    ? elementIndexExpr.token.value
    : undefined;
  env = pushEnvFrame(env);
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: elementVariableName,
      type: arrayType.elementType,
      isMutable: isElementVariableMutable,
      consumedAtToken: undefined,
      initializedAtToken: elementVariableExpr.token,
      isCompileTimeOnly: Boolean(evaluatedArrayValueExpr.$.value),
      isImplicit: false, // Not an implicit variable
      token: elementVariableExpr.token,
      value: undefined, // Let's set it as undefined for now, then we initialize it in the for loop body
    },
  });
  env = nextEnv;
  /// Add type information to the element variable expr
  elementVariableExpr.$ = {
    type: arrayType.elementType,
    isMutable: isElementVariableMutable,
    env,
    value: evaluatedArrayValueExpr.$.value
      ? createUnknownValue(arrayType.elementType, elementVariableName)
      : undefined,
    pathCollection: [],
  };

  if (elementIndexName) {
    // Add the element index variable to the environment
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: elementIndexName,
        type: createUsizeType(),
        isMutable: false, // The index variable is immutable
        consumedAtToken: undefined,
        initializedAtToken: elementIndexExpr!.token,
        isCompileTimeOnly: Boolean(evaluatedArrayValueExpr.$.value), // Not a compile-time only variable
        isImplicit: false, // Not an implicit variable
        token: elementIndexExpr!.token,
        value: undefined, // Let's set it as undefined for now, then we initialize it in the for loop body
      },
    });
    env = nextEnv;

    /// Add type information to the element index variable expr
    elementIndexExpr!.$ = {
      type: createUsizeType(),
      isMutable: false, // The index variable is immutable
      env,
      value: evaluatedArrayValueExpr.$.value
        ? createUnknownValue(createUsizeType(), elementIndexName) // Initialize it to 0
        : undefined,
      pathCollection: [],
    };
  }

  // Get the array value
  const arrayValue = evaluatedArrayValueExpr.$.value;
  let index = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isArrayValue(arrayValue)) {
      if (index >= arrayValue.elements.length) {
        break; // Exit the loop if we have iterated through all elements
      }
    } else if (index === 1) {
      break; // We need to evaluate the body at least once
    }

    // Update the element variable in the environment
    const elementVariables = getVariablesFromEnv(env, elementVariableName);
    const elementVariable = elementVariables[elementVariables.length - 1]!;
    env = updateExistingVariable(env, elementVariable, {
      ...elementVariable,
      consumedAtToken: undefined, // Reset consumedAtToken
      value: isArrayValue(arrayValue) ? arrayValue.elements[index]! : undefined, // Set the value to the current element
    });

    // Update the element index variable in the environment if it exists
    if (elementIndexName) {
      const elementIndexVariables = getVariablesFromEnv(env, elementIndexName);
      const elementIndexVariable =
        elementIndexVariables[elementIndexVariables.length - 1]!;
      env = updateExistingVariable(env, elementIndexVariable, {
        ...elementIndexVariable,
        consumedAtToken: undefined, // Reset consumedAtToken
        value: createNumberValue(ValueTag.Usize, index), // Set the value to the current index
      });
    }

    // Evaluate the body
    const evaluatedBodyExpr = evaluateBeginExpression({
      expr: bodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingLoopBody: env, // Indicate that we are evaluating a while loop
      },
    });
    if (!evaluatedBodyExpr.$) {
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Failed to evaluate the body expression:\n${exprToString(bodyExpr)}`,
      });
    }
    env = evaluatedBodyExpr.$.env;

    // Check if it has control flow (return, break, continue)
    const controlFlow = evaluatedBodyExpr.$.controlFlow;
    if (controlFlow) {
      if (controlFlow === "return") {
        // Guaranteed that we meet "return"
        expr.$ = {
          env: popEnvFrame(evaluatedBodyExpr.$.env),
          isMutable: evaluatedBodyExpr.$.isMutable,
          pathCollection: evaluatedBodyExpr.$.pathCollection,
          type: evaluatedBodyExpr.$.type,
          value: evaluatedBodyExpr.$.value,
          controlFlow: controlFlow,
        };
        return expr; // Return the result of the for loop
      } else if (controlFlow === "break") {
        // Break exits the loop, return unit
        expr.$ = {
          env: popEnvFrame(evaluatedBodyExpr.$.env),
          isMutable: false,
          pathCollection: [],
          type: VUnit.type,
          value: VUnit,
        };
        return expr; // Return the result of the for loop
      } else if (controlFlow === "continue") {
        index = index + 1;
        continue;
      }
    } else {
      // The for loop body should return unit
      if (!isUnitType(evaluatedBodyExpr.$.type)) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected the for loop body to return unit, but got:\n${typeToString(evaluatedBodyExpr.$.type)}`,
        });
      }
    }
    index = index + 1;
  }

  // Finish the loop
  expr.$ = {
    env: popEnvFrame(env),
    isMutable: false,
    pathCollection: [],
    type: VUnit.type,
    value: VUnit,
  };
  return expr;
}
