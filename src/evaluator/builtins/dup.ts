import { checkBorrowings } from "../../borrow";
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
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { isSomeType, isTupleType, typeContainsARCType } from "../../types";
import { randomId } from "../../utils";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

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
  const elementsNeedingDup = tupleType.elements.map((element, index) => ({
    index,
    element,
    needsDup: typeContainsARCType(element.type),
  }));

  if (elementsNeedingDup.every(({ needsDup }) => !needsDup)) {
    return exprToString(tupleExpr); // No elements need duplication, return as-is
  }

  // Destructure the tuple, dup ARC elements, and reconstruct
  const id = randomId();
  const destructuring = `(${elementsNeedingDup.map(({ index }) => `_${id}_${index}`).join(", ")}${elementsNeedingDup.length === 1 ? "," : ""})`;
  const dupCalls = elementsNeedingDup.map(({ index, needsDup }) =>
    needsDup
      ? `${BuiltinFunctions.___dup[0]!}(_${id}_${index})`
      : `_${id}_${index}`
  );

  return `begin(
  ${destructuring} := ${exprToString(tupleExpr)},
  (${dupCalls.join(", ")}${dupCalls.length === 1 ? "," : ""})
)`;
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
  const evaluatedArgExpr = context.evaluateExpression({
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

  // Check if the dup argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedArgExpr);

  // Check if there is `.___dup` method available to call or if it's a tuple needing dup
  if (
    !isSomeType(evaluatedArgExpr.$.type) &&
    typeContainsARCType(evaluatedArgExpr.$.type)
  ) {
    // Handle tuple types specially since they don't have methods
    if (isTupleType(evaluatedArgExpr.$.type)) {
      const tupleDupCode = generateTupleDupCall(evaluatedArgExpr);
      const tupleDupExpr = generateExprFromCode(tupleDupCode);

      // Evaluate the generated tuple dup expression
      const evaluatedTupleDupExpr = context.evaluateExpression({
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
