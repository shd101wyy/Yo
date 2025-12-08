import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  Expr,
  exprIsFunctionCall,
  exprToString,
  FuncCallExpr,
  replaceFuncCallExprWithFuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  isArrayType,
  isSomeType,
  isTupleType,
  typeContainsRefType,
} from "../../types";
import { VUnit } from "../../unit-value";
import { isNumberValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Generate ___drop function for a tuple type that contains ARC values
 */

function generateTupleDropCall(tupleExpr: Expr): string {
  if (!tupleExpr.$?.type || !isTupleType(tupleExpr.$.type)) {
    throw formatErrorMessage({
      token: tupleExpr.token,
      errorMessage: `Expected tuple type for drop generation:\n${exprToString(
        tupleExpr
      )}`,
    });
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
  const fieldsNeedingDrop = tupleType.fields
    .map((element, index) => ({
      index,
      element,
      needsDrop: typeContainsRefType(element.type),
    }))
    .filter(({ needsDrop }) => needsDrop);

  if (fieldsNeedingDrop.length === 0) {
    return ""; // No elements need dropping
  }

  // Destructure the tuple and drop each ARC-containing element
  const dropCalls = fieldsNeedingDrop
    .map(
      ({ index }) =>
        `${BuiltinFunctions.___drop[0]!}(${tupleExpr.$!.variableName}.${index})`
    )
    .join(",\n  ");

  return `begin(
  ${dropCalls}
)`;
}

/**
 * Generate ___drop function for an array type that contains ARC values
 */
function generateArrayDropCall(arrayExpr: Expr): string {
  if (!arrayExpr.$?.type || !isArrayType(arrayExpr.$.type)) {
    throw formatErrorMessage({
      token: arrayExpr.token,
      errorMessage: `Expected array type for drop generation:\n${exprToString(
        arrayExpr
      )}`,
    });
  }
  if (!arrayExpr.$.variableName) {
    throw formatErrorMessage({
      token: arrayExpr.token,
      errorMessage: `Expected variable name for drop generation:\n${exprToString(
        arrayExpr
      )}`,
    });
  }

  const arrayType = arrayExpr.$.type;
  const childType = arrayType.childType;

  if (!typeContainsRefType(childType)) {
    return ""; // No elements need dropping
  }

  const arrayLengthValue = arrayType.length;
  if (!isNumberValue(arrayLengthValue)) {
    // Not specialized yet, so we just skip for now
    return "";
  }
  const arrayLength = arrayLengthValue.value;
  const dropCalls: string[] = [];
  for (let i = 0; i < arrayLength; i++) {
    dropCalls.push(
      `${BuiltinFunctions.___drop[0]!}(${arrayExpr.$.variableName}(${i}))`
    );
  }

  return `begin(
  ${dropCalls.join(",\n  ")}
)`;
}

/**
 * ___drop function - handles both struct and tuple types with ARC management
 */
export function evaluateDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.___drop, 1);

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

  // Check if there is `.___drop` method available to call or if it's a tuple needing drop
  if (
    !isSomeType(evaluatedArgExpr.$.type) &&
    typeContainsRefType(evaluatedArgExpr.$.type)
  ) {
    // Handle tuple types specially since they don't have methods
    if (isTupleType(evaluatedArgExpr.$.type)) {
      const tupleDropCode = generateTupleDropCall(evaluatedArgExpr);
      if (tupleDropCode) {
        const tupleDropExpr = generateExprFromCode(
          tupleDropCode
        ) as FuncCallExpr;

        // Set the expression as consumed
        env = setExprAsConsumed(evaluatedArgExpr, env, true);

        // Evaluate the generated tuple drop expression
        const evaluatedTupleDropExpr = evaluateExpression({
          expr: tupleDropExpr,
          env,
          context: { ...context },
        });

        if (exprIsFunctionCall(evaluatedTupleDropExpr)) {
          replaceFuncCallExprWithFuncCallExpr(expr, evaluatedTupleDropExpr);
          return expr;
        } else {
          return evaluatedTupleDropExpr;
        }
      } else {
        // No ARC elements in tuple, just consume and return unit
        env = setExprAsConsumed(evaluatedArgExpr, env, true);
        expr.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          pathCollection: [],
        };
        return expr;
      }
    }
    // Handle array types specially since they don't have methods
    else if (isArrayType(evaluatedArgExpr.$.type)) {
      const arrayDropCode = generateArrayDropCall(evaluatedArgExpr);
      if (arrayDropCode) {
        const arrayDropExpr = generateExprFromCode(
          arrayDropCode
        ) as FuncCallExpr;

        // Set the expression as consumed
        env = setExprAsConsumed(evaluatedArgExpr, env, true);

        // Evaluate the generated array drop expression
        const evaluatedArrayDropExpr = evaluateExpression({
          expr: arrayDropExpr,
          env,
          context: { ...context },
        });

        if (exprIsFunctionCall(evaluatedArrayDropExpr)) {
          replaceFuncCallExprWithFuncCallExpr(expr, evaluatedArrayDropExpr);
          return expr;
        } else {
          return evaluatedArrayDropExpr;
        }
      }
      // NOTE: The drop on array should be handled by the codegen.
      else {
        // No ARC elements in array, just consume and return unit
        env = setExprAsConsumed(evaluatedArgExpr, env, true);
        expr.$ = {
          env,
          type: VUnit.type,
          value: VUnit,
          pathCollection: [],
        };
        return expr;
      }
    } else {
      // Handle struct types and other types with ___drop methods
      const dropMethodCallExpr = generateExprFromCode(
        `(${exprToString(evaluatedArgExpr)}).___drop()`
      ) as FuncCallExpr;

      // Convert this ___drop(x) to x.___drop() and evaluate the function call
      // NOTE: We consume AFTER the method call to avoid "use of moved value" errors
      // when the method call needs to access the variable
      const evaluatedDropMethodCallExpr = evaluateFunctionCall({
        env,
        context: { ...context },
        expr: dropMethodCallExpr,
      });

      // Set the expression as consumed AFTER the drop method call succeeds
      if (evaluatedDropMethodCallExpr.$?.env) {
        env = setExprAsConsumed(
          evaluatedArgExpr,
          evaluatedDropMethodCallExpr.$.env,
          true
        );
      } else {
        env = setExprAsConsumed(evaluatedArgExpr, env, true);
      }

      // Replace the original expr with the evaluated drop method call
      if (exprIsFunctionCall(evaluatedDropMethodCallExpr)) {
        // Update the env in the result
        if (evaluatedDropMethodCallExpr.$) {
          evaluatedDropMethodCallExpr.$.env = env;
        }
        replaceFuncCallExprWithFuncCallExpr(expr, evaluatedDropMethodCallExpr);
        return expr;
      } else {
        // In theory we shouldn't enter here
        return evaluatedDropMethodCallExpr;
      }
    }
  } else {
    // Set the expression as consumed
    env = setExprAsConsumed(evaluatedArgExpr, env, true);

    // TODO: Handle calling drop function.
    // In theory, the Free values will be ignored.

    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  }
}
