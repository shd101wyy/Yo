import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import { Type } from "../../types/definitions";
import {
  isEnumType,
  isModuleType,
  isStructType,
  isTraitType,
  isTupleType,
  isUnionType,
} from "../../types/guards";
import { typeOfType } from "../../types/hierarchy";
import { typeToString } from "../../types/utils";
import { createTypeValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";
import { synthesizeTypes } from "./synthesizer";

/**
 * Synthesize the expression and type, such as:
 * - (p: Point) := _(3, 4);   // here _ becomes Point
 * - (p: Color) := .Red;      // here (.) becomes (Color.)
 * - (p: Shape) := .Circle(3) // here (.) becomes (Shape.)
 * - (c: Complex) := (_(3, true),) // here (_) becomes struct in tuple
 */
export function synthesizeExprAndType({
  expr,
  type,
  env,
  context,
}: {
  expr: Expr;
  type: Type;
  env: Environment;
  context: EvaluatorContext;
}): { expr: Expr; type: Type; env: Environment } {
  // Handle tuples (including tuples with placeholders)
  if (
    isTupleType(type) &&
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)
  ) {
    if (type.fields.length !== expr.args.length) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Tuple size mismatch: expected ${type.fields.length} fields, got ${expr.args.length}`,
      });
    }

    // Recursively synthesize each tuple field
    for (let i = 0; i < type.fields.length; i++) {
      const fieldType = type.fields[i]!.type;
      const fieldExpr = expr.args[i]!;

      const {
        // expr: synthesizedExpr,
        // type: synthesizedType,
        env: nextEnv,
      } = synthesizeExprAndType({
        expr: fieldExpr,
        type: fieldType,
        env,
        context: { ...context },
      });

      env = nextEnv;
    }

    // The entire tuple is now synthesized
    expr.$ = {
      env,
      type,
      pathCollection: [],
    };
    return { expr, type, env };
  }
  // Handle the _ case
  else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "_")) {
    // Check if type is a struct type
    if (
      isStructType(type) ||
      isUnionType(type) ||
      isModuleType(type) ||
      isTraitType(type)
    ) {
      const funcCallExpr = evaluateFunctionCall({
        expr,
        env,
        givenFunc: {
          type: typeOfType(type),
          value: createTypeValue(type),
        },
        context: { ...context },
      });

      if (!funcCallExpr.$?.type || !funcCallExpr.$?.env) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to evaluate expr and type for struct:\n${exprToString(expr)}`,
        });
      }

      // Attach information to the "_"
      // expr.func.value = createTypeValue(type);
      // expr.func.type = typeOfType(type);

      return {
        expr: funcCallExpr,
        type: funcCallExpr.$?.type,
        env: funcCallExpr.$?.env,
      };
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot use _ with type ${typeToString(
          type
        )}. Only supported with struct types.`,
      });
    }
  }
  // Handle the . case for enum variant
  else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ".", 1)) {
    // Check if type is an enum type
    if (isEnumType(type)) {
      const variantNameExpr = expr.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(
            variantNameExpr
          )}`,
        });
      }
      const variantName = variantNameExpr.token.value;
      const variant = type.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(type)}`,
        });
      }

      const newEnumType = { ...type, selectedVariantName: variantName };
      expr.$ = {
        type: newEnumType,
        env,
        pathCollection: [],
      };
      // TODO: comptime value

      return {
        expr: expr,
        type: newEnumType,
        env: env,
      };
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot use . with type ${typeToString(
          type
        )}. Only supported with enum types.`,
      });
    }
  }
  // Handle the . case for enum variant call
  else if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCall(expr.func) &&
    exprIsFunctionCallOf(expr.func, ".", 1)
  ) {
    if (isEnumType(type)) {
      const variantExpr = expr.func;
      const variantNameExpr = variantExpr.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: variantExpr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(
            variantNameExpr
          )}`,
        });
      }

      const variantName = variantNameExpr.token.value;
      const variant = type.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(type)}`,
        });
      }

      const newEnumType = { ...type, selectedVariantName: variantName };
      const funcCallExpr = evaluateFunctionCall({
        expr,
        env,
        givenFunc: {
          type: typeOfType(newEnumType),
          value: createTypeValue(newEnumType),
        },
        context: { ...context },
      });
      if (!funcCallExpr.$?.type || !funcCallExpr.$?.env) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to evaluate expr and type for enum variant:\n${exprToString(expr)}`,
        });
      }

      return {
        expr: funcCallExpr,
        type: funcCallExpr.$?.type,
        env: funcCallExpr.$?.env,
      };
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot use . with type ${typeToString(
          type
        )}. Only supported with enum types.`,
      });
    }
  }
  // If both expr and type are already set, but there might be unknown values to resolve
  else if (expr.$?.type && type) {
    try {
      // Try to synthesize the types to resolve unknown values
      const { expectedEnv } = synthesizeTypes(
        { type: type, env },
        { type: expr.$.type, env }
      );

      return {
        expr,
        type: type, // Return the expected type (which may have been updated)
        env: expectedEnv,
      };
    } catch (synthesisError) {
      // If synthesis fails, fall back to original behavior
      return {
        expr,
        type: expr.$?.type, // NOTE: Here we should return the type of expr, not `type`
        env,
      };
    }
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Failed to synthesize the type and expr: ${exprToString(expr)}`,
    });
  }
}
