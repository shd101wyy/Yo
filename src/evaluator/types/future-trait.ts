import { getVariablesFromEnv, type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import {
  createEffectsRowSomeType,
  createTraitType,
  getFunctionParameterExprs,
} from "../../types/creators";
import type { FunctionImplicitParameter, Type } from "../../types/definitions";
import {
  isEffectsRowType,
  isModuleType,
  isSomeType,
  isTypeHierarchyType,
} from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";
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
  const effects: FunctionImplicitParameter[] = [];
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
 * Handles both `...(E)` spread expressions and individual effect types like `Raise`.
 */
function resolveEffectArg(
  effectExpr: Expr,
  env: Environment,
  context: EvaluatorContext
): { effect: FunctionImplicitParameter; env: Environment } {
  // Check if this is a spread expression ...(E)
  if (
    exprIsFunctionCall(effectExpr) &&
    exprIsFunctionCallOf(effectExpr, "...") &&
    effectExpr.args.length === 1 &&
    exprIsAtom(effectExpr.args[0]!)
  ) {
    return resolveEffectRowSpread(effectExpr, env);
  }

  // Otherwise: evaluate as an individual effect type (e.g. Raise, Log)
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

  const effect: FunctionImplicitParameter = {
    label,
    type: effectType,
    isCompileTimeOnly: true as const,
    isImplicit: true as const,
    isEffectRowSpread: false,
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
 * Resolve an effect row spread `...(E)` from the environment.
 */
function resolveEffectRowSpread(
  effectExpr: FnCallExpr,
  env: Environment
): { effect: FunctionImplicitParameter; env: Environment } {
  const rowVarName = effectExpr.args[0]!.token.value;

  // Look up E in the environment
  const rowVarVariables = getVariablesFromEnv(env, rowVarName);
  const rowVarVariable = rowVarVariables.at(-1);
  if (!rowVarVariable) {
    throw formatErrorMessage({
      token: effectExpr.token,
      errorMessage: `Effect row variable "${rowVarName}" not found in scope. Declare it with forall(..., ...(${rowVarName}))`,
    });
  }

  // Extract the type for the effect row variable
  const eValue = rowVarVariable.value?.[0];
  let rowType: Type;

  if (eValue && isTypeValue(eValue)) {
    // E must be a SomeType (abstract effect row) or EffectsRowType (concrete bound row)
    if (
      (isSomeType(eValue.value) && eValue.value.isEffectsRow) ||
      isEffectsRowType(eValue.value)
    ) {
      rowType = eValue.value;
    } else {
      throw formatErrorMessage({
        token: effectExpr.token,
        errorMessage: `"...(${rowVarName})" requires "${rowVarName}" to be a forall-declared effect row variable, but it resolves to a concrete type. Use individual effect types directly instead of spreading them, e.g. Future(T, ${rowVarName}) instead of Future(T, ...(${rowVarName}))`,
      });
    }
  } else if (
    eValue &&
    isUnknownValue(eValue) &&
    isEffectsRowType(eValue.type)
  ) {
    // E was bound to a concrete EffectsRowType during synthesis
    rowType = eValue.type;
  } else if (
    eValue &&
    isUnknownValue(eValue) &&
    isSomeType(eValue.type) &&
    eValue.type.isEffectsRow
  ) {
    // E is an UnknownValue with a SomeType that's an effect row
    rowType = eValue.type;
  } else if (
    eValue &&
    isUnknownValue(eValue) &&
    isTypeHierarchyType(eValue.type)
  ) {
    // Re-evaluation context: E is an UnknownValue with Type(1) kind.
    // Re-create the effect row SomeType for this re-evaluation.
    rowType = createEffectsRowSomeType(rowVarName, env);
  } else {
    throw formatErrorMessage({
      token: effectExpr.token,
      errorMessage: `Effect row variable "${rowVarName}" has invalid value. Expected a type.`,
    });
  }

  const effect: FunctionImplicitParameter = {
    label: rowVarName,
    type: rowType,
    isCompileTimeOnly: true as const,
    isImplicit: true as const,
    isEffectRowSpread: true,
    isQuote: false,
    isOwningTheRcValue: false,
    exprs: getFunctionParameterExprs({
      expr: effectExpr,
      labelExpr: effectExpr.args[0],
      typeExpr: effectExpr.args[0]!,
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
  if (isModuleType(effectType) && effectType.typeName) {
    return effectType.typeName;
  }
  if (isSomeType(effectType) && effectType.name) {
    return effectType.name;
  }
  // Fallback: use the expression text
  return exprToString(effectExpr);
}
