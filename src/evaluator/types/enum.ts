import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createEnumType, EnumVariant, ModuleElement } from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";
import { evaluateElementType } from "./element";
import { evaluateTupleElementsType } from "./tuple";

export function evaluateEnumType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "enum", got:\n${exprToString(expr)}`,
    });
  }

  // Create enumType with empty variants
  const enumType = createEnumType(env);

  // Evaluate the variants
  const variants: EnumVariant[] = enumType.variants;
  const moduleElements: ModuleElement[] = enumType.module.elements;

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

      const { type, env: nextEnv } = evaluateElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context, SelfType: enumType },
        forType: "enum",
      });

      // Check if there is duplicate labels
      const duplicateLabel = moduleElements.find(
        (element) => element.label === type.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Duplicate label "${type.label}" in enum`,
        });
      }

      // Check if it duplicates with the existing variant names
      if (variants.some((v) => v.name === type.label)) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Duplicate label "${type.label}" in enum variants`,
        });
      }

      if (!type.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only field, got:\n${exprToString(
            type.exprs.expr
          )}`,
        });
      }

      // Disallow to have the default value for enum type fields.
      if (type.defaultValue) {
        throw formatErrorMessage({
          token: type.exprs.defaultValueExpr?.token ?? type.exprs.expr.token,
          errorMessage: `Enum type cannot have default value for its elements.`,
        });
      }

      moduleElements.push(type as ModuleElement);
      env = nextEnv;
    }

    // Enum variant
    else {
      if (exprIsAtom(enumArg)) {
        const variantName = enumArg.token.value;
        if (!isValidVariableName(enumArg)) {
          throw formatErrorMessage({
            token: enumArg.token,
            errorMessage: `Expected identifier for enum variant, got:\n${exprToString(
              enumArg
            )}`,
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

        const { type: tupleType, env: nextEnv } = evaluateTupleElementsType({
          args: enumArg.args,
          env,
          context: {
            ...context,
            SelfType: enumType,
          },
          forType: "enum",
        });
        env = nextEnv;

        // We disallow to have isCompileTimeOnly for enum variant elements.
        // Because enum variant fields cannot be marked as compile-time only.
        for (let i = 0; i < tupleType.elements.length; i++) {
          const element = tupleType.elements[i]!;
          // QUESTION: Should we allow compile-time only field in enum variant?
          // If yes, should we require it to have assignedValue?
          if (element.isCompileTimeOnly) {
            throw formatErrorMessage({
              token: element.exprs.expr.token,
              errorMessage: `Enum variant element cannot be compile-time only, got:\n${exprToString(
                element.exprs.expr
              )}`,
            });
          }
        }

        variants.push({
          name: variantName,
          elements: tupleType.elements,
        });
      }
    }
  }

  const enumTypeValue = createTypeValue(enumType);
  expr.$ = {
    env,
    value: enumTypeValue,
    type: enumTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "enum" token.
  expr.func.$ = expr.$;
  return expr;
}
