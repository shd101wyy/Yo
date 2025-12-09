import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createUnionType, ModuleField, TypeField } from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateTypeField } from "./field";
import { autoDeriveSendForUnionType } from "./utils";

export function evaluateUnionType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "union", got:\n${exprToString(expr)}`,
    });
  }

  // Create unionType with empty fields
  const unionType = createUnionType(env);

  const fields: TypeField[] = [];
  unionType.fields = fields;

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const { field, env: nextEnv } = evaluateTypeField({
      expr: arg,
      env,
      tupleFieldIndex: i,
      context: { ...context, SelfType: unionType },
      forType: "union",
    });

    // Check if there is duplicate labels
    const duplicateLabel = fields.find((elem) => elem.label === field.label);
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Duplicate label "${field.label}" in union field.`,
      });
    }

    // Disallow to have the default value for union type fields.
    if (field.defaultValue) {
      throw formatErrorMessage({
        token: field.exprs.defaultValueExpr?.token ?? field.exprs.expr.token,
        errorMessage: `Union type cannot have default value for its fields.`,
      });
    }

    if (field.isCompileTimeOnly) {
      if (!field.assignedValue) {
        throw formatErrorMessage({
          token: field.exprs.expr.token,
          errorMessage: `Module field in union type must have assigned value.`,
        });
      }

      unionType.module.fields.push(field as ModuleField);
    } else {
      fields.push(field);
    }
    env = nextEnv;
  }

  // Auto-derive Send module if applicable
  env = autoDeriveSendForUnionType({
    unionType,
    env,
    context,
  });

  const unionTypeValue = createTypeValue(unionType);
  expr.$ = {
    env,
    value: unionTypeValue,
    type: unionTypeValue.type,
    pathCollection: [],
  };

  // Append more information to "union" token.
  expr.func.$ = expr.$;
  return expr;
}
