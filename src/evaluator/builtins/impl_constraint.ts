import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  createSomeType,
  createType0,
  isConcreteTraitType,
  isTraitType,
  TraitType,
  Type,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Impl(Trait1, Trait2, ...)` syntax.
 * Creates a SomeType whose trait contains the given trait constraints.
 * Supports negated traits with `!(Trait)` syntax.
 * Supports Concrete(T) to explicitly set resolvedConcreteType.
 *
 * Example:
 *   Id :: trait(id : (fn(self : Self) -> Self));
 *   ImplId :: Impl(Id);
 *   ImplIdNotCopy :: Impl(Id, !(Copy));  // Must implement Id but NOT Copy
 *
 *   // Explicit concrete type for extern futures:
 *   extern "Yo", yo_io_future : Type;
 *   IOReadFuture :: Impl(Concrete(yo_io_future), Future(i32));
 *
 * ImplId is a SomeType that requires types to implement the Id trait.
 */
export function evaluateImplConstraint({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Impl)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "Impl", got:\n${exprToString(expr)}`,
    });
  }

  if (expr.args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Impl requires at least one trait argument.`,
    });
  }

  const requiredTraits: TraitType[] = [];
  const negativeTraits: TraitType[] = [];
  let concreteType: Type | undefined = undefined;

  // Evaluate each argument and expect them to be trait types
  // Support negated modules with !(Module) syntax
  // Support Concrete(T) to set resolvedConcreteType
  for (const arg of expr.args) {
    // Check if this is a negated trait: !(Module)
    const isNegated =
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, "!") &&
      arg.args.length === 1;

    const moduleExpr = isNegated ? arg.args[0]! : arg;

    const evaluatedArg = evaluateExpression({
      expr: moduleExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Failed to evaluate Impl argument.`,
      });
    }
    env = evaluatedArg.$.env;

    // Expect the argument to be a type value containing a trait type
    if (
      !evaluatedArg.$.value ||
      !isTypeValue(evaluatedArg.$.value) ||
      !isTraitType(evaluatedArg.$.value.value)
    ) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Impl argument must be a trait type, got: ${exprToString(moduleExpr)}`,
      });
    }

    const moduleType = evaluatedArg.$.value.value;

    // Check if this is a Concrete(T) trait - extract the concrete type
    if (isConcreteTraitType(moduleType)) {
      if (concreteType !== undefined) {
        throw formatErrorMessage({
          token: moduleExpr.token,
          errorMessage: `Impl can only have one Concrete(T) specifier`,
        });
      }
      concreteType = moduleType.isConcrete.concreteType;
      // Don't add Concrete to requiredTraits - it's just a marker
      continue;
    }

    if (isNegated) {
      negativeTraits.push(moduleType);
    } else {
      requiredTraits.push(moduleType);
    }
  }

  // Create a SomeType with the required and negative modules
  const someType = createSomeType(
    createType0(),
    "Impl", // Name for the SomeType
    { requiredTraits, negativeTraits }
  );

  // If Concrete(T) was specified, set the resolvedConcreteType
  if (concreteType !== undefined) {
    someType.resolvedConcreteType = concreteType;
  }

  const typeValue = createTypeValue(someType);

  expr.$ = {
    env,
    type: typeValue.type,
    value: typeValue,
    pathCollection: [],
  };

  return expr;
}
