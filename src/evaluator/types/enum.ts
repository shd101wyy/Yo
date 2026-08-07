import { type Environment, getVariablesFromEnv } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { createEnumType } from "../../types/creators";
import type { EnumVariant, Type, TypeField } from "../../types/definitions";
import { isComptimeIntType } from "../../types/guards";
import { createTypeValue, isComptimeIntValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";
import { evaluateTypeField } from "./field";
import {
  addRcFunctionSignaturesToEnumType,
  autoDeriveTraitsAndAddRcFunctionsForEnumType,
} from "./utils";

export function evaluateEnumType({
  expr,
  env,
  context,
  forceReferenceSemantics = false,
  isAtomicRc = false,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  // `ref(enum(…))` / `atomic(ref(enum(…)))` evaluate the inner `enum(…)` literal
  // with reference semantics (plans/REF_REFERENCE_SEMANTICS.md Phase 3).
  forceReferenceSemantics?: boolean;
  isAtomicRc?: boolean;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "enum", got:\n${exprToString(expr)}`,
    });
  }

  // Create enumType with empty variants
  const enumType = createEnumType(env, forceReferenceSemantics, isAtomicRc);
  addRcFunctionSignaturesToEnumType({ enumType, env, context });

  // Set the definedInModulePath for orphan rule checks.
  // Prefer the lexical token's modulePath — see struct.ts for the
  // rationale on generic-type instantiation (e.g., `Option(i32)` should
  // record `definedInModulePath = std/prelude.yo`, not the caller's file).
  const lexicalModulePath = expr.token.modulePath || context.currentModulePath;
  if (lexicalModulePath) {
    enumType.definedInModulePath = lexicalModulePath;
    enumType.trait.definedInModulePath = lexicalModulePath;
  }

  // Evaluate the variants
  const variants: EnumVariant[] = enumType.variants;

  // Track the next auto-assigned discriminant value
  let nextDiscriminant = 0n;

  for (let i = 0; i < expr.args.length; i++) {
    let enumArg: Expr = expr.args[i]!;
    let gadtReturnExpr: Expr | undefined = undefined;

    // Extract GADT return type: ... -> recur(...)
    // Case 1: Variant -> recur(Type) (no discriminant)
    if (exprIsFunctionCallOf(enumArg, "->", 2)) {
      gadtReturnExpr = (enumArg as FnCallExpr).args[1]!;
      enumArg = (enumArg as FnCallExpr).args[0]!;
    }
    // Case 2: (Variant -> recur(Type)) = discriminant
    // Parsed as: FnCallExpr("=", [FnCallExpr("->", [...]), discriminant])
    else if (
      exprIsFunctionCallOf(enumArg, "=", 2) &&
      exprIsFunctionCallOf((enumArg as FnCallExpr).args[0]!, "->", 2)
    ) {
      const outerFnCall = enumArg as FnCallExpr;
      const arrowExpr = outerFnCall.args[0]! as FnCallExpr;
      gadtReturnExpr = arrowExpr.args[1]!;
      // Reconstruct = expression without the -> wrapper
      enumArg = {
        ...outerFnCall,
        args: [arrowExpr.args[0]!, outerFnCall.args[1]!],
      };
    }

    // Check if this is a variant with discriminant: VariantName = value
    // This is different from compile-time field because the LHS is a simple atom
    if (
      exprIsFunctionCall(enumArg) &&
      exprIsFunctionCallOf(enumArg, "=", 2) &&
      exprIsAtom(enumArg.args[0]!)
    ) {
      const variantNameExpr = enumArg.args[0]!;
      const discriminantExpr = enumArg.args[1]!;

      if (!isValidVariableName(variantNameExpr)) {
        throw formatErrorMessage({
          token: variantNameExpr.token,
          errorMessage: `Expected identifier for enum variant, got:\n${exprToString(variantNameExpr)}`,
        });
      }

      const variantName = variantNameExpr.token.value;

      // Check for duplicate variant names
      if (variants.some((v) => v.name === variantName)) {
        throw formatErrorMessage({
          token: variantNameExpr.token,
          errorMessage: `Duplicate variant name "${variantName}" in enum`,
        });
      }

      // Evaluate the discriminant value - it must be a compile-time integer
      const evaluatedDiscriminant = evaluateExpression({
        expr: discriminantExpr,
        env,
        context: { ...context, SelfType: enumType },
      });

      if (!evaluatedDiscriminant.$) {
        throw formatErrorMessage({
          token: discriminantExpr.token,
          errorMessage: `Failed to evaluate discriminant value: ${exprToString(discriminantExpr)}`,
        });
      }

      env = evaluatedDiscriminant.$.env;
      const discriminantValue = evaluatedDiscriminant.$.value;
      const discriminantType = evaluatedDiscriminant.$.type;

      if (
        !isComptimeIntValue(discriminantValue) &&
        !isComptimeIntType(discriminantType)
      ) {
        throw formatErrorMessage({
          token: discriminantExpr.token,
          errorMessage: `Enum discriminant must be a compile-time integer, got: ${exprToString(discriminantExpr)}`,
        });
      }

      if (!isComptimeIntValue(discriminantValue)) {
        throw formatErrorMessage({
          token: discriminantExpr.token,
          errorMessage: `Enum discriminant must be a compile-time known value, got: ${exprToString(discriminantExpr)}`,
        });
      }

      const discriminant =
        typeof discriminantValue.value === "bigint"
          ? discriminantValue.value
          : BigInt(discriminantValue.value);

      variants.push({
        name: variantName,
        discriminant,
      });

      // Update nextDiscriminant to be one more than the current value
      nextDiscriminant = discriminant + 1n;
    }
    // comptime fields
    // eg:
    //   new :: (((lhs: Self, rhs: i32) -> i32) {})
    else if (
      exprIsFunctionCall(enumArg) &&
      (exprIsFunctionCallOf(enumArg, "::", 2) ||
        exprIsFunctionCallOf(enumArg, "?=", 2))
    ) {
      throw formatErrorMessage({
        token: enumArg.token,
        errorMessage: `Please use "impl" block to define members/methods for enum types.`,
      });
    }

    // Enum variant
    else {
      if (exprIsAtom(enumArg)) {
        const variantName = enumArg.token.value;

        if (!isValidVariableName(enumArg)) {
          throw formatErrorMessage({
            token: enumArg.token,
            errorMessage: `Expected identifier for enum variant, got:\n${exprToString(enumArg)}`,
          });
        }

        // Check for duplicate variant names
        if (variants.some((v) => v.name === variantName)) {
          throw formatErrorMessage({
            token: enumArg.token,
            errorMessage: `Duplicate variant name "${variantName}" in enum`,
          });
        }

        variants.push({
          name: variantName,
          discriminant: nextDiscriminant,
        });
        nextDiscriminant += 1n;
      } else {
        // Check for enum variant with discriminant: VariantName(fields) = value
        let variantExpr: Expr = enumArg;
        let customDiscriminant: bigint | undefined = undefined;

        if (exprIsFunctionCallOf(enumArg, "=", 2)) {
          variantExpr = enumArg.args[0]!;
          const discriminantExpr = enumArg.args[1]!;

          // Evaluate the discriminant value
          const evaluatedDiscriminant = evaluateExpression({
            expr: discriminantExpr,
            env,
            context: { ...context, SelfType: enumType },
          });

          if (!evaluatedDiscriminant.$) {
            throw formatErrorMessage({
              token: discriminantExpr.token,
              errorMessage: `Failed to evaluate discriminant value: ${exprToString(discriminantExpr)}`,
            });
          }

          env = evaluatedDiscriminant.$.env;
          const discriminantValue = evaluatedDiscriminant.$.value;

          if (!isComptimeIntValue(discriminantValue)) {
            throw formatErrorMessage({
              token: discriminantExpr.token,
              errorMessage: `Enum discriminant must be a compile-time integer, got: ${exprToString(discriminantExpr)}`,
            });
          }

          customDiscriminant =
            typeof discriminantValue.value === "bigint"
              ? discriminantValue.value
              : BigInt(discriminantValue.value);
        }

        if (exprIsFunctionCallOf(variantExpr, ":")) {
          throw formatErrorMessage({
            token: variantExpr.token,
            errorMessage: `Enum variant with : is not implemented yet`,
          });
        }
        if (
          !exprIsFunctionCall(variantExpr) ||
          !isValidVariableName(variantExpr.func)
        ) {
          throw formatErrorMessage({
            token: variantExpr.token,
            errorMessage: `Expected identifier for enum variant, got:\n${exprToString(
              variantExpr
            )}`,
          });
        }
        const variantName = variantExpr.func.token.value;

        // Check for duplicate variant names
        if (variants.some((v) => v.name === variantName)) {
          throw formatErrorMessage({
            token: variantExpr.func.token,
            errorMessage: `Duplicate variant name "${variantName}" in enum`,
          });
        }

        const fields: TypeField[] = [];
        for (let j = 0; j < variantExpr.args.length; j++) {
          const arg = variantExpr.args[j]!;
          const { field, env: nextEnv } = evaluateTypeField({
            expr: arg,
            env,
            tupleFieldIndex: j,
            context: { ...context, SelfType: enumType },
            forType: "enum",
          });

          // Check if there is duplicate labels
          const duplicateLabel = fields.find(
            (elem) => elem.label === field.label
          );
          if (duplicateLabel) {
            throw formatErrorMessage({
              token: exprIsFunctionCall(arg)
                ? (arg.args[0]?.token ?? arg.token)
                : arg.token,
              errorMessage: `Duplicate field label "${field.label}" in enum variant`,
            });
          }

          if (field.assignedValue) {
            throw formatErrorMessage({
              token:
                field.exprs.assignedValueExpr?.token ?? field.exprs.expr.token,
              errorMessage: `Enum variant field cannot have compile-time assigned value.`,
            });
          }

          fields.push(field);
          env = nextEnv;
        }

        const discriminant = customDiscriminant ?? nextDiscriminant;
        variants.push({
          name: variantName,
          fields: fields,
          discriminant,
        });
        nextDiscriminant = discriminant + 1n;
      }
    }

    // Process GADT return type for the last pushed variant
    if (gadtReturnExpr) {
      if (!exprIsFunctionCallOf(gadtReturnExpr, BuiltinKeywords.recur)) {
        throw formatErrorMessage({
          token: gadtReturnExpr.token,
          errorMessage: `Expected "recur(...)" for GADT return type, got: ${exprToString(gadtReturnExpr)}`,
        });
      }

      const gadtReturnTypeArgs: Type[] = [];
      for (const arg of (gadtReturnExpr as FnCallExpr).args) {
        const evaluated = evaluateExpression({
          expr: arg,
          env,
          context: { ...context, SelfType: enumType },
        });

        if (!evaluated.$) {
          throw formatErrorMessage({
            token: arg.token,
            errorMessage: `Failed to evaluate GADT return type argument: ${exprToString(arg)}`,
          });
        }

        if (!isTypeValue(evaluated.$.value)) {
          throw formatErrorMessage({
            token: arg.token,
            errorMessage: `GADT return type argument must be a type, got: ${exprToString(arg)}`,
          });
        }

        gadtReturnTypeArgs.push(evaluated.$.value.value);
        env = evaluated.$.env;
      }

      // Validate arg count matches the type constructor's compile-time parameters
      if (
        context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
      ) {
        const fnType = context.isEvaluatingFunctionBodyOrAsyncBlock.type;
        const comptimeParams = fnType.parameters.filter(
          (p) => p.isCompileTimeOnly
        );
        if (comptimeParams.length !== gadtReturnTypeArgs.length) {
          throw formatErrorMessage({
            token: gadtReturnExpr.token,
            errorMessage: `GADT return type has ${gadtReturnTypeArgs.length} argument(s), but the type constructor has ${comptimeParams.length} type parameter(s)`,
          });
        }
      }

      variants[variants.length - 1]!.gadtReturnTypeArgs = gadtReturnTypeArgs;
      enumType.isGadt = true;
    }
  }

  // For GADT enums, extract the type constructor arguments from the environment
  if (
    enumType.isGadt &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
  ) {
    const fnType = context.isEvaluatingFunctionBodyOrAsyncBlock.type;
    const comptimeParams = fnType.parameters.filter((p) => p.isCompileTimeOnly);
    if (comptimeParams.length > 0) {
      const typeArgs: Type[] = [];
      for (const param of comptimeParams) {
        const variables = getVariablesFromEnv(env, param.label);
        if (variables.length > 0 && variables[variables.length - 1]!.value) {
          const typeVal = variables[variables.length - 1]!.value![0];
          if (isTypeValue(typeVal)) {
            typeArgs.push(typeVal.value);
          }
        }
      }
      if (typeArgs.length === comptimeParams.length) {
        enumType.typeConstructorArgs = typeArgs;
      }
    }
  }

  // Auto-derive all applicable traits (Send, Acyclic, Comptime, Runtime)
  // and Rc functions if needed
  env = autoDeriveTraitsAndAddRcFunctionsForEnumType({
    enumType,
    env,
    context,
    errorToken: expr.token,
  });

  const enumTypeValue = createTypeValue(enumType);
  expr.$ = {
    env,
    value: enumTypeValue,
    type: enumTypeValue.type,
    pathCollection: [],
  };

  // Append more information to "enum" token.
  expr.func.$ = expr.$;
  return expr;
}
