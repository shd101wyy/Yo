/**
 * derive_rule(TraitConstructor, DeriveFn) — register a custom derive rule for a trait.
 *
 * The TraitConstructor is evaluated: it must resolve to a FunctionValue (trait constructor)
 * or a TraitType. The DeriveFn is a comptime function with signature:
 *   fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
 *
 * The rule is stored on the FunctionValue (for parameterized traits like Eq(T))
 * or TraitType (for parameterless traits).
 */

import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { isFunctionValue, isTypeValue } from "../../value";
import { isTraitType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateDeriveRule({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.derive_rule, 2);

  // Evaluate first argument: the trait constructor
  const traitArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!traitArg.$) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `derive_rule: failed to evaluate trait argument: ${exprToString(expr.args[0]!)}`,
    });
  }
  env = traitArg.$.env;

  // Evaluate second argument: the derive function
  const deriveFnArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: { ...context },
  });

  if (!deriveFnArg.$) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `derive_rule: failed to evaluate derive function: ${exprToString(expr.args[1]!)}`,
    });
  }
  env = deriveFnArg.$.env;

  if (!isFunctionValue(deriveFnArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `derive_rule: second argument must be a function, got: ${exprToString(expr.args[1]!)}`,
    });
  }

  const deriveFn = deriveFnArg.$.value;

  // Store the derive rule on the trait constructor or trait type
  // Case 1: FunctionValue (parameterized trait constructor like Eq, Hash)
  if (isFunctionValue(traitArg.$.value)) {
    traitArg.$.value.deriveRule = deriveFn;
  }
  // Case 2: TraitType (parameterless trait)
  else if (isTraitType(traitArg.$.type)) {
    traitArg.$.type.deriveRule = deriveFn;
  }
  // Case 3: TypeValue containing a TraitType
  else if (
    isTypeValue(traitArg.$.value) &&
    isTraitType(traitArg.$.value.value)
  ) {
    traitArg.$.value.value.deriveRule = deriveFn;
  } else {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `derive_rule: first argument must be a trait constructor or trait type, got: ${exprToString(expr.args[0]!)}`,
    });
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
