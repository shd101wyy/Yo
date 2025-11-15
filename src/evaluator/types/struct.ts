import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createStructType, ModuleField } from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateTypeField } from "./field";
import { validateDisposeFunction } from "./validation";

export function evaluateStructType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const isObjectKeyword = exprIsFunctionCallOf(expr, BuiltinKeywords.object);
  const isStructKeyword = exprIsFunctionCallOf(expr, BuiltinKeywords.struct);
  const isNewtypeKeyword = exprIsFunctionCallOf(expr, BuiltinKeywords.newtype);

  if (!isStructKeyword && !isObjectKeyword && !isNewtypeKeyword) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "struct" or "object" or "newtype", got:\n${exprToString(expr)}`,
    });
  }

  // For 'object' keyword, always use reference semantics
  const isReferenceSemantics = isObjectKeyword;
  const isNewtype = isNewtypeKeyword;

  // Create structType with empty fields
  // This is used as the SelfType for the following evaluations.
  const structType = createStructType(env, isReferenceSemantics, isNewtype);

  // Evaluate the fields
  const fields = structType.fields;
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    {
      const { field, env: nextEnv } = evaluateTypeField({
        expr: arg,
        env,
        tupleFieldIndex: i,
        context: { ...context, SelfType: structType },
        forType: "struct",
      });

      // Check if there is duplicate labels
      const duplicateLabel = fields.find((elem) => elem.label === field.label);
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label "${field.label}" in struct`,
        });
      }

      if (field.isCompileTimeOnly && field.assignedValue) {
        // dispose function
        // Verify the disposeFunction has the correct type.
        // fn(self : Self) -> unit
        if (field.label === BuiltinFunctions.dispose[0]) {
          validateDisposeFunction(
            field as ModuleField,
            exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token
          );
        }

        structType.module.fields.push(field as ModuleField);
      } else {
        fields.push(field);
      }

      env = nextEnv;
    }
  }

  // Check if it's newtype and has only one field
  if (isNewtype && fields.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Newtype struct must have exactly one field, but got ${fields.length} fields.`,
    });
  }

  // console.log(typeToString(structType));
  const structTypeValue = createTypeValue(structType);
  expr.$ = {
    env,
    type: structTypeValue.type,
    value: structTypeValue,
    pathCollection: [],
  };

  // Append more information to "struct" token.
  expr.func.$ = expr.$;
  return expr;
}
