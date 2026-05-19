import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type Expr, type FnCallExpr } from "../../expr";
import {
  createTraitType,
  getFunctionParameterExprs,
} from "../../types/creators";
import type { FunctionParameter, Type } from "../../types/definitions";
import { isSourceNamespaceType, isSomeType } from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Future(T, ...)` syntax.
 * Creates a trait type that represents a future trait (similar to Fn trait pattern).
 *
 * Example:
 *   Future(i32)                          // future that will yield i32
 *   Future(i32, ...(E))                  // future with effect row E that will yield i32
 *   Future(i32, Raise)                   // future with individual effect Raise
 *   Future(i32, Raise, ...(E))           // mixed: individual effect + effect row spread
 *   Future(i32, ...(E1), ...(E2))        // multiple effect row spreads
 *   Future(i32, Raise, ...(E1), Log, ...(E2))  // mixed with multiple spreads
 *   Future(unit)                         // future that completes without returning a value
 *
 * This creates a trait type with `isFuture` set to the output type and an effects array.
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
  if (expr.args.length < 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Future type constructor expects at least 1 argument (output type). Usage: Future(T), Future(T, ...(E)), Future(T, Raise, ...(E))`,
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

  // Handle effect arguments (args[1..N])
  // Each arg can be:
  //   - ...(E)  — effect row spread (resolved from forall)
  //   - Raise   — individual effect type
  const effects: FunctionParameter[] = [];
  for (let i = 1; i < expr.args.length; i++) {
    const effectExpr = expr.args[i]!;
    const result = resolveEffectArg(effectExpr, env, context);
    effects.push(result.effect);
    env = result.env;
  }

  // Create the Future trait type (similar to how Fn trait type is created)
  const futureTraitType = createTraitType(env);

  // Set the isFuture field with output type and effects array
  futureTraitType.isFuture = { outputType, effects };

  // Use canonical ID format to match createFutureTraitType
  // Include all effect IDs for uniqueness
  const effectsSuffix =
    effects.length > 0 ? `_${effects.map((e) => e.type.id).join("_")}` : "";
  futureTraitType.id = `future_trait_${outputType.id}${effectsSuffix}`;

  expr.$ = {
    env,
    type: typeOfType(futureTraitType),
    value: createTypeValue(futureTraitType),
    pathCollection: [],
  };

  return expr;
}

/**
 * Resolve a single effect argument in Future(T, ...).
 * Each effect is now an individual type (Raise, Log, IOErr, ...);
 * the legacy `...(E)` spread syntax has been removed in favour of
 * `forall(E : Type.Struct)` + `Future(T, E)`.
 */
function resolveEffectArg(
  effectExpr: Expr,
  env: Environment,
  context: EvaluatorContext
): { effect: FunctionParameter; env: Environment } {
  // Evaluate as an individual effect type (e.g. Raise, Log)
  const evaluatedExpr = evaluateExpression({
    expr: effectExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$ || !isTypeValue(evaluatedExpr.$.value)) {
    throw formatErrorMessage({
      token: effectExpr.token,
      errorMessage: `Future effect argument must be an effect type or ...(E) spread, but got:\n${exprToString(
        effectExpr
      )}`,
    });
  }

  const effectType = evaluatedExpr.$.value.value;
  env = evaluatedExpr.$.env;

  // Derive a label from the type
  const label = getEffectLabel(effectType, effectExpr);

  const effect: FunctionParameter = {
    label,
    type: effectType,
    isCompileTimeOnly: true as const,
    isQuote: false,
    isOwningTheRcValue: false,
    exprs: getFunctionParameterExprs({
      expr: effectExpr,
      labelExpr: undefined,
      typeExpr: effectExpr,
      defaultValueExpr: undefined,
      assignedValueExpr: undefined,
    }),
  };

  return { effect, env };
}

/**
 * Derive a label name for an individual effect type.
 */
function getEffectLabel(effectType: Type, effectExpr: Expr): string {
  if (isSourceNamespaceType(effectType) && effectType.typeName) {
    return effectType.typeName;
  }
  if (isSomeType(effectType) && effectType.name) {
    return effectType.name;
  }
  // Fallback: use the expression text
  return exprToString(effectExpr);
}
