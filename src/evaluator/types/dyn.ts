import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  FnCallExpr,
} from "../../expr";
import {
  createDynType,
  isFunctionType,
  isTraitType,
  TraitType,
  typeToString,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { addRcFunctionsToDynType } from "./utils";

export function evaluateDynType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.Dyn);
  const traitExprs = expr.args;
  const traitTypes: TraitType[] = [];
  const negativeTraits: TraitType[] = [];

  for (let i = 0; i < traitExprs.length; i++) {
    const traitExpr = traitExprs[i]!;

    // Check if this is a negated trait: !(Trait)
    const isNegated =
      exprIsFunctionCall(traitExpr) &&
      exprIsFunctionCallOf(traitExpr, "!") &&
      traitExpr.args.length === 1;

    const actualTraitExpr = isNegated ? traitExpr.args[0]! : traitExpr;

    const evaluatedTrait = evaluateExpression({
      expr: actualTraitExpr,
      env,
      context: {
        ...context,
      },
    });

    if (
      !evaluatedTrait.$ ||
      !evaluatedTrait.$.value ||
      !isTypeValue(evaluatedTrait.$.value) ||
      !isTraitType(evaluatedTrait.$.value.value)
    ) {
      throw new Error(
        `Expected a trait type for argument ${i + 1} of 'dyn' expression.`
      );
    }
    env = evaluatedTrait.$.env;

    const traitType = evaluatedTrait.$.value.value;

    if (isNegated) {
      // Check if the traitType already exists in negativeTraits
      if (negativeTraits.some((mt) => mt.id === traitType.id)) {
        throw formatErrorMessage({
          token: actualTraitExpr.token,
          errorMessage: `Trait type ${typeToString(traitType)} is already included in negative constraints of '${BuiltinKeywords.Dyn}' expression.`,
        });
      }
      negativeTraits.push(traitType);
    } else {
      // Check if the traitType already exists in traitTypes
      if (traitTypes.some((mt) => mt.id === traitType.id)) {
        throw formatErrorMessage({
          token: actualTraitExpr.token,
          errorMessage: `Trait type ${typeToString(traitType)} is already included in '${BuiltinKeywords.Dyn}' expression.`,
        });
      }
      traitTypes.push(traitType);
    }
  }

  // Prevent having the same function names in different traitTypes
  for (let i = 0; i < traitTypes.length; i++) {
    const traitTypeA = traitTypes[i]!;
    for (let j = i + 1; j < traitTypes.length; j++) {
      const traitTypeB = traitTypes[j]!;
      for (const elementA of traitTypeA.fields) {
        for (const elementB of traitTypeB.fields) {
          if (elementA.label === elementB.label) {
            throw formatErrorMessage({
              token: expr.token,
              errorMessage: `Trait types ${typeToString(traitTypeA)} and ${typeToString(
                traitTypeB
              )} have conflicting function name '${elementA.label}' in 'dyn' expression.`,
            });
          }
        }
      }
    }
  }

  // Prevent having ___dup, ___drop, ___dispose, dispose in traitTypes
  const reservedFunctionNames = [
    BuiltinFunctions.___dup[0]!,
    BuiltinFunctions.___drop[0]!,
    BuiltinFunctions.___dispose[0]!,
    BuiltinFunctions.dispose[0]!,
  ];
  for (const traitType of traitTypes) {
    for (const element of traitType.fields) {
      if (
        reservedFunctionNames.includes(element.label) &&
        isFunctionType(element.type)
      ) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Trait type ${typeToString(
            traitType
          )} cannot have function '${element.label}' as it is reserved in 'dyn' expression.`,
        });
      }
    }
  }

  // Note: We don't check object-safety here during Dyn type creation
  // Object-safety is checked when CALLING methods on Dyn values
  // This allows traits to have any methods, but only object-safe ones are callable on Dyn

  // Create the dyn type with its own trait for ARC functions
  // Note: wrappedObjectARCTraitType is prepended to handle ARC for the wrapped object
  const dynType = createDynType(traitTypes, env, negativeTraits);

  // Add ARC functions to the dyn type's trait
  env = addRcFunctionsToDynType({
    dynType,
    env,
    context,
  });
  const dynTypeValue = createTypeValue(dynType);

  expr.$ = {
    env,
    value: dynTypeValue,
    type: dynTypeValue.type,
    pathCollection: [],
  };
  return expr;
}
