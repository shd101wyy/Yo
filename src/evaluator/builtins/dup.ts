import {
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsFunctionCall,
  exprToString,
  FnCallExpr,
  replaceFuncCallExprWithFuncCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  isArrayType,
  isSomeType,
  isTupleType,
  typeContainsRcType,
  typeImplementsFuture,
} from "../../types";
import { isNumberValue, NumberValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Generate ___dup function for a tuple type that contains ARC values
 */
function generateTupleDupCall(tupleExpr: Expr): string {
  if (!tupleExpr.$?.type || !isTupleType(tupleExpr.$.type)) {
    throw new Error("Expected tuple type for dup generation");
  }
  if (!tupleExpr.$.variableName) {
    throw formatErrorMessage({
      token: tupleExpr.token,
      errorMessage: `Expected variable name for drop generation:\n${exprToString(tupleExpr)}`,
    });
  }

  const tupleType = tupleExpr.$.type;
  const fieldsNeedingDup = tupleType.fields.map((element, index) => ({
    index,
    element,
    needsDup: typeContainsRcType(element.type),
  }));

  if (fieldsNeedingDup.every(({ needsDup }) => !needsDup)) {
    return ""; // No elements need duplication, return as-is
  }

  // Use __yo_dup_tuple_element builtin to dup elements directly without borrowing
  // This is necessary because tuple.0 creates a borrowed reference which can't be duped
  const dupCalls = fieldsNeedingDup
    .map(({ index, needsDup }) =>
      needsDup
        ? `${BuiltinFunctions.__yo_dup_tuple_element[0]!}(${tupleExpr.$?.variableName}, ${index})`
        : ""
    )
    .filter((x) => x.length > 0);

  return `begin(
  ${dupCalls.join(",\n")}
)`;
}

/**
 * Generate ___dup function for an array type that contains ARC values
 */
function generateArrayDupCall(arrayExpr: Expr): string {
  if (!arrayExpr.$?.type || !isArrayType(arrayExpr.$.type)) {
    throw new Error("Expected array type for dup generation");
  }
  if (!arrayExpr.$.variableName) {
    throw formatErrorMessage({
      token: arrayExpr.token,
      errorMessage: `Expected variable name for dup generation:\n${exprToString(arrayExpr)}`,
    });
  }

  const arrayType = arrayExpr.$.type;
  const childType = arrayType.childType;

  if (!typeContainsRcType(childType)) {
    return ""; // No elements need duplication, return as-is
  }

  // Generate a new array by iterating through the original and duplicating ARC elements

  // Check if we can get the array length at compile time
  if (isNumberValue(arrayType.length)) {
    const arrayLength = (arrayType.length as NumberValue).value;
    // Generate array constructor call with duplicated elements
    // Use __yo_dup_array_element builtin to dup elements directly without borrowing
    // This is necessary because y(0) creates a borrowed reference which can't be duped
    return `begin(
  ${Array.from(
    { length: Number(arrayLength) },
    (_, i) =>
      `${BuiltinFunctions.__yo_dup_array_element[0]!}(${arrayExpr.$?.variableName}, ${i})`
  ).join(", ")}
)`;
  } else {
    return ""; // Skip for now if length is not known at compile time
  }
}

/**
 * ___dup function
 * Just evaluates the argument and returns the type of argument.
 */
export function evaluateDup({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.___dup, 1);

  const argExpr = expr.args[0]!;

  // Evaluate the argument first to get its type and variable name
  // This handles both simple variables (atoms) and complex expressions like array access
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.___dup[0]}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  const argType = evaluatedArgExpr.$.type;
  const concreteType =
    isSomeType(argType) && argType.resolvedConcreteType
      ? argType.resolvedConcreteType
      : argType;

  // Check if there is `.___dup` method available to call or if it's a tuple needing dup
  if (typeContainsRcType(concreteType)) {
    // Handle tuple types specially since they don't have methods
    if (isTupleType(concreteType)) {
      const tupleDupCode = generateTupleDupCall(evaluatedArgExpr);

      if (tupleDupCode) {
        const tupleDupExpr = generateExprFromCode(tupleDupCode);

        // Evaluate the generated tuple dup expression
        const evaluatedTupleDupExpr = evaluateExpression({
          expr: tupleDupExpr,
          env,
          context: { ...context },
        });

        if (exprIsFunctionCall(evaluatedTupleDupExpr)) {
          replaceFuncCallExprWithFuncCallExpr(expr, evaluatedTupleDupExpr);
          return expr;
        } else {
          return evaluatedTupleDupExpr;
        }
      } else {
        // No elements need duplication, return the original expression
        expr.$ = {
          env,
          type: evaluatedArgExpr.$.type,
          value: undefined,
          pathCollection: [],
        };
        return expr;
      }
    } else if (isArrayType(concreteType)) {
      // Handle array types
      const arrayDupCode = generateArrayDupCall(evaluatedArgExpr);
      if (arrayDupCode) {
        const arrayDupExpr = generateExprFromCode(arrayDupCode);

        // Evaluate the generated array dup expression
        const evaluatedArrayDupExpr = evaluateExpression({
          expr: arrayDupExpr,
          env,
          context: { ...context },
        });

        if (exprIsFunctionCall(evaluatedArrayDupExpr)) {
          replaceFuncCallExprWithFuncCallExpr(expr, evaluatedArrayDupExpr);
          return expr;
        } else {
          return evaluatedArrayDupExpr;
        }
      } else {
        // No elements need duplication, return the original expression
        expr.$ = {
          env,
          type: evaluatedArgExpr.$.type,
          value: undefined,
          pathCollection: [],
        };
        return expr;
      }
    }
    // This could happen during function definition validation
    // In that case, we skip generating the dup call here
    else if (isSomeType(concreteType) && !typeImplementsFuture(concreteType)) {
      expr.$ = {
        env,
        type: evaluatedArgExpr.$.type,
        value: undefined,
        pathCollection: [],
      };
      return expr;
    } else {
      // Handle struct types and other types with ___dup methods
      const dupMethodCallExpr = generateExprFromCode(
        `(${exprToString(evaluatedArgExpr)}).___dup()`
      ) as FnCallExpr;

      // Convert this ___dup(x) to x.___dup() and evaluate the function call
      const evaluatedDupMethodCallExpr = evaluateFunctionCall({
        env,
        context: { ...context },
        expr: dupMethodCallExpr,
      });

      const tempVariableName = evaluatedDupMethodCallExpr.$?.variableName;
      if (!tempVariableName || !evaluatedDupMethodCallExpr.$) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to evaluate the "${BuiltinFunctions.___dup[0]}" method call:\n${exprToString(
            dupMethodCallExpr
          )}`,
        });
      }

      // In theory, we should enter here.
      // We need to set the variable as not owning the ARC value
      // This is necessary, otherwise we will generate the ___drop function call for that temp variable
      const variables = getVariablesFromEnv(
        evaluatedDupMethodCallExpr.$.env,
        tempVariableName
      );
      if (variables.length) {
        const variable = variables[variables.length - 1]!;
        if (variable.isOwningTheRcValue) {
          const nextEnv = updateExistingVariable(
            evaluatedDupMethodCallExpr.$.env,
            variable,
            {
              ...variable,
              isOwningTheRcValue: false,
            }
          );
          evaluatedDupMethodCallExpr.$.env = nextEnv;
        }
      }
      return evaluatedDupMethodCallExpr;
    }
  }

  expr.$ = {
    env,
    type: evaluatedArgExpr.$.type,
    value: undefined,
    pathCollection: [],
  };
  return expr;
}
