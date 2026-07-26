import { addWhereClauseConstraintToEnv, type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { TraitType } from "../../types/definitions";
import { isSomeType, isTraitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { typeImplementsTraitBool } from "../trait-checking";
import { evaluateExpression } from "./expr";

/*

    use_id :: 
      (fn(
        generic(T : Type),
        value : T,
        using(IdInstance : (T <: Id))
      ) -> value) {
      return IdInstance.id(value);
    };

    Here T <: Id means that T is a subtype of Id, which is a type that has an id method.
 */
export function evaluateSubtypeOf({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, "<:", 2);
  const lhsExpr = expr.args[0]!;
  const rhsExpr = expr.args[1]!;

  // Evaluate the lhsExpr
  const evaluatedLhs = evaluateExpression({
    expr: lhsExpr,
    env,
    context: {
      ...context,
    },
  });

  // Expect the lhs to be a type
  if (
    !evaluatedLhs.$ ||
    !evaluatedLhs.$.value ||
    !isTypeValue(evaluatedLhs.$.value)
  ) {
    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `Expected type for left-hand side expression.`,
    });
  }
  env = evaluatedLhs.$.env;
  const typeValue = evaluatedLhs.$.value;

  // In a where clause, the LHS must be a SomeType (type parameter)
  if (context.isInsideWhereClause && !isSomeType(typeValue.value)) {
    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `In a where clause, the left-hand side of <: must be a type parameter (SomeType), got: ${exprToString(lhsExpr)} of type ${typeToString(typeValue.value)}`,
    });
  }

  // Collect trait expressions to process
  // Support both single trait and tuple of traits: T <: Trait or T <: (Trait1, Trait2)
  // Also support negated traits: T <: !(Trait) meaning T must NOT implement Trait
  const traitExprs: { expr: typeof rhsExpr; isNegated: boolean }[] = [];
  if (
    exprIsFunctionCall(rhsExpr) &&
    exprIsFunctionCallOf(rhsExpr, BuiltinKeywords.tuple)
  ) {
    // Tuple form: (Trait1, Trait2, ...)
    for (const traitExpr of rhsExpr.args) {
      // Check if this is a negated trait: !(Trait)
      if (
        exprIsFunctionCall(traitExpr) &&
        exprIsFunctionCallOf(traitExpr, "!") &&
        traitExpr.args.length === 1
      ) {
        traitExprs.push({ expr: traitExpr.args[0]!, isNegated: true });
      } else {
        traitExprs.push({ expr: traitExpr, isNegated: false });
      }
    }
  } else {
    // Single trait form - check if negated
    if (
      exprIsFunctionCall(rhsExpr) &&
      exprIsFunctionCallOf(rhsExpr, "!") &&
      rhsExpr.args.length === 1
    ) {
      traitExprs.push({ expr: rhsExpr.args[0]!, isNegated: true });
    } else {
      traitExprs.push({ expr: rhsExpr, isNegated: false });
    }
  }

  // Process each trait
  const traitTypes: {
    traitType: TraitType;
    expr: typeof rhsExpr;
    isNegated: boolean;
  }[] = [];
  for (const { expr: traitExpr, isNegated } of traitExprs) {
    const evaluatedRhs = evaluateExpression({
      expr: traitExpr,
      env,
      context: {
        ...context,
      },
    });

    // Expect the rhs to be a trait type
    if (
      !evaluatedRhs.$ ||
      !evaluatedRhs.$.value ||
      !isTypeValue(evaluatedRhs.$.value) ||
      !isTraitType(evaluatedRhs.$.value.value)
    ) {
      throw formatErrorMessage({
        token: traitExpr.token,
        errorMessage: `Expected trait type for right-hand side expression.`,
      });
    }
    env = evaluatedRhs.$.env;
    const traitType = evaluatedRhs.$.value.value;

    if (traitType.receiverType) {
      throw formatErrorMessage({
        token: traitExpr.token,
        errorMessage: `Expected trait type already has a receiver type assigned.`,
      });
    }

    // Negated constraints are only allowed in where clauses
    if (isNegated && !context.isInsideWhereClause) {
      throw formatErrorMessage({
        token: traitExpr.token,
        errorMessage: `Negated trait constraints !(Trait) are only allowed in where clauses.`,
      });
    }

    traitTypes.push({ traitType, expr: traitExpr, isNegated });
  }

  // In a where clause, attach the trait constraints to the current env frame
  if (context.isInsideWhereClause && isSomeType(typeValue.value)) {
    const someType = typeValue.value;
    for (const { traitType, isNegated } of traitTypes) {
      // Create a copy of the trait with receiverType set to the someType
      const traitWithReceiver: TraitType = {
        ...traitType,
        receiverType: someType,
      };

      env = addWhereClauseConstraintToEnv({
        env,
        someType,
        traitType: traitWithReceiver,
        isNegated,
      });
    }

    // Return the original typeValue (the SomeType itself)
    expr.$ = {
      env,
      value: typeValue,
      type: typeValue.type,
      pathCollection: [],
    };
    return expr;
  }

  // Non-where clause case: only single trait is allowed
  if (traitTypes.length > 1) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Multiple trait constraints (tuple form) are only allowed in where clauses.`,
    });
  }

  const { traitType } = traitTypes[0]!;
  const targetType = typeValue.value;

  // Verify that the LHS type actually implements the RHS trait
  // Skip this check for SomeType (type parameters) as they are checked at instantiation time
  if (!isSomeType(targetType)) {
    if (!typeImplementsTraitBool({ targetType, traitType, env })) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Type "${typeToString(targetType)}" does not implement trait "${traitType.typeName ?? typeToString(traitType)}".`,
      });
    }
  }

  /// Override the assigned value of the This element with the typeValue.
  const newTraitType: TraitType = {
    ...traitType,
    receiverType: typeValue.value, // Set the subtype to the typeValue
  };
  const newTraitTypeValue = createTypeValue(newTraitType);

  expr.$ = {
    env,
    value: newTraitTypeValue,
    type: newTraitTypeValue.type,
    pathCollection: [],
  };
  return expr;
}
