import { getVariablesFromEnv, type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import {
  createEffectsRowSomeType,
  createTraitType,
} from "../../types/creators";
import type { Type } from "../../types/definitions";
import {
  isEffectsRowType,
  isSomeType,
  isTypeHierarchyType,
} from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Future(T)` or `Future(T, ...(E))` syntax.
 * Creates a trait type that represents a future trait (similar to Fn trait pattern).
 *
 * Example:
 *   Future(i32)             // future that will yield i32
 *   Future(i32, ...(E))     // future with effect row E that will yield i32
 *   Future(unit)            // future that completes without returning a value
 *
 * This creates a trait type with `isFuture` set to the output type and optional effects row.
 *
 * The Future trait can be used with:
 * - Impl(Future(T)) for static dispatch with futures
 * - Impl(Future(T, ...(E))) for static dispatch with effects
 * - Dyn(Future(T)) for dynamic dispatch
 */
export function evaluateFutureType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (expr.args.length < 1 || expr.args.length > 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Future type constructor expects 1 or 2 arguments, got ${expr.args.length}. Usage: Future(T) or Future(T, ...(E))`,
    });
  }

  const elementTypeExpr = expr.args[0]!;

  // Evaluate element type expression
  const evaluatedElementTypeExpr = evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Failed to evaluate the element type expression for Future:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }
  env = evaluatedElementTypeExpr.$.env;

  // Check if the element type expression is a type
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Future type constructor expects a type as its first argument, but got:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }

  const outputType = evaluatedElementTypeExpr.$.value.value;

  // Handle optional second argument: ...(E) effect row
  let effectsRow: Type | undefined;
  if (expr.args.length === 2) {
    const effectsRowExpr = expr.args[1]!;

    // The second arg should be a spread expression ...(E)
    if (
      exprIsFunctionCall(effectsRowExpr) &&
      exprIsFunctionCallOf(effectsRowExpr, "...") &&
      effectsRowExpr.args.length === 1 &&
      exprIsAtom(effectsRowExpr.args[0]!)
    ) {
      const rowVarName = effectsRowExpr.args[0]!.token.value;

      // Look up E in the environment
      const rowVarVariables = getVariablesFromEnv(env, rowVarName);
      const rowVarVariable = rowVarVariables.at(-1);
      if (!rowVarVariable) {
        throw formatErrorMessage({
          token: effectsRowExpr.token,
          errorMessage: `Effect row variable "${rowVarName}" not found in scope. Declare it with forall(..., ...(${rowVarName}))`,
        });
      }

      // Extract the type for the effect row variable
      const eValue = rowVarVariable.value?.[0];
      if (eValue && isTypeValue(eValue)) {
        // E is a TypeValue wrapping a SomeType (abstract) or EffectsRowType (concrete)
        effectsRow = eValue.value;
      } else if (
        eValue &&
        isUnknownValue(eValue) &&
        isEffectsRowType(eValue.type)
      ) {
        // E was bound to a concrete EffectsRowType during synthesis
        effectsRow = eValue.type;
      } else if (
        eValue &&
        isUnknownValue(eValue) &&
        isSomeType(eValue.type) &&
        eValue.type.isEffectsRow
      ) {
        // E is an UnknownValue with a SomeType that's an effect row
        effectsRow = eValue.type;
      } else if (
        eValue &&
        isUnknownValue(eValue) &&
        isTypeHierarchyType(eValue.type)
      ) {
        // Re-evaluation context: E is an UnknownValue with Type(1) kind.
        // Re-create the effect row SomeType for this re-evaluation.
        effectsRow = createEffectsRowSomeType(rowVarName, env);
      } else {
        throw formatErrorMessage({
          token: effectsRowExpr.token,
          errorMessage: `Effect row variable "${rowVarName}" has invalid value. Expected a type.`,
        });
      }
    } else {
      // Try evaluating as a regular expression (could be a concrete EffectsRowType)
      const evaluatedEffectsRowExpr = evaluateExpression({
        expr: effectsRowExpr,
        env,
        context: { ...context },
      });
      if (
        evaluatedEffectsRowExpr.$ &&
        isTypeValue(evaluatedEffectsRowExpr.$.value)
      ) {
        effectsRow = evaluatedEffectsRowExpr.$.value.value;
        env = evaluatedEffectsRowExpr.$.env;
      } else {
        throw formatErrorMessage({
          token: effectsRowExpr.token,
          errorMessage: `Future type constructor expects ...(E) as its second argument, but got:\n${exprToString(
            effectsRowExpr
          )}`,
        });
      }
    }
  }

  // Create the Future trait type (similar to how Fn trait type is created)
  const futureTraitType = createTraitType(env);

  // Set the isFuture field with output type and optional effects row
  futureTraitType.isFuture = { outputType, effectsRow };

  // Use canonical ID format to match createFutureTraitType
  // Include effects row ID when present for uniqueness
  const effectsSuffix = effectsRow ? `_${effectsRow.id}` : "";
  futureTraitType.id = `future_trait_${outputType.id}${effectsSuffix}`;

  expr.$ = {
    env,
    type: typeOfType(futureTraitType),
    value: createTypeValue(futureTraitType),
    pathCollection: [],
  };

  return expr;
}
