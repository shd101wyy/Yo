import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type Expr, type FnCallExpr } from "../../expr";
import { createTraitType } from "../../types/creators";
import type { FutureEffect, Type } from "../../types/definitions";
import { isSourceNamespaceType, isSomeType } from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Future(T)` or `Future(T, E)` syntax.
 * Creates a trait type that represents a future trait (similar to Fn trait pattern).
 *
 * Examples:
 *   Future(i32)        // future that will yield i32, no effects
 *   Future(i32, E)     // future with single effect bundle E that will yield i32
 *   Future(unit)       // future that completes without a value
 *
 * The Future trait can be used with:
 * - Impl(Future(T))    for static dispatch
 * - Impl(Future(T, E)) for static dispatch with a single effect bundle struct
 * - Dyn(Future(T))     for dynamic dispatch
 *
 * Multiple effects must be packed into a single struct (e.g.
 *   Ctx :: struct(io : Io, raise : Raise);
 *   Future(T, Ctx)
 * ) rather than passed as separate type arguments.
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
      errorMessage: `Future type constructor expects 1 or 2 arguments (output type, optional effect bundle struct).
Usage: Future(T) or Future(T, E).
To combine multiple effects, declare a struct that bundles them and pass that struct as E.`,
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

  // Optional second argument: a single effect bundle struct.
  let effect: FutureEffect | undefined;
  if (expr.args.length === 2) {
    const result = resolveEffectArg(expr.args[1]!, env, context);
    effect = result.effect;
    env = result.env;
  }

  const futureTraitType = createTraitType(env);
  futureTraitType.isFuture = { outputType, effect };

  // Canonical ID format mirrors createFutureTraitType.
  const effectSuffix = effect ? `_${effect.type.id}` : "";
  futureTraitType.id = `future_trait_${outputType.id}${effectSuffix}`;

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
 * Each effect is now an individual type (Raise, Log, IoExn, ...);
 * the legacy `...(E)` spread syntax has been removed in favour of
 * `generic(E : Type.Struct)` + `Future(T, E)`.
 */
function resolveEffectArg(
  effectExpr: Expr,
  env: Environment,
  context: EvaluatorContext
): { effect: FutureEffect; env: Environment } {
  // Evaluate as an individual effect type (e.g. Raise, Log, IoExn)
  const evaluatedExpr = evaluateExpression({
    expr: effectExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$ || !isTypeValue(evaluatedExpr.$.value)) {
    throw formatErrorMessage({
      token: effectExpr.token,
      errorMessage: `Future effect argument must be an effect type, but got:\n${exprToString(
        effectExpr
      )}`,
    });
  }

  const effectType = evaluatedExpr.$.value.value;
  env = evaluatedExpr.$.env;

  return {
    effect: { label: getEffectLabel(effectType, effectExpr), type: effectType },
    env,
  };
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
