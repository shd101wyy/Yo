import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  createEnumType,
  EnumVariant,
  isComptimeIntType,
  ModuleField,
  TraitField,
  TypeField,
  updateTypeAvailability,
} from "../../types";
import { createTypeValue, isComptimeIntValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";
import { evaluateTypeField } from "./field";
import {
  addRcFunctionSignaturesToEnumType,
  addRcFunctionsToEnumType,
  autoDeriveAcyclicForEnumType,
  autoDeriveComptimeForEnumType,
  autoDeriveRuntimeForEnumType,
  autoDeriveSendForEnumType,
} from "./utils";

export function evaluateEnumType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "enum", got:\n${exprToString(expr)}`,
    });
  }

  // Create enumType with empty variants
  const enumType = createEnumType(env);
  addRcFunctionSignaturesToEnumType({ enumType, env, context });

  // Set the definedInModulePath for orphan rule checks
  if (context.currentModulePath) {
    enumType.definedInModulePath = context.currentModulePath;
    enumType.trait.definedInModulePath = context.currentModulePath;
  }

  // Evaluate the variants
  const variants: EnumVariant[] = enumType.variants;
  const traitFields: TraitField[] = enumType.trait.fields;

  // Track the next auto-assigned discriminant value
  let nextDiscriminant = 0n;

  for (let i = 0; i < expr.args.length; i++) {
    const enumArg = expr.args[i]!;

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
      updateTypeAvailability(enumType, enumArg.token);

      // Update nextDiscriminant to be one more than the current value
      nextDiscriminant = discriminant + 1n;
    }
    // comptime fields
    // eg:
    //   ~~Self.new = (((lhs: Self, rhs: i32) -> i32) {})~~
    //   new :: (((lhs: Self, rhs: i32) -> i32) {})
    else if (
      exprIsFunctionCall(enumArg) &&
      (exprIsFunctionCallOf(enumArg, "::", 2) ||
        exprIsFunctionCallOf(enumArg, "?=", 2))
    ) {
      const arg = enumArg;

      const { field, env: nextEnv } = evaluateTypeField({
        expr: arg,
        env,
        tupleFieldIndex: i,
        context: { ...context, SelfType: enumType },
        forType: "enum",
      });

      // Check if there is duplicate labels
      const duplicateLabel = traitFields.find(
        (elem) => elem.label === field.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Duplicate label "${field.label}" in enum`,
        });
      }

      // Check if it duplicates with the existing variant names
      if (variants.some((v) => v.name === field.label)) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Duplicate label "${field.label}" in enum variants`,
        });
      }

      if (!field.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only field, got:\n${exprToString(field.exprs.expr)}`,
        });
      }

      // Enum module field cannot have default value.
      if (field.defaultValue) {
        throw formatErrorMessage({
          token: field.exprs.defaultValueExpr?.token ?? field.exprs.expr.token,
          errorMessage: `Enum module field cannot have default value.`,
        });
      }

      // Enum module field must have assigned value.
      if (!field.assignedValue) {
        throw formatErrorMessage({
          token: field.exprs.assignedValueExpr?.token ?? field.exprs.expr.token,
          errorMessage: `Enum module field must have assigned value.`,
        });
      }

      // ___drop function
      // if (type.label === BuiltinFunctions.___drop[0]) {
      //   throw formatErrorMessage({
      //     token: arg.token,
      //     errorMessage: `The label "${BuiltinFunctions.___drop[0]}()" is reserved for the auto-generated drop function. You cannot define it as a compile-time-only element.`,
      //   });
      // }

      // dispose function
      // Verify the disposeFunction has the correct type.
      // fn(self : Self) -> unit
      // if (type.label === BuiltinFunctions.dispose[0]) {
      //   validateDisposeFunction(type as ModuleField, arg.token);
      // }
      traitFields.push(field as ModuleField);
      env = nextEnv;
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
        updateTypeAvailability(enumType, enumArg.token);
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
        updateTypeAvailability(enumType, variantExpr.token);
        nextDiscriminant = discriminant + 1n;
      }
    }
  }

  // Auto derive Send module
  env = autoDeriveSendForEnumType({
    enumType,
    env,
    context,
  });

  // Auto derive Acyclic trait
  env = autoDeriveAcyclicForEnumType({
    enumType,
    env,
    context,
  });

  // Auto derive Comptime trait
  env = autoDeriveComptimeForEnumType({
    enumType,
    env,
    context,
  });

  // Auto derive Runtime trait
  env = autoDeriveRuntimeForEnumType({
    enumType,
    env,
    context,
  });

  // Auto-generate ARC functions using the systematic approach
  env = addRcFunctionsToEnumType({
    enumType,
    env,
    context,
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
