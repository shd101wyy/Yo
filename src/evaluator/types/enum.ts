import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  createEnumType,
  EnumVariant,
  ModuleField,
  TraitField,
  TypeField,
} from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";
import { evaluateTypeField } from "./field";
import {
  addRcFunctionSignaturesToEnumType,
  addRcFunctionsToEnumType,
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

  for (let i = 0; i < expr.args.length; i++) {
    const enumArg = expr.args[i]!;

    // comptime fields
    // eg:
    //   ~~Self.new = (((lhs: Self, rhs: i32) -> i32) {})~~
    //   new :: (((lhs: Self, rhs: i32) -> i32) {})
    if (
      exprIsFunctionCall(enumArg) &&
      (exprIsFunctionCallOf(enumArg, "::", 2) ||
        exprIsFunctionCallOf(enumArg, "=", 2) ||
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
        variants.push({
          name: variantName,
        });

        // TODO: Check duplicates
      } else {
        if (exprIsFunctionCallOf(enumArg, ":")) {
          throw formatErrorMessage({
            token: enumArg.token,
            errorMessage: `Enum variant with : is not implemented yet`,
          });
        }
        if (!isValidVariableName(enumArg.func)) {
          throw formatErrorMessage({
            token: enumArg.func.token,
            errorMessage: `Expected identifier for enum variant, got:\n${exprToString(
              enumArg.func
            )}`,
          });
        }
        const variantName = enumArg.func.token.value;
        const fields: TypeField[] = [];
        for (let i = 0; i < enumArg.args.length; i++) {
          const arg = enumArg.args[i]!;
          const { field, env: nextEnv } = evaluateTypeField({
            expr: arg,
            env,
            tupleFieldIndex: i,
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

        variants.push({
          name: variantName,
          fields: fields,
        });
      }
    }
  }

  // Auto derive Send module
  env = autoDeriveSendForEnumType({
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
