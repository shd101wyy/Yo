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
  setExprAsConsumed,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import { isArrayType, isSomeType, isTupleType } from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { isNumberValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsFuture } from "../trait-checking";

/**
 * Generate ___drop function for a tuple type that contains ARC values
 */

function generateTupleDropCall(tupleExpr: Expr): string {
  if (!tupleExpr.$?.type || !isTupleType(tupleExpr.$.type)) {
    throw formatErrorMessage({
      token: tupleExpr.token,
      errorMessage: `Expected tuple type for drop generation:\n${exprToString(tupleExpr)}`,
    });
  }
  if (!tupleExpr.$.variableName) {
    throw formatErrorMessage({
      token: tupleExpr.token,
      errorMessage: `Expected variable name for drop generation:\n${exprToString(tupleExpr)}`,
    });
  }

  const tupleType = tupleExpr.$.type;
  const fieldsNeedingDrop = tupleType.fields
    .map((element, index) => ({
      index,
      element,
      needsDrop: typeContainsRcType(
        isSomeType(element.type) && element.type.resolvedConcreteType
          ? element.type.resolvedConcreteType
          : element.type
      ),
    }))
    .filter(({ needsDrop }) => needsDrop);

  if (fieldsNeedingDrop.length === 0) {
    return ""; // No elements need dropping
  }

  // Use __yo_drop_tuple_element builtin to drop elements directly without borrowing
  // This is necessary because tuple.0 creates a borrowed reference which can't be dropped
  const dropCalls = fieldsNeedingDrop
    .map(
      ({ index }) =>
        `${BuiltinFunctions.__yo_drop_tuple_element[0]!}(${tupleExpr.$!.variableName}, ${index})`
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
      errorMessage: `Expected array type for drop generation:\n${exprToString(arrayExpr)}`,
    });
  }
  if (!arrayExpr.$.variableName) {
    throw formatErrorMessage({
      token: arrayExpr.token,
      errorMessage: `Expected variable name for drop generation:\n${exprToString(arrayExpr)}`,
    });
  }

  const arrayType = arrayExpr.$.type;
  const childType = arrayType.childType;

  const concreteChildType =
    isSomeType(childType) && childType.resolvedConcreteType
      ? childType.resolvedConcreteType
      : childType;

  if (!typeContainsRcType(concreteChildType)) {
    return ""; // No elements need dropping
  }

  const arrayLengthValue = arrayType.length;
  if (!isNumberValue(arrayLengthValue)) {
    // Not specialized yet, so we just skip for now
    return "";
  }
  const arrayLength = arrayLengthValue.value;
  const dropCalls: string[] = [];

  // Use __yo_drop_array_element builtin to drop elements directly without borrowing
  // This is necessary because y(0) creates a borrowed reference which can't be dropped
  for (let i = 0; i < arrayLength; i++) {
    dropCalls.push(
      `${BuiltinFunctions.__yo_drop_array_element[0]!}(${arrayExpr.$.variableName}, ${i})`
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.___drop, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.___drop[0]}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  const variableName = evaluatedArgExpr.$?.variableName;
  if (!variableName) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected variable name as argument to "${BuiltinFunctions.___drop[0]}":\n${exprToString(
        evaluatedArgExpr
      )}\n\nOriginal expression:\n${exprToString(argExpr)}`,
    });
  }

  const argType = evaluatedArgExpr.$.type;

  // For Impl(Future(T)), do NOT unwrap resolvedConcreteType
  // The state machine is ref-counted and uses __yo_sometype_drop
  // which is generated for SomeType in addRcFunctionsToSomeType
  const shouldUseConcreteType =
    isSomeType(argType) &&
    argType.resolvedConcreteType &&
    !typeImplementsFuture(argType);
  const concreteType = shouldUseConcreteType
    ? argType.resolvedConcreteType!
    : argType;

  // Check if there is `.___drop` method available to call or if it's a tuple/array needing drop
  if (typeContainsRcType(concreteType)) {
    // Handle tuple types specially since they don't have methods
    if (isTupleType(concreteType)) {
      const tupleDropCode = generateTupleDropCall(evaluatedArgExpr);
      if (tupleDropCode) {
        const tupleDropExpr = generateExprFromCode(tupleDropCode) as FnCallExpr;

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
    else if (isArrayType(concreteType)) {
      const arrayDropCode = generateArrayDropCall(evaluatedArgExpr);
      if (arrayDropCode) {
        const arrayDropExpr = generateExprFromCode(arrayDropCode) as FnCallExpr;

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
    }
    // This could happen during function definition validation
    // In that case, we skip generating the drop call here
    else if (isSomeType(concreteType) && !typeImplementsFuture(concreteType)) {
      env = setExprAsConsumed(evaluatedArgExpr, env, true);
      expr.$ = {
        env,
        type: VUnit.type,
        value: undefined,
        pathCollection: [],
      };
      return expr;
    } else {
      // Handle struct types and other types with ___drop methods
      const dropMethodCallExpr = generateExprFromCode(
        `(${exprToString(evaluatedArgExpr)}).___drop()`
      ) as FnCallExpr;

      // Convert this ___drop(x) to x.___drop() and evaluate the function call
      // NOTE: We consume AFTER the method call to avoid "use of moved value" errors
      // when the method call needs to access the variable
      const evaluatedDropMethodCallExpr = evaluateFunctionCall({
        env,
        context: { ...context },
        expr: dropMethodCallExpr,
      });

      if (!evaluatedDropMethodCallExpr.$?.env) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to get updated environment after evaluating "${BuiltinFunctions.___drop[0]}" method call:\n${exprToString(
            dropMethodCallExpr
          )}`,
        });
      }

      // Set the expression as consumed AFTER the drop method call succeeds

      const variables = getVariablesFromEnv(
        evaluatedDropMethodCallExpr.$.env,
        variableName
      );
      const variable = variables.at(-1);
      if (!variable) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Variable "${variableName}" not found in environment after evaluating "${BuiltinFunctions.___drop[0]}" method call:\n${exprToString(
            dropMethodCallExpr
          )}`,
        });
      }
      const nextEnv = updateExistingVariable(
        evaluatedDropMethodCallExpr.$.env,
        variable,
        {
          ...variable,
          consumedAtToken: expr.token,
        }
      );

      evaluatedDropMethodCallExpr.$.env = nextEnv;
      return evaluatedDropMethodCallExpr;
    }
  } else {
    // Set the expression as consumed
    env = setExprAsConsumed(evaluatedArgExpr, env, true);

    // TODO: Handle calling drop function.
    // In theory, the Free values will be ignored.

    expr.$ = {
      env,
      type: VUnit.type,
      value: undefined,
      pathCollection: [],
    };
    return expr;
  }
}
