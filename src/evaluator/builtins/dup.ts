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
  FuncCallExpr,
  replaceFuncCallExprWithFuncCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  isArrayType,
  isSomeType,
  isTupleType,
  typeContainsGcType,
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
      errorMessage: `Expected variable name for drop generation:\n${exprToString(
        tupleExpr
      )}`,
    });
  }

  const tupleType = tupleExpr.$.type;
  const fieldsNeedingDup = tupleType.fields.map((element, index) => ({
    index,
    element,
    needsDup: typeContainsGcType(element.type),
  }));

  if (fieldsNeedingDup.every(({ needsDup }) => !needsDup)) {
    return ""; // No elements need duplication, return as-is
  }

  // Destructure the tuple, dup ARC elements, and reconstruct
  const dupCalls = fieldsNeedingDup
    .map(({ index, needsDup }) =>
      needsDup
        ? `${BuiltinFunctions.___dup[0]!}(${tupleExpr.$?.variableName}.${index})`
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
      errorMessage: `Expected variable name for dup generation:\n${exprToString(
        arrayExpr
      )}`,
    });
  }

  const arrayType = arrayExpr.$.type;
  const childType = arrayType.childType;

  if (!typeContainsGcType(childType)) {
    return ""; // No elements need duplication, return as-is
  }

  // Generate a new array by iterating through the original and duplicating ARC elements

  // Check if we can get the array length at compile time
  if (isNumberValue(arrayType.length)) {
    const arrayLength = (arrayType.length as NumberValue).value;
    // Generate array constructor call with duplicated elements
    return `begin(
  ${Array.from(
    { length: Number(arrayLength) },
    (_, i) =>
      `${BuiltinFunctions.___dup[0]!}(${arrayExpr.$?.variableName}(${i}))`
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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.___dup, 1);

  const argExpr = expr.args[0]!;
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
      errorMessage: `Failed to evaluate the argument expression for "drop":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if there is `.___dup` method available to call or if it's a tuple needing dup
  if (
    !isSomeType(evaluatedArgExpr.$.type) &&
    typeContainsGcType(evaluatedArgExpr.$.type)
  ) {
    // Handle tuple types specially since they don't have methods
    if (isTupleType(evaluatedArgExpr.$.type)) {
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
    } else if (isArrayType(evaluatedArgExpr.$.type)) {
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
    } else {
      // Handle struct types and other types with ___dup methods
      const dupMethodCallExpr = generateExprFromCode(
        `(${exprToString(evaluatedArgExpr)}).___dup()`
      ) as FuncCallExpr;

      // Convert this ___dup(x) to x.___dup() and evaluate the function call
      const evaluatedDupMethodCallExpr = evaluateFunctionCall({
        env,
        context: { ...context },
        expr: dupMethodCallExpr,
      });

      // Replace the original expr with the evaluated dup method call
      if (exprIsFunctionCall(evaluatedDupMethodCallExpr)) {
        replaceFuncCallExprWithFuncCallExpr(expr, evaluatedDupMethodCallExpr);

        const tempVariableName = expr.$?.variableName;
        if (expr.$ && tempVariableName) {
          // In theory, we should enter here.
          // We need to set the variable as not owning the ARC value
          // This is necessary, otherwise we will generate the ___drop function call for that temp variable
          const variables = getVariablesFromEnv(expr.$.env, tempVariableName);
          if (variables.length) {
            const variable = variables[variables.length - 1]!;
            if (variable.isOwningTheValue) {
              const nextEnv = updateExistingVariable(expr.$.env, variable, {
                ...variable,
                isOwningTheValue: false,
              });
              expr.$.env = nextEnv;
            }
          }
        }
        // NOTE: In theory, the code above is handled in expr.ts setExprAsNeedsToCallDup function
        // But let's still set it here to be safe

        return expr;
      } else {
        // In theory we shouldn't enter here
        return evaluatedDupMethodCallExpr;
      }
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
